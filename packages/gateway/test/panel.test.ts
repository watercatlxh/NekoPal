import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { keyboardToMarkup as qqKeyboard } from "../src/channel/qq/keyboard.ts";
import { createTelegramAdapter } from "../src/channel/telegram/adapter.ts";
import { keyboardToMarkup as tgKeyboard } from "../src/channel/telegram/rich.ts";
import type { Keyboard } from "../src/channel/types.ts";
import { decode, navButton, panelKey, pendingKey, runButton, toKeyboard } from "../src/panel/encode.ts";
import { type PanelSnapshot, renderPage } from "../src/panel/model.ts";
import {
	listCustomProviders,
	modelFromId,
	modelsJsonPath,
	providerTaken,
	removeProvider,
	upsertProvider,
} from "../src/panel/models-json.ts";
import * as wizard from "../src/panel/wizard.ts";

const snapshot: PanelSnapshot = {
	lang: "en",
	version: "0.1.0",
	model: "moefox/deepseek",
	thinking: "medium",
	uptimeMs: 90_000,
	sessionId: "0123456789abcdef",
	messages: 12,
	contextTokens: 4_000,
	contextWindow: 128_000,
	cost: 0.0231,
	tokens: { input: 12_400, output: 3_100, cacheRead: 8_000, cacheWrite: 0 },
	chats: 2,
	running: 1,
	memoryUsage: { memory: 100, user: 50 },
	memoryBudget: { memory: 2_200, user: 1_375 },
	stored: [
		{ number: 1, target: "memory", index: 1, text: "likes tea" },
		{ number: 2, target: "user", index: 1, text: "in Asia/Shanghai" },
	],
	pending: 1,
	pendingLines: "1. [memory] prefers Chinese (abc)",
	pendingKey: pendingKey(["abc"]),
	jobs: [
		{
			id: "a1b2c3d4e5",
			name: "digest",
			schedule: "1d",
			prompt: "summarise",
			deliver: { channel: "telegram", chatId: "42" },
			enabled: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			nextRunAt: Date.parse("2026-01-02T00:00:00.000Z"),
		},
	],
	modelsByProvider: [{ id: "moefox", models: ["deepseek", "other"] }],
	providers: [
		{ id: "moefox", configured: true, source: "models_json_key", custom: true },
		{ id: "anthropic", configured: false, custom: false },
	],
	packages: ["github.com/x/y"],
	channels: ["telegram"],
};

describe("panel encoding", () => {
	it("keeps every payload inside Telegram's 64-byte cap", () => {
		const buttons = [
			navButton("Models", "mdl"),
			runButton("Pause", "job", "pause", "a1b2c3d4e5f6"),
			runButton("Forget", "mem", "fg", "12"),
		];
		for (const button of buttons) expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64);
	});

	it("round-trips a navigation press and a command press", () => {
		expect(decode(navButton("Models", "mdl").data)).toEqual({ page: "mdl", verb: "nav", arg: "" });
		expect(decode(runButton("Forget", "mem", "fg", "3").data)).toEqual({
			page: "mem",
			verb: "fg",
			arg: "3",
		});
	});

	it("rejects a payload it did not encode", () => {
		expect(decode("nonsense")).toBeUndefined();
		expect(decode("nav:nowhere")).toBeUndefined();
		expect(decode("nav:constructor")).toBeUndefined();
		expect(decode("__proto__:rm:0")).toBeUndefined();
		expect(decode("nav:mdl:extra")).toBeUndefined();
	});
});

