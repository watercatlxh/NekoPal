import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, ChannelStream, Keyboard, SentHandle } from "../src/channel/types.ts";
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
	readonly keyboard: Keyboard | undefined;
	/** True for the call that created the message. */
	readonly created: boolean;
}

/** Records the calls the reply controller makes on a chat. */
class RecordingChat implements ChatController {
	readonly shown: Shown[] = [];
	readonly plain: string[] = [];
	readonly deleted: string[] = [];
	readonly adapter: Adapter;
	readonly chatId = "42";
	readonly replyTo = "7";
	readonly stream: FakeStream | undefined;
	lang: "en" | "zh" = "en";
	/** What `editRich` answers; false means "does not fit one message". */
	editFits = true;
	private nextId = 1;

	constructor(options: { edit: boolean; stream: boolean; rich: boolean; name?: "telegram" | "qq" }) {
		this.stream = options.stream ? new FakeStream() : undefined;
		const chat = this;
		const record = (handle: SentHandle, markdown: string, keyboard: Keyboard | undefined, created: boolean) => {
			chat.shown.push({ id: handle.id, markdown, keyboard, created });
		};
		this.adapter = {
			name: options.name ?? "telegram",
			caps: { edit: options.edit, stream: options.stream, rich: options.rich, maxChars: 4_096 },
			async start() {},
			async stop() {},
			async sendMarkdown(_chatId: string, markdown: string): Promise<SentHandle[]> {
				const handle = { id: String(chat.nextId++) };
				record(handle, markdown, undefined, true);
				return [handle];
			},
			async sendRich(_chatId: string, markdown: string, _replyTo?: string, keyboard?: Keyboard) {
				const handle = { id: String(chat.nextId++) };
				record(handle, markdown, keyboard, true);
				return handle;
			},
			async editRich(_chatId: string, handle: SentHandle, markdown: string, keyboard?: Keyboard): Promise<boolean> {
				if (!chat.editFits) return false;
				record(handle, markdown, keyboard, false);
				return true;
			},
			async editMarkup(): Promise<void> {},
			async editText(_chatId: string, handle: SentHandle, plain: string): Promise<void> {
				record(handle, plain, undefined, false);
			},
			async deleteMessage(_chatId: string, handle: SentHandle): Promise<void> {
				chat.deleted.push(handle.id);
			},
			async sendFiles() {},
			openStream(): ChannelStream | undefined {
				return chat.stream;
			},
			async notifyWorking() {},
		} as Adapter;
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

	async send(markdown: string): Promise<SentHandle[]> {
		return this.adapter.sendMarkdown(this.chatId, markdown);
	}

	async sendRich(markdown: string, replyTo?: string, keyboard?: Keyboard): Promise<SentHandle> {
		return this.adapter.sendRich(this.chatId, markdown, replyTo, keyboard);
	}

	async editRich(handle: SentHandle, markdown: string, keyboard?: Keyboard): Promise<boolean> {
		return this.adapter.editRich(this.chatId, handle, markdown, keyboard);
	}

	async sendPlain(text: string): Promise<void> {
		this.plain.push(text);
	}

	async deleteMessage(handle: SentHandle): Promise<void> {
		await this.adapter.deleteMessage(this.chatId, handle);
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

function assistantText(text: string): AgentSessionEvent {
	return {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
	} as unknown as AgentSessionEvent;
}

describe("ReplyController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Drive the controller through `events`, advancing the timers after each one. */
	async function run(chat: RecordingChat, events: AgentSessionEvent[], stepMs = 600): Promise<void> {
		const controller = new ReplyController(chat);
		await controller.onEvent({ type: "agent_start" } as AgentSessionEvent);
		for (const event of events) {
			await controller.onEvent(event);
			await vi.advanceTimersByTimeAsync(stepMs);
		}
		await vi.advanceTimersByTimeAsync(stepMs);
	}

	it("sends nothing before the first tool call or text", async () => {
		const chat = new RecordingChat({ edit: true, stream: false, rich: true });
		const controller = new ReplyController(chat);
		await controller.onEvent({ type: "agent_start" } as AgentSessionEvent);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(chat.shown).toEqual([]);
	});

	it("gives every tool call a message of its own, folded", async () => {
		const chat = new RecordingChat({ edit: true, stream: false, rich: true });
		await run(chat, [
			toolStart("1", "bash", { command: "ls -la" }),
			toolEnd("1", "bash", toolResult("total 4")),
			toolStart("2", "read", { path: "/etc/hosts" }),
			toolEnd("2", "read", toolResult("127.0.0.1")),
		]);
		const created = chat.created();
		expect(created).toHaveLength(2);
		const latest = chat.latest();
		expect(latest.get(created[0].id)).toContain("✓ **bash** · ls -la");
		expect(latest.get(created[0].id)).toContain("<details><summary>Details</summary>");
		expect(latest.get(created[0].id)).toContain("total 4");
		expect(latest.get(created[1].id)).toContain("✓ **read** · /etc/hosts");
		expect(latest.get(created[1].id)).toContain("127.0.0.1");
	});

	it("updates a tool message in place when its call ends", async () => {
		const chat = new RecordingChat({ edit: true, stream: false, rich: true });
		await run(chat, [toolStart("1", "bash", { command: "ls" }), toolEnd("1", "bash", toolResult("done"))]);
		const tool = chat.created()[0];
		const states = chat.shown.filter((entry) => entry.id === tool.id);
		expect(states).toHaveLength(2);
		expect(states[0].markdown).toContain("🔧");
		expect(states[1].markdown).toContain("✓");
		expect(chat.deleted).toEqual([]);
	});

	it("marks a failed call with a cross", async () => {
		const chat = new RecordingChat({ edit: true, stream: false, rich: true });
		await run(chat, [toolStart("1", "bash", { command: "false" }), toolEnd("1", "bash", toolResult("boom"), true)]);
		expect(chat.latest().get("1")).toContain("✗ **bash** · false");
		expect(chat.latest().get("1")).toContain("Details · failed");
	});

	it("keeps the reply text in its own message, edited to the end", async () => {
		const chat = new RecordingChat({ edit: true, stream: false, rich: true });
		await run(chat, [
			toolStart("1", "bash", { command: "ls" }),
			toolEnd("1", "bash", toolResult("out")),
			delta("查完了"),
			assistantText("查完了"),
		]);
		const messages = chat.created();
		expect(messages).toHaveLength(2);
		expect(messages[1].markdown).toBe("查完了");
		expect(chat.deleted).toEqual([]);
		// The tool message never carries the reply, and the reply never carries the tool.
		expect(messages[0].markdown).not.toContain("查完了");
		expect(messages[1].markdown).not.toContain("bash");
	});

	it("deletes and resends when the reply does not fit one message", async () => {
		const chat = new RecordingChat({ edit: true, stream: false, rich: true });
		chat.editFits = false;
		const long = "a".repeat(5_000);
		await run(chat, [delta(long), assistantText(long)]);
		expect(chat.deleted).toHaveLength(1);
		expect(chat.created().at(-1)?.markdown).toBe(long);
	});

	it("folds tool output past the body cap", async () => {
		const chat = new RecordingChat({ edit: true, stream: false, rich: true });
		await run(chat, [
			toolStart("1", "bash", { command: "cat big" }),
			toolEnd("1", "bash", toolResult("x".repeat(4_000))),
		]);
		const final = chat.latest().get("1") ?? "";
		expect(final.length).toBeLessThan(2_000);
		expect(final).toContain("…");
		expect(final.endsWith("</details>")).toBe(true);
	});

	it("keeps QQ on one summary message and finishes through the stream", async () => {
		const chat = new RecordingChat({ edit: false, stream: true, rich: false, name: "qq" });
		await run(chat, [
			toolStart("1", "bash", { command: "ls" }),
			toolEnd("1", "bash", toolResult("out")),
			delta("正文"),
			assistantText("正文"),
		]);
		expect(chat.stream?.finished).toBe("正文");
		expect(chat.plain).toHaveLength(1);
		expect(chat.plain[0]).toContain("✓ bash · ls");
	});

	it("delivers every assistant message that carries text", async () => {
		const chat = new RecordingChat({ edit: true, stream: false, rich: true });
		await run(chat, [
			toolStart("1", "bash", { command: "ls" }),
			delta("第一段"),
			assistantText("第一段"),
			toolStart("2", "bash", { command: "pwd" }),
			delta("第二段"),
			assistantText("第二段"),
		]);
		const all = [...chat.shown.map((entry) => entry.markdown)].join("\n");
		expect(all).toContain("第一段");
		expect(all).toContain("第二段");
	});
});
