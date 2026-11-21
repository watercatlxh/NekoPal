import { type AgentSessionEvent, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramAdapter } from "../src/channel/telegram/adapter.ts";
import { TelegramApi, TelegramError } from "../src/channel/telegram/api.ts";
import {
	type Adapter,
	type ChannelStream,
	type ReplyFormat,
	type SentHandle,
	ToolCallRejected,
} from "../src/channel/types.ts";
import { type ChatController, ReplyController } from "../src/chat/reply.ts";

/** A channel stream that records what it was given. */
class FakeStream implements ChannelStream {
	readonly updates: string[] = [];
	finished: string | undefined;
	aborted = false;

	async update(text: string): Promise<void> {
		this.updates.push(text);
	}

	async finish(text: string): Promise<SentHandle | undefined> {
		this.finished = text;
		return { id: "stream" };
	}

	abort(): void {
		this.aborted = true;
	}
}

/** One message the controller sent or edited. */
interface Shown {
	readonly id: string;
	readonly markdown: string;
	readonly method: "tool" | "rich" | "markdown" | "plainEdit";
	readonly toolName?: string;
	/** True for the call that created the message. */
	readonly created: boolean;
}

/** Records the calls the reply controller makes on a chat. */
class RecordingChat implements ChatController {
	readonly shown: Shown[] = [];
	readonly streams: FakeStream[] = [];
	readonly deleted: string[] = [];
	readonly adapter: Adapter;
	readonly chatId = "42";
	replyTo = "7";
	lang: "en" | "zh" = "en";
	telegramReplyFormat?: ReplyFormat;
	/** False explicitly declines the final edit; exceptions model ambiguous delivery instead. */
	editFits = true;
	private nextId = 1;

	constructor(channel: "telegram" | "qq" = "telegram", stream = channel === "qq") {
		const record = (
			method: Shown["method"],
			markdown: string,
			handle?: SentHandle,
			toolName?: string,
		): SentHandle => {
			const id = handle?.id ?? String(this.nextId++);
			this.shown.push({ id, markdown, method, toolName, created: !handle });
			return { id };
		};
		const editable = channel === "telegram";
		this.adapter = {
			name: channel,
			caps: { edit: editable, stream, rich: editable, maxChars: 4_096 },
			async start() {},
			async stop() {},
			sendMarkdown: async (_chatId, markdown) => [record("markdown", markdown)],
			sendRich: async (_chatId, markdown) => record("rich", markdown),
			editMarkdown: async (_chatId, handle, markdown) => {
				if (!this.editFits) return false;
				record("markdown", markdown, handle);
				return true;
			},
			editRich: async (_chatId, handle, markdown) => {
				if (!this.editFits) return false;
				record("rich", markdown, handle);
				return true;
			},
			editText: async (_chatId, handle, text) => {
				record("plainEdit", text, handle);
			},
			sendToolCall: editable
				? async (_chatId, name, details) => record("tool", details, undefined, name)
				: undefined,
			editToolCall: editable
				? async (_chatId, handle, name, details) => {
						record("tool", details, handle, name);
						return true;
					}
				: undefined,
			deleteMessage: async (_chatId, handle) => {
				this.deleted.push(handle.id);
			},
			async editMarkup() {},
			async sendFiles() {},
			openStream: () => {
				if (!stream) return undefined;
				const output = new FakeStream();
				this.streams.push(output);
				return output;
			},
			async notifyWorking() {},
		};
	}

	/** The messages this chat created, in order. */
	created(): Shown[] {
		return this.shown.filter((entry) => entry.created);
	}

	/** The newest state of every message, keyed by id. */
	latest(): Map<string, string> {
		const map = new Map<string, string>();
		for (const entry of this.shown) map.set(entry.id, entry.markdown);
		return map;
	}
}

function toolStart(id: string, name: string, args: unknown): AgentSessionEvent {
	return { type: "tool_execution_start", toolCallId: id, toolName: name, args } as AgentSessionEvent;
}