describe("panel pages", () => {
	it("puts the state summary and one button per area on the settings page", () => {
		const view = renderPage("set", snapshot);
		expect(view.text).toContain("moefox/deepseek");
		expect(view.text).toContain("Pending 1");
		const data = view.rows.flat().map((button) => button.data);
		expect(data).toEqual(["nav:ses", "nav:mdl", "nav:mem", "nav:job", "nav:sys", "set:close"]);
	});

	it("picks the provider first, then marks the current model in its list", () => {
		// The root lists configured providers, marking the one that owns the current model.
		const root = renderPage("mdl", snapshot);
		const data = root.rows.flat().map((button) => button.data);
		expect(data).toContain(`mdl:pvd:${panelKey(["moefox"])}`);
		// The provider page lists its models and marks the current one.
		const list = renderPage("mdl", snapshot, "moefox");
		const labels = list.rows.flat().map((button) => button.label);
		expect(labels).toContain("✅ deepseek");
		expect(labels).toContain("other");
		// A model button identifies the full provider/model pair.
		const setData = list.rows.flat().map((button) => button.data);
		expect(setData).toContain(`mdl:set:${panelKey(["moefox", "deepseek"])}`);
	});

	it("shows provider state, a custom-api button and a delete for custom providers", () => {
		const view = renderPage("pvd", snapshot);
		expect(view.text).toContain("✅ moefox · custom");
		expect(view.text).toContain("⬜ anthropic");
		const data = view.rows.flat().map((button) => button.data);
		expect(data).toContain("pvd:add");
		expect(data).toContain(`pvd:rm:${panelKey(["moefox"])}`);
		expect(data).not.toContain(`pvd:rm:${panelKey(["anthropic"])}`);
	});

	it("reports local usage on the sessions page", () => {
		expect(renderPage("ses", snapshot).text).toContain("cost 0.0231");
	});

	it("offers a forget button per stored memory and a back button", () => {
		const view = renderPage("mem", snapshot);
		const data = view.rows.flat().map((button) => button.data);
		expect(data).toContain(`mem:fg:${panelKey(["memory", "likes tea"])}`);
		expect(data).toContain(`mem:fg:${panelKey(["user", "in Asia/Shanghai"])}`);
		expect(data.at(-1)).toBe("nav:set");
	});

	it("lists installed packages with a delete button each", () => {
		const view = renderPage("pkg", snapshot);
		expect(view.text).toContain("github.com/x/y");
		expect(view.rows.flat().map((button) => button.data)).toContain(`pkg:rm:${panelKey(["github.com/x/y"])}`);
	});

	it.each(["en", "zh"] as const)("keeps the last model, provider, package and job reachable in %s", (lang) => {
		const models = Array.from({ length: 13 }, (_, i) => `model-${i}`);
		const packages = Array.from({ length: 7 }, (_, i) => `/p/${i}`);
		const providers = packages.map((_, i) => ({ id: `provider-${i}`, configured: true, custom: true }));
		const jobs = Array.from({ length: 4 }, (_, i) => ({ ...snapshot.jobs[0], id: `job-${i}` }));
		const state = { ...snapshot, lang, packages, providers, jobs, modelsByProvider: [{ id: "moefox", models }] };
		for (const [page, initial, prefix, last, parent] of [
			["mdl", "moefox", `mdl:pg:${panelKey(["moefox"])}:`, `mdl:set:${panelKey(["moefox", models[12]])}`, "mdl"],
			["pvd", "", "pg:pvd:", `pvd:rm:${panelKey([providers[6].id])}`, "mdl"],
			["pkg", "", "pg:pkg:", `pkg:rm:${panelKey([packages[6]])}`, "sys"],
			["job", "", "pg:job:", `job:rm:${panelKey([jobs[3].id])}`, "set"],
		] as const) {
			let view = renderPage(page, state, initial);
			for (let index = 1; ; index++) {
				const wire = qqKeyboard(toKeyboard(view.rows))?.content.rows.flatMap((row) =>
					row.buttons.map((button) => button.action.data),
				);
				expect(wire).toEqual(view.rows.flat().map((button) => button.command));
				expect(view.rows.at(-1)?.at(-1)?.data).toBe(`nav:${parent}`);
				const next = view.rows.flat().find((button) => button.data === `${prefix}${index}`);
				if (!next) break;
				const press = decode(next.data)!;
				view = renderPage(page, state, page === "mdl" ? `${initial} ${press.arg.split(":")[1]}` : press.arg);
			}
			expect(view.rows.flat().map((button) => button.data)).toContain(last);
		}
	});

	it("gives the settings page no back button", () => {
		const data = renderPage("set", snapshot)
			.rows.flat()
			.map((button) => button.data);
		expect(data).not.toContain("nav:set");
	});
});

