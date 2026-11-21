import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSessionEvent, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramAdapter } from "../src/channel/telegram/adapter.ts";
import type { Inbound } from "../src/channel/types.ts";
import { ChatRegistry } from "../src/chat/registry.ts";
import { ReplyController } from "../src/chat/reply.ts";
import { StateStore } from "../src/state.ts";
import { createHarness, fauxText, type Harness } from "./support/harness.ts";

function inbound(chatId: string, channel: Inbound["channel"] = "telegram"): Inbound {
	return { channel, chatId, userId: chatId, messageId: "7", text: "", attachments: [] };
}

function loadRegistry(h: Harness, path: string) {
	const state = StateStore.load(path);
	const registry = new ChatRegistry({ ...h, state, redactor: { secrets: () => [] }, defaultLang: "en" });
	registry.registerAdapter(h.adapter);
	return { registry, state };
}

const source = "**粗体** 和 a.b";
const converted = "*粗体* 和 a\\.b";
const settled: AgentSessionEvent = { type: "agent_settled", aborted: false };

/** Exercise the real adapter, giving every newly sent message a distinct Bot API id. */
function telegramWire() {
	const sentIds: number[] = [];
	const post = vi.fn<typeof fetch>(async (url) => {
		const method = String(url).split("/").at(-1);
		const result =
			method === "sendMessage" || method === "sendRichMessage" ? { message_id: 100 + sentIds.length } : true;
		if (result !== true) sentIds.push(result.message_id);
		return Response.json({ ok: true, result });
	});
	vi.stubGlobal("fetch", post);
	const adapter = createTelegramAdapter({
		settingsManager: SettingsManager.inMemory({ nekopal: { channels: { telegram: { botToken: "test-only" } } } }),
		log: vi.fn(),
		logError: vi.fn(),
	});
	const requests = () =>
		post.mock.calls
			.map(([url, init]) => ({
				method: String(url).split("/").at(-1),
				body: JSON.parse(String(init?.body)),
			}))
			.filter(({ method }) => method !== "sendChatAction");
	return { adapter, post, requests, sentIds };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Telegram's per-chat reply format", () => {
	it("checks the selected system-page button in place and restores the setting without disturbing other state", async () => {
		const h = await createHarness();
		const quota = { day: "2026-06-04", sentToday: { u: 4 } };
		h.state.mutate((state) => {
			state.chats["telegram-42"] = { lang: "zh" };
			state.chats["telegram-43"] = { lang: "en" };
			state.telegram.offset = 123;
			state.qq = structuredClone(quota);
		});
		const chat = await h.registry.chatFor(inbound("42"));
		await h.deliver("/settings sys");
		const panel = h.adapter.panelSends.at(-1)!.id;
		const buttons = () =>
			h.adapter.panels
				.get(panel)!
				.flat()
				.filter((b) => b.data.startsWith("sys:fmt:"));
		expect(buttons().map((b) => [b.data, b.label])).toEqual([
			["sys:fmt:rich", "✓ 富文本"],
			["sys:fmt:mdv2", "MarkdownV2"],
		]);
		const sends = h.adapter.sent.length;
		await h.press(buttons()[1].data, panel);
		expect(h.adapter.sent).toHaveLength(sends);
		expect(h.adapter.editedIds).toEqual([panel]);
		expect(buttons().map((b) => b.label)).toEqual(["富文本", "✓ MarkdownV2"]);
		expect(chat.telegramReplyFormat).toBe("mdv2");
		expect(chat.lang).toBe("zh");

		h.state.flush();
		await h.registry.dispose();
		const { registry, state } = loadRegistry(h, join(h.agentDir, "..", "state.json"));
		try {
			expect(state.chats).toEqual({
				"telegram-42": { lang: "zh", telegramReplyFormat: "mdv2" },
				"telegram-43": { lang: "en" },
			});
			expect(state.telegramOffset).toBe(123);
			expect(state.qq).toEqual(quota);
			expect(await registry.chatFor(inbound("42"))).toMatchObject({ lang: "zh", telegramReplyFormat: "mdv2" });
			expect(await registry.chatFor(inbound("43"))).toMatchObject({ lang: "en", telegramReplyFormat: "rich" });
		} finally {
			await registry.dispose();
		}
	});

	it("defaults an unknown stored format to Rich and rejects an invalid command without changing the selection", async () => {
		const h = await createHarness();
		const path = join(h.agentDir, "legacy-state.json");
		writeFileSync(path, JSON.stringify({ chats: { "telegram-42": { lang: "zh", telegramReplyFormat: "html" } } }));
		const { registry } = loadRegistry(h, path);
		try {
			expect(await registry.chatFor(inbound("42"))).toMatchObject({ lang: "zh", telegramReplyFormat: "rich" });
		} finally {
			await registry.dispose();
		}

		const chat = await h.registry.chatFor(inbound("42"));
		await h.deliver("/settings format mdv2");
		const before = structuredClone(h.state.chats);
		await h.deliver("/settings format html");
		expect(h.adapter.sent.at(-1)).toBe("Usage: /settings format <rich|mdv2>");
		expect(h.state.chats).toEqual(before);
		expect(chat.telegramReplyFormat).toBe("mdv2");
	});

	it("omits format choices on QQ and rejects both text and replayed actions", async () => {
		const h = await createHarness({ channel: "qq" });
		await h.registry.chatFor(inbound("42", "qq"));
		await h.deliver("/settings sys");
		const keyboard = h.adapter.keyboards.at(-1)!.flat();
		expect(keyboard.length).toBeGreaterThan(0);
		expect(keyboard.some((b) => b.data.startsWith("sys:fmt:"))).toBe(false);
		const before = structuredClone(h.state.chats);
		for (const command of ["/settings format mdv2", "/settings act sys:fmt:mdv2"]) {
			const count = h.adapter.sent.length;
			await h.deliver(command);
			expect(h.adapter.sent.slice(count).join("\n")).toMatch(/Telegram/i);
			expect(h.state.chats).toEqual(before);
		}
	});

	it("sends and edits ordinary replies in MarkdownV2, keeps tool HTML literal, and leaves other chats on Rich", async () => {
		const h = await createHarness();
		const { adapter, post, requests, sentIds } = telegramWire();
		h.registry.registerAdapter(adapter);
		const a = await h.registry.chatFor(inbound("42"));
		const b = await h.registry.chatFor(inbound("43"));
		await h.deliver("/settings format mdv2", "42", "7");
		post.mockClear();
		const run = new ReplyController(a);
		vi.useFakeTimers();
		await run.onEvent({ type: "agent_start" });
		await run.onEvent({ type: "tool_execution_start", toolCallId: "t", toolName: "r<&", args: {} });
		await run.onEvent({
			type: "tool_execution_end",
			toolCallId: "t",
			toolName: "r<&",
			result: { content: [{ type: "text", text: source }] },
			isError: false,
		});
		await run.onEvent({
			type: "message_update",
			message: fauxText(source),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: source, partial: fauxText(source) },
		});
		await vi.advanceTimersByTimeAsync(400);
		await run.onEvent({ type: "message_end", message: fauxText(`${source}!`) });
		await run.onEvent(settled);
		vi.useRealTimers();
		const messages = requests();
		expect(messages[0].body).not.toHaveProperty("reply_parameters");
		expect(messages[2].body.reply_parameters).toEqual({ message_id: 7 });
		expect(messages).toMatchObject([
			{
				method: "sendMessage",
				body: {
					chat_id: "42",
					parse_mode: "HTML",
					text: "🔧 <b>r&lt;&amp;</b>\n<blockquote expandable>…</blockquote>",
				},
			},
			{
				method: "editMessageText",
				body: {
					chat_id: "42",
					parse_mode: "HTML",
					text: `🔧 <b>r&lt;&amp;</b>\n<blockquote expandable>${source}</blockquote>`,
				},
			},
			{ method: "sendMessage", body: { chat_id: "42", parse_mode: "MarkdownV2", text: converted } },
			{ method: "editMessageText", body: { chat_id: "42", parse_mode: "MarkdownV2", text: `${converted}\\!` } },
		]);
		expect([messages[1].body.message_id, messages[3].body.message_id]).toEqual(sentIds.slice(-2));

		async function quickReply(controller: ReplyController) {
			await controller.onEvent({ type: "agent_start" });
			await controller.onEvent({ type: "message_end", message: fauxText(source) });
			await controller.onEvent(settled);
		}
		post.mockClear();
		await quickReply(run);
		await quickReply(new ReplyController(b));
		expect(requests()).toMatchObject([
			{ method: "sendMessage", body: { chat_id: "42", text: converted, parse_mode: "MarkdownV2" } },
			{ method: "sendRichMessage", body: { chat_id: "43", rich_message: { markdown: source } } },
		]);
		await h.deliver("/settings format rich", "42", "8");
		post.mockClear();
		await quickReply(run);
		expect(requests()).toMatchObject([
			{ method: "sendRichMessage", body: { chat_id: "42", rich_message: { markdown: source } } },
		]);
	});
});