function toolEnd(id: string, name: string, result?: unknown, isError = false): AgentSessionEvent {
	return { type: "tool_execution_end", toolCallId: id, toolName: name, result, isError } as AgentSessionEvent;
}

/** A tool result carrying `text`, the shape the agent loop emits. */
function toolResult(text: string): unknown {
	return { content: [{ type: "text", text }], details: undefined };
}

function delta(text: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: { type: "text_delta", delta: text },
	} as unknown as AgentSessionEvent;
}

function assistantText(text: string, stopReason: "stop" | "aborted" | "error" = "stop"): AgentSessionEvent {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage: "oops" },
	} as unknown as AgentSessionEvent;
}

const formats = [
	{ format: "rich", method: "rich", send: "sendRich", edit: "editRich" },
	{ format: "mdv2", method: "markdown", send: "sendMarkdown", edit: "editMarkdown" },
] as const;

/** Hold an adapter request in flight, not just its scheduled timeout. */
function delayed<A extends unknown[], R>(deliver: (...args: A) => Promise<R>, gate: Promise<void>) {
	return vi.fn(async (...args: A) => {
		await gate;
		return deliver(...args);
	});
}

describe("ReplyController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const start: AgentSessionEvent = { type: "agent_start" };
	const settled: AgentSessionEvent = { type: "agent_settled", aborted: false };

	async function begin(chat: RecordingChat): Promise<ReplyController> {
		const controller = new ReplyController(chat);
		await controller.onEvent(start);
		return controller;
	}

	/** Submit a burst the way the real subscription does, without waiting for network delivery. */
	async function burst(controller: ReplyController, events: AgentSessionEvent[]): Promise<void> {
		await Promise.all(events.map((event) => controller.onEvent(event)));
	}

	it("waits for a pending tool handle, then edits that card before the reply and later tool", async () => {
		const chat = new RecordingChat();
		const send = chat.adapter.sendToolCall!;
		const gate = Promise.withResolvers<void>();
		chat.adapter.sendToolCall = vi.fn(send).mockImplementationOnce(async (...args) => {
			await gate.promise;
			return send(...args);
		});
		const controller = await begin(chat);
		const delivery = burst(controller, [
			toolStart("1", "r<&", { path: "a&b" }),
			toolEnd("1", "r<&", toolResult("x</blockquote>")),
			assistantText("First answer"),
			toolStart("2", "read", {}),
			toolEnd("2", "read", toolResult("done")),
			assistantText("Second answer"),
			settled,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(chat.adapter.sendToolCall).toHaveBeenCalledTimes(1);
		expect(chat.shown).toEqual([]);
		gate.resolve();
		await delivery;
		expect(chat.shown.map(({ method, toolName, id, markdown }) => [method, toolName, id, markdown])).toEqual([
			["tool", "r<&", "1", "path: a&b"],
			["tool", "r<&", "1", "path: a&b\n\nx</blockquote>"],
			["rich", undefined, "2", "First answer"],
			["tool", "read", "3", "…"],
			["tool", "read", "3", "done"],
			["rich", undefined, "4", "Second answer"],
		]);
	});

	it("edits concurrent top-level calls by id and ignores nested calls", async () => {
		const chat = new RecordingChat();
		const nested = (event: AgentSessionEvent) => ({ ...event, parentToolCallId: "a" }) as AgentSessionEvent;
		await burst(await begin(chat), [
			toolStart("a", "read", { path: "a" }),
			toolStart("b", "read", { path: "b" }),
			nested(toolStart("sub", "internal", {})),
			nested(toolEnd("a", "internal", toolResult("nested"))),
			toolEnd("b", "read", toolResult("B")),
			toolEnd("a", "read", toolResult("A")),
			settled,
		]);
		expect([...chat.latest()]).toEqual([
			["1", "path: a\n\nA"],
			["2", "path: b\n\nB"],
		]);
		expect(chat.shown).toHaveLength(4);
	});

	it.each([
		["en", "Failed"],
		["zh", "失败"],
	] as const)("keeps %s failure on the first detail line within the raw budget", async (lang, failure) => {
		const chat = new RecordingChat();
		chat.lang = lang;
		await burst(await begin(chat), [
			toolStart("1", "read", {}),
			toolEnd("1", "read", toolResult("🔥".repeat(2_000)), true),
			settled,
		]);
		const final = chat.shown[1];
		expect(final.toolName).toBe("read");
		expect(final.markdown.startsWith(`${failure}\n🔥`)).toBe(true);
		expect(final.markdown.endsWith("🔥…")).toBe(true);
		expect(final.markdown.length).toBeLessThanOrEqual(1_500);
	});

	it.each(["rejected", "not editable", "send timeout", "edit timeout"] as const)(
		"handles %s without duplicate tool retries",
		async (failure) => {
			const chat = new RecordingChat();
			const send = vi.fn(chat.adapter.sendToolCall!);
			const edit = vi.fn(chat.adapter.editToolCall!);
			chat.adapter.sendToolCall = send;
			chat.adapter.editToolCall = edit;
			if (failure === "rejected") send.mockRejectedValueOnce(new ToolCallRejected("invalid"));
			if (failure === "not editable") edit.mockResolvedValueOnce(false);
			if (failure === "send timeout") send.mockRejectedValueOnce(new Error("timeout"));
			if (failure === "edit timeout") edit.mockRejectedValueOnce(new Error("timeout"));
			const end = toolEnd("1", "read", toolResult("result"));
			await burst(await begin(chat), [toolStart("1", "read", {}), end, end, assistantText("answer"), settled]);
			const replace = failure === "rejected" || failure === "not editable";
			expect(send).toHaveBeenCalledTimes(replace ? 2 : 1);
			expect(edit).toHaveBeenCalledTimes(failure === "not editable" || failure === "edit timeout" ? 1 : 0);
			if (replace) expect(send).toHaveBeenLastCalledWith("42", "read", "result");
			expect(chat.shown.at(-1)?.markdown).toBe("answer");
			expect(chat.deleted).toEqual([]);
		},
	);

	it("cancels a queued but unsent preview as soon as the final arrives", async () => {
		const chat = new RecordingChat();
		const gate = Promise.withResolvers<SentHandle>();
		chat.adapter.sendToolCall = () => gate.promise;
		const controller = await begin(chat);
		const tool = controller.onEvent(toolStart("1", "read", {}));
		await controller.onEvent(delta("preview"));
		await vi.advanceTimersByTimeAsync(400);
		const final = burst(controller, [assistantText("final"), settled]);
		gate.resolve({ id: "tool" });
		await Promise.all([tool, final]);
		expect(chat.shown.map(({ markdown }) => markdown)).toEqual(["final"]);
	});

	it.each(formats)(
		"waits for the in-flight $format preview when final and settled arrive together",
		async ({ format, method, send }) => {
			const chat = new RecordingChat();
			chat.telegramReplyFormat = format;
			const first = Promise.withResolvers<void>();
			chat.adapter.sendRich = delayed(chat.adapter.sendRich, first.promise);
			chat.adapter.sendMarkdown = delayed(chat.adapter.sendMarkdown, first.promise);
			const controller = await begin(chat);
			await controller.onEvent(delta("A"));
			await vi.advanceTimersByTimeAsync(400);
			expect(chat.adapter[send]).toHaveBeenCalledTimes(1);
			const final = burst(controller, [delta("B"), assistantText("AB"), settled]);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(chat.shown).toEqual([]);
			first.resolve();
			await final;
			expect(chat.shown.map((e) => [e.id, e.method, e.markdown])).toEqual([
				["1", method, "A"],
				["1", method, "AB"],
			]);
			expect(chat.deleted).toEqual([]);
		},
	);

	it.each(formats)(
		"finishes an in-flight $format edit without using the next run's format or handle",
		async ({ format, method, edit }) => {
			const chat = new RecordingChat();
			chat.telegramReplyFormat = format;
			const controller = await begin(chat);
			await controller.onEvent(delta("A"));
			await vi.advanceTimersByTimeAsync(400);
			const gate = Promise.withResolvers<void>();
			chat.adapter.editRich = delayed(chat.adapter.editRich, gate.promise);
			chat.adapter.editMarkdown = delayed(chat.adapter.editMarkdown!, gate.promise);
			await controller.onEvent(delta("B"));
			await vi.advanceTimersByTimeAsync(1_500);
			expect(chat.adapter[edit]).toHaveBeenCalledTimes(1);
			chat.telegramReplyFormat = format === "rich" ? "mdv2" : "rich";
			const oldRun = burst(controller, [delta("C"), assistantText("ABC"), settled]);
			chat.replyTo = "8";
			await controller.onEvent(start);
			await controller.onEvent(assistantText("new run"));
			gate.resolve();
			await oldRun;
			await controller.onEvent(settled);
			expect([...chat.latest()]).toEqual([
				["1", "ABC"],
				["2", "new run"],
			]);
			expect(chat.shown.filter(({ id }) => id === "1").map((e) => [e.method, e.markdown])).toEqual([
				[method, "A"],
				[method, "AB"],
				[method, "ABC"],
			]);
			expect(chat.shown.find(({ id }) => id === "2")?.method).toBe(format === "rich" ? "markdown" : "rich");
			expect(chat.created()).toHaveLength(2);
			expect(chat.deleted).toEqual([]);
		},
	);

	it.each(formats)(
		"delays each $format preview, skips fast previews and does not repeat identical final text",
		async ({ format, method }) => {
			const chat = new RecordingChat();
			chat.telegramReplyFormat = format;
			const controller = await begin(chat);
			await controller.onEvent(delta(" "));
			await vi.advanceTimersByTimeAsync(3_000);
			await controller.onEvent(delta("A"));
			await vi.advanceTimersByTimeAsync(399);
			expect(chat.shown).toEqual([]);
			await controller.onEvent(assistantText(" A"));
			await controller.onEvent(delta("B"));
			await vi.advanceTimersByTimeAsync(399);
			expect(chat.shown.map(({ markdown }) => markdown)).toEqual([" A"]);
			await vi.advanceTimersByTimeAsync(1);
			await controller.onEvent(delta("C"));
			await controller.onEvent(delta("D"));
			await vi.advanceTimersByTimeAsync(1_499);
			expect(chat.shown.map(({ markdown }) => markdown)).toEqual([" A", "B"]);
			await vi.advanceTimersByTimeAsync(1);
			await burst(controller, [assistantText("BCD"), settled]);
			expect(chat.shown.map(({ method, markdown, id }) => [method, markdown, id])).toEqual([
				[method, " A", "1"],
				[method, "B", "2"],
				[method, "BCD", "2"],
			]);
		},
	);

	it.each(formats)(
		"bounds a $format preview and replaces it only on explicit refusal",
		async ({ format, method, edit }) => {
			const chat = new RecordingChat();
			chat.telegramReplyFormat = format;
			const editing = vi.spyOn(chat.adapter, edit);
			chat.editFits = false;
			const controller = await begin(chat);
			const prefix = "a".repeat(3_499);
			const long = `${prefix}🔥${"b".repeat(32_000)}`;
			await controller.onEvent(delta(long));
			await vi.advanceTimersByTimeAsync(400);
			await controller.onEvent(delta("!"));
			await vi.advanceTimersByTimeAsync(1_500);
			await burst(controller, [assistantText(`${long}!`), settled]);
			expect(editing).toHaveBeenCalledTimes(1); // Repeated deltas beyond the cut did not edit the preview.
			expect(editing).toHaveBeenCalledWith("42", { id: "1" }, `${long}!`);
			expect(chat.shown.map(({ method, markdown }) => [method, markdown])).toEqual([
				[method, prefix],
				["markdown", `${long}!`],
			]);
			expect(chat.deleted).toEqual(["1"]);
		},
	);

	it.each(formats)("deletes the $format text preview when message_end has no text", async ({ format, method }) => {
		const chat = new RecordingChat();
		chat.telegramReplyFormat = format;
		const controller = await begin(chat);
		await controller.onEvent(delta("partial"));
		await vi.advanceTimersByTimeAsync(400);
		await burst(controller, [assistantText(""), assistantText("next"), settled]);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(chat.shown.map((e) => [e.id, e.method, e.markdown])).toEqual([
			["1", method, "partial"],
			["2", method, "next"],
		]);
		expect(chat.deleted).toEqual(["1"]);
	});

	it.each(["send", "edit", "replace"] as const)(
		"does not destructively recover from ambiguous %s failures",
		async (stage) => {
			const chat = new RecordingChat();
			const send = vi.spyOn(chat.adapter, "sendRich");
			const edit = vi.spyOn(chat.adapter, "editRich");
			const split = vi.spyOn(chat.adapter, "sendMarkdown");
			if (stage === "send") send.mockRejectedValueOnce(new Error("timeout"));
			if (stage === "edit") edit.mockRejectedValueOnce(new Error("timeout"));
			if (stage === "replace") {
				edit.mockResolvedValueOnce(false);
				split.mockRejectedValueOnce(new Error("timeout"));
			}
			const controller = await begin(chat);
			await controller.onEvent(delta("A"));
			await vi.advanceTimersByTimeAsync(400);
			await burst(controller, [assistantText("AB"), assistantText("next"), settled]);
			expect(send).toHaveBeenCalledTimes(2); // A and the independent next message
			expect(edit).toHaveBeenCalledTimes(stage === "send" ? 0 : 1);
			expect(split).toHaveBeenCalledTimes(stage === "replace" ? 1 : 0);
			expect(chat.shown.at(-1)?.markdown).toBe("next");
			expect(chat.deleted).toEqual([]);
		},
	);

	it("keeps typing and accepts tools after message_end, but not after settle", async () => {
		const chat = new RecordingChat();
		const typing = vi.spyOn(chat.adapter, "notifyWorking");
		const controller = await begin(chat);
		await controller.onEvent(assistantText("part one"));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(typing).toHaveBeenCalledTimes(2);
		await burst(controller, [toolStart("1", "read", {}), settled, toolStart("2", "late", {}), delta("late")]);
		await vi.advanceTimersByTimeAsync(6_000);
		expect(typing).toHaveBeenCalledTimes(2);
		expect(chat.created().map(({ markdown }) => markdown)).toEqual(["part one", "…"]);
	});

	it.each(["aborted", "error"] as const)(
		"stops typing and tools on %s and edits the preview as plain text",
		async (reason) => {
			const chat = new RecordingChat();
			const typing = vi.spyOn(chat.adapter, "notifyWorking");
			const controller = await begin(chat);
			await controller.onEvent(delta("partial"));
			await vi.advanceTimersByTimeAsync(400);
			await burst(controller, [assistantText("", reason), toolStart("late", "read", {}), delta("late"), settled]);
			await vi.advanceTimersByTimeAsync(6_000);
			expect(typing).toHaveBeenCalledTimes(1);
			expect(chat.shown).toHaveLength(2);
			expect(chat.shown[1]).toMatchObject({ method: "plainEdit", created: false, id: "1" });
			expect(chat.shown[1].markdown).toContain(reason === "aborted" ? "Stopped" : "oops");
		},
	);

	it.each([true, false])("sends one fast QQ summary before final delivery (stream: %s)", async (stream) => {
		const chat = new RecordingChat("qq", stream);
		const controller = await begin(chat);
		const events: AgentSessionEvent[] = [];
		for (const id of ["1", "2", "3", "4"]) {
			events.push(
				toolStart(id, "read", { path: `path ${id}` }),
				toolEnd(id, "read", toolResult("hidden"), id === "2"),
			);
		}
		await burst(controller, [assistantText(""), ...events, assistantText("first"), assistantText("second"), settled]);
		await vi.advanceTimersByTimeAsync(1_000);
		const summary = "🔧 4 tools\n✓ read · path 1\n✗ read · path 2\n✓ read · path 3\n… +1";
		expect(chat.shown.map(({ markdown }) => markdown)).toEqual(stream ? [summary] : [summary, "first", "second"]);
		expect(chat.streams.map(({ finished }) => finished)).toEqual(stream ? ["first", "second"] : []);
	});

	it("delivers the QQ summary and answer when the native stream has no slot", async () => {
		const chat = new RecordingChat("qq");
		chat.telegramReplyFormat = "mdv2";
		chat.adapter.openStream = () => undefined;
		await burst(await begin(chat), [
			toolStart("a", "read", {}),
			toolEnd("a", "read"),
			assistantText("reply"),
			settled,
		]);
		expect(chat.shown.map(({ markdown }) => markdown)).toEqual(["🔧 1 tools\n✓ read", "reply"]);
	});

	it("shows the QQ summary during a slow run and does not repeat it at finish", async () => {
		const chat = new RecordingChat("qq");
		chat.telegramReplyFormat = "mdv2";
		const controller = await begin(chat);
		await burst(controller, [toolStart("a", "bash", { command: "ls" }), toolEnd("a", "bash")]);
		await vi.advanceTimersByTimeAsync(400);
		expect(chat.created().map(({ markdown }) => markdown)).toEqual(["🔧 1 tools\n✓ bash · ls"]);
		await controller.onEvent(delta("Q"));
		await vi.advanceTimersByTimeAsync(400);
		await burst(controller, [toolStart("b", "read", {}), toolEnd("b", "read"), assistantText("QQ"), settled]);
		expect(chat.streams[0].updates).toEqual(["Q"]);
		expect(chat.streams[0].finished).toBe("QQ");
		expect(chat.created()).toHaveLength(1);
	});
});

it("edits 3500 visible dots in place and permits replacement on a definitive Telegram length refusal", async () => {
	const adapter = createTelegramAdapter({
		settingsManager: SettingsManager.inMemory({ nekopal: { channels: { telegram: { botToken: "test-only" } } } }),
		log: vi.fn(),
		logError: vi.fn(),
	});
	const tooLong = new TelegramError(400, "Bad Request: message is too long");
	const call = vi
		.spyOn(TelegramApi.prototype, "call")
		.mockResolvedValueOnce(true)
		.mockRejectedValueOnce(tooLong)
		.mockRejectedValueOnce(new TelegramError(400, "Bad Request: can't parse entities"))
		.mockRejectedValueOnce(tooLong);
	try {
		const dots = ".".repeat(3_500);
		const handle = { id: "7" };
		expect(await adapter.editMarkdown!("42", handle, dots)).toBe(true);
		expect(call).toHaveBeenNthCalledWith(1, "editMessageText", {
			chat_id: "42",
			message_id: 7,
			parse_mode: "MarkdownV2",
			text: "\\.".repeat(3_500),
		});
		const final = "a".repeat(4_097);
		expect(await adapter.editMarkdown!("42", handle, final)).toBe(false);
		expect(await adapter.editMarkdown!("42", handle, final)).toBe(false);
		expect(call).toHaveBeenCalledTimes(4);
		expect(call).toHaveBeenLastCalledWith("editMessageText", { chat_id: "42", message_id: 7, text: final });
	} finally {
		call.mockRestore();
	}
});