describe("keyboards", () => {
	const keyboard: Keyboard = toKeyboard(renderPage("mem", snapshot).rows);

	it("maps buttons onto Telegram inline keys", () => {
		const markup = tgKeyboard(keyboard);
		expect(markup?.inline_keyboard.flat().find((button) => button.text === "✅ Approve all")?.callback_data).toBe(
			`mem:ok:${snapshot.pendingKey}`,
		);
	});

	it("posts literal Telegram panel text with its keyboard and retries only absent edits as new pages", async () => {
		const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 71 } }));
		vi.stubGlobal("fetch", send);
		try {
			const adapter = createTelegramAdapter({
				settingsManager: SettingsManager.inMemory({
					nekopal: { channels: { telegram: { botToken: "test-only" } } },
				}),
				log: vi.fn(),
				logError: vi.fn(),
			});
			const handle = await adapter.sendRich("42", "plain * and <", "9", keyboard);
			expect(handle).toEqual({ id: "71" });
			const [url, request] = send.mock.calls[0];
			expect(String(url)).toMatch(/\/sendMessage$/);
			expect(JSON.parse(String(request?.body))).toEqual({
				chat_id: "42",
				text: "plain * and <",
				reply_markup: tgKeyboard(keyboard),
				reply_parameters: { message_id: 9, allow_sending_without_reply: true },
			});
			for (const [description, expected] of [
				["message is not modified", true],
				["message to edit not found", false],
			] as const) {
				send.mockResolvedValueOnce(Response.json({ ok: false, error_code: 400, description }));
				expect(await adapter.editRich("42", handle, "literal", keyboard)).toBe(expected);
			}
			send.mockRejectedValueOnce(new TypeError("network unavailable"));
			await expect(adapter.editRich("42", handle, "literal", keyboard)).rejects.toThrow("network unavailable");
			expect(send.mock.calls.slice(1).map(([method]) => String(method).split("/").at(-1))).toEqual(
				Array(3).fill("editMessageText"),
			);
			send.mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 71 } }));
			await adapter.editRich("42", handle, "Panel closed", []);
			expect(JSON.parse(String(send.mock.calls.at(-1)?.[1]?.body))).toEqual({
				chat_id: "42",
				message_id: 71,
				text: "Panel closed",
				reply_markup: { inline_keyboard: [] },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("maps buttons onto QQ command buttons, capped at 5x5", () => {
		const rows = qqKeyboard(keyboard)?.content.rows ?? [];
		expect(rows.length).toBeLessThanOrEqual(5);
		for (const row of rows) expect(row.buttons.length).toBeLessThanOrEqual(5);
		expect(rows.flatMap((row) => row.buttons).map((button) => button.action.data)).toContain(
			`/settings act mem:ok:${snapshot.pendingKey}`,
		);
	});
});

