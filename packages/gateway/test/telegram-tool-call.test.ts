import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramAdapter } from "../src/channel/telegram/adapter.ts";
import { TelegramError } from "../src/channel/telegram/api.ts";
import { ToolCallRejected } from "../src/channel/types.ts";

function wire() {
	const send = vi.fn<typeof fetch>();
	vi.stubGlobal("fetch", send);
	const adapter = createTelegramAdapter({
		settingsManager: SettingsManager.inMemory({ nekopal: { channels: { telegram: { botToken: "test-only" } } } }),
		log: vi.fn(),
		logError: vi.fn(),
	});
	const requests = () =>
		send.mock.calls.map(([url, init]) => ({
			method: String(url).split("/").at(-1),
			body: JSON.parse(String(init?.body)),
		}));
	return { adapter, send, requests };
}

const ok = () => Response.json({ ok: true, result: { message_id: 71 } });
const fail = (code: number, description: string) =>
	Response.json({
		ok: false,
		error_code: code,
		description,
		parameters: { retry_after: 0 },
	});
const parseError = () => fail(400, "Bad Request: can't parse entities");
const name = "r<&";
const details = `path: a&b\n\nx</blockquote> '"`;
const html =
	"🔧 <b>r&lt;&amp;</b>\n<blockquote expandable>path: a&amp;b\n\nx&lt;/blockquote&gt; &#39;&quot;</blockquote>";

afterEach(() => vi.unstubAllGlobals());

describe("Telegram tool cards", () => {
	it("posts HTML, then edits the same message using independently escaped literal fields", async () => {
		const { adapter, send, requests } = wire();
		send.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
		const handle = await adapter.sendToolCall!("42", name, "");
		expect(handle).toEqual({ id: "71" });
		expect(await adapter.editToolCall!("42", handle, name, details)).toBe(true);
		expect(requests()).toEqual([
			{
				method: "sendMessage",
				body: {
					chat_id: "42",
					parse_mode: "HTML",
					text: "🔧 <b>r&lt;&amp;</b>\n<blockquote expandable>…</blockquote>",
				},
			},
			{ method: "editMessageText", body: { chat_id: "42", message_id: 71, parse_mode: "HTML", text: html } },
		]);
	});

	it("falls back to standalone plain text on parse rejection and retains the edit target", async () => {
		const { adapter, send, requests } = wire();
		send
			.mockResolvedValueOnce(parseError())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(parseError())
			.mockResolvedValueOnce(fail(400, "message is not modified"));
		const handle = await adapter.sendToolCall!("42", name, details);
		expect(await adapter.editToolCall!("42", handle, name, details)).toBe(true);
		const text = `🔧 ${name}\n${details}`;
		expect(requests()).toEqual([
			{ method: "sendMessage", body: { chat_id: "42", text: html, parse_mode: "HTML" } },
			{ method: "sendMessage", body: { chat_id: "42", text } },
			{ method: "editMessageText", body: { chat_id: "42", message_id: 71, text: html, parse_mode: "HTML" } },
			{ method: "editMessageText", body: { chat_id: "42", message_id: 71, text } },
		]);
	});

	it("limits literal UTF-16 units before encoding and never cuts surrogate pairs", async () => {
		const { adapter, send, requests } = wire();
		send.mockResolvedValueOnce(parseError()).mockResolvedValueOnce(ok());
		await adapter.sendToolCall!("42", "🔧".repeat(3000), `${"&".repeat(1498)}😀tail`);
		const [formatted, plain] = requests();
		expect(formatted.body.text).toContain(`${"&amp;".repeat(1498)}…</blockquote>`);
		expect(plain.body.text.length).toBeLessThanOrEqual(4096);
		expect(plain.body.text).toMatch(/^🔧 (?:🔧)+…\n&{1498}…$/u);
	});

	it("distinguishes definitive refusal from transport and server failures", async () => {
		const { adapter, send } = wire();
		send.mockResolvedValueOnce(fail(403, "bot blocked"));
		await expect(adapter.sendToolCall!("42", name, details)).rejects.toBeInstanceOf(ToolCallRejected);
		const network = new TypeError("response lost");
		send.mockRejectedValueOnce(network).mockResolvedValueOnce(fail(500, "can't parse entities"));
		await expect(adapter.sendToolCall!("42", name, details)).rejects.toBe(network);
		await expect(adapter.sendToolCall!("42", name, details)).rejects.toBeInstanceOf(TelegramError);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("retries a rate limit once without switching formats", async () => {
		const { adapter, send, requests } = wire();
		send.mockResolvedValueOnce(fail(429, "slow down")).mockResolvedValueOnce(fail(429, "slow down"));
		await expect(adapter.sendToolCall!("42", name, details)).rejects.toMatchObject({ code: 429 });
		expect(requests().map(({ body }) => body.parse_mode)).toEqual(["HTML", "HTML"]);
	});

	it.each([
		["message is not modified", true],
		["message to edit not found", false],
	] as const)("handles edit refusal: %s", async (reason, expected) => {
		const { adapter, send } = wire();
		send.mockResolvedValueOnce(fail(400, reason));
		expect(await adapter.editToolCall!("42", { id: "71" }, name, details)).toBe(expected);
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("ordinary rich replies", () => {
	it("does not resend after an unknown send or edit outcome", async () => {
		const { adapter, send, requests } = wire();
		const network = new TypeError("response lost");
		send.mockRejectedValueOnce(network).mockResolvedValueOnce(fail(503, "service unavailable"));
		await expect(adapter.sendRich("42", "preview")).rejects.toBe(network);
		await expect(adapter.editRich("42", { id: "71" }, "final")).rejects.toMatchObject({ code: 503 });
		expect(requests().map(({ method }) => method)).toEqual(["sendRichMessage", "editMessageText"]);
	});

	it("accepts an unchanged plain edit after definitive rendering rejections", async () => {
		const { adapter, send, requests } = wire();
		send
			.mockResolvedValueOnce(fail(400, "unsupported rich message"))
			.mockResolvedValueOnce(parseError())
			.mockResolvedValueOnce(fail(400, "message is not modified"));
		expect(await adapter.editRich("42", { id: "71" }, "**final**")).toBe(true);
		expect(requests().map(({ body }) => body.parse_mode)).toEqual([undefined, "MarkdownV2", undefined]);
	});
});