describe("models.json", () => {
	it("writes a provider, keeps a backup and reads it back", () => {
		const dir = mkdtempSync(join(tmpdir(), "nekopal-models-"));
		writeFileSync(modelsJsonPath(dir), JSON.stringify({ unknown: { keep: 1 }, exists: "user field" }));
		upsertProvider(dir, {
			name: "myapi",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			apiKey: "$MYAPI_KEY",
			models: [modelFromId("m1")],
		});
		expect(listCustomProviders(dir)).toEqual(["myapi"]);
		const written = JSON.parse(readFileSync(modelsJsonPath(dir), "utf-8")) as {
			providers: { myapi: { apiKey: string; models: { id: string }[] } };
		};
		expect(written).toMatchObject({ unknown: { keep: 1 }, exists: "user field" });
		expect(written.providers.myapi.apiKey).toBe("$MYAPI_KEY");
		expect(written.providers.myapi.models[0].id).toBe("m1");
		expect(() => readFileSync(`${modelsJsonPath(dir)}.bak`)).not.toThrow();
	});

	it("removes a provider it wrote and reports one it did not", () => {
		const dir = mkdtempSync(join(tmpdir(), "nekopal-models-"));
		upsertProvider(dir, {
			name: "gone",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			apiKey: "k",
			models: [],
		});
		expect(removeProvider(dir, "gone")).toBe(true);
		expect(removeProvider(dir, "gone")).toBe(false);
		expect(listCustomProviders(dir)).toEqual([]);
	});

	it.each(["{broken", "[]", "null", '{"providers":[]}', '{"providers":1}'])(
		"preserves invalid config and backup: %s",
		(invalid) => {
			const dir = mkdtempSync(join(tmpdir(), "nekopal-models-"));
			const path = modelsJsonPath(dir);
			writeFileSync(path, invalid);
			writeFileSync(`${path}.bak`, "previous");
			expect(() => removeProvider(dir, "old")).toThrow();
			expect(() =>
				upsertProvider(dir, {
					name: "new",
					baseUrl: "https://example.org",
					api: "openai-responses",
					apiKey: "fake",
					models: [],
				}),
			).toThrow();
			expect(readFileSync(path, "utf8")).toBe(invalid);
			expect(readFileSync(`${path}.bak`, "utf8")).toBe("previous");
		},
	);

	it("refuses to replace an ID introduced while a wizard was probing", () => {
		const dir = mkdtempSync(join(tmpdir(), "nekopal-models-"));
		const path = modelsJsonPath(dir);
		const original = '{ "providers": {"myapi": {"name":"existing"}} }';
		writeFileSync(path, original);
		expect(() =>
			upsertProvider(dir, {
				name: "myapi",
				baseUrl: "https://example.org",
				api: "openai-responses",
				apiKey: "fake",
				models: [],
			}),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("treats a built-in id as taken", () => {
		const dir = mkdtempSync(join(tmpdir(), "nekopal-models-"));
		expect(providerTaken(dir, "anthropic", ["anthropic"])).toBe(true);
		expect(providerTaken(dir, "myapi", ["anthropic"])).toBe(false);
	});
});

describe("custom provider wizard", () => {
	const taken = (id: string) => id === "moefox";

	/** Walk the four questions and return the draft at the confirm step. */
	function complete(): wizard.ProviderDraft {
		let draft = wizard.newDraft();
		const id = wizard.applyText(draft, "myapi", taken);
		if ("error" in id) throw new Error(id.error);
		draft = id.draft;
		const url = wizard.applyText(draft, "https://api.example.com/v1/", taken);
		if ("error" in url) throw new Error(url.error);
		draft = url.draft;
		const api = wizard.applyChoice(draft, "api", "openai-completions");
		if (api === undefined) throw new Error("api step rejected");
		draft = api;
		const key = wizard.applyText(draft, "$MYAPI_KEY", taken);
		if ("error" in key) throw new Error(key.error);
		return key.draft;
	}

	it("walks id → baseUrl → api → apiKey and lands on confirm", () => {
		const draft = complete();
		expect(draft.step).toBe("confirm");
		expect(draft.id).toBe("myapi");
		// The trailing slash is trimmed so `/models` cannot double it.
		expect(draft.baseUrl).toBe("https://api.example.com/v1");
		expect(draft.api).toBe("openai-completions");
	});

	it("rejects a bad id, a taken id and a bad url", () => {
		const draft = wizard.newDraft();
		expect(wizard.applyText(draft, "My API", taken)).toEqual({ error: "id" });
		expect(wizard.applyText(draft, "moefox", taken)).toEqual({ error: "taken" });
		const atUrl = wizard.applyText(draft, "myapi", taken);
		if ("error" in atUrl) throw new Error(atUrl.error);
		expect(wizard.applyText(atUrl.draft, "api.example.com", taken)).toEqual({ error: "baseUrl" });
	});

	it("builds the provider to write, with one model per discovered id", () => {
		const draft = wizard.withProbe(complete(), ["m1", "m2"]);
		const provider = wizard.toProvider(draft);
		expect(provider.name).toBe("myapi");
		expect(provider.models.map((model) => model.id)).toEqual(["m1", "m2"]);
	});
});
