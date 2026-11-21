import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyboardToMarkup as qqKeyboard } from "../src/channel/qq/keyboard.ts";
import { keyboardToMarkup as tgKeyboard } from "../src/channel/telegram/rich.ts";
import type { Keyboard } from "../src/channel/types.ts";
import { decode, navButton, runButton, toKeyboard } from "../src/panel/encode.ts";
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
			runButton("Pause", "job", "pause", "a1b2c3d4e5f6", "/jobs pause a1b2c3d4e5f6"),
			runButton("Forget", "mem", "fg", "12", "/memory forget 12"),
		];
		for (const button of buttons) expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64);
	});

	it("round-trips a navigation press and a command press", () => {
		expect(decode(navButton("Models", "mdl").data)).toEqual({ page: "mdl", verb: "nav", arg: "" });
		expect(decode(runButton("Forget", "mem", "fg", "3", "/memory forget 3").data)).toEqual({
			page: "mem",
			verb: "fg",
			arg: "3",
		});
	});

	it("rejects a payload it did not encode", () => {
		expect(decode("nonsense")).toBeUndefined();
		expect(decode("nav:nowhere")).toBeUndefined();
	});
});

describe("panel pages", () => {
	it("puts the state summary and one button per area on the settings page", () => {
		const view = renderPage("set", snapshot);
		expect(view.text).toContain("moefox/deepseek");
		expect(view.text).toContain("Pending 1");
		const data = view.rows.flat().map((button) => button.data);
		expect(data).toEqual([
			"nav:mdl",
			"nav:pvd",
			"nav:ses",
			"nav:pkg",
			"nav:mem",
			"nav:job",
			"set:lang:zh",
			"set:lang:en",
		]);
	});

	it("picks the provider first, then marks the current model in its list", () => {
		// The root lists configured providers, marking the one that owns the current model.
		const root = renderPage("mdl", snapshot);
		const data = root.rows.flat().map((button) => button.data);
		expect(data).toContain("mdl:pvd:moefox");
		// The provider page lists its models and marks the current one.
		const list = renderPage("mdl", snapshot, "moefox");
		const labels = list.rows.flat().map((button) => button.label);
		expect(labels).toContain("✅ deepseek");
		expect(labels).toContain("other");
		// A model button carries provider:index, which /model resolves to that exact entry.
		const setData = list.rows.flat().map((button) => button.data);
		expect(setData).toContain("mdl:set:moefox:0");
	});

	it("shows provider state, a custom-api button and a delete for custom providers", () => {
		const view = renderPage("pvd", snapshot);
		expect(view.text).toContain("✅ moefox · custom");
		expect(view.text).toContain("⬜ anthropic");
		const data = view.rows.flat().map((button) => button.data);
		expect(data).toContain("pvd:add");
		expect(data).toContain("pvd:rm:moefox");
		expect(data).not.toContain("pvd:rm:anthropic");
	});

	it("reports local usage on the sessions page", () => {
		expect(renderPage("ses", snapshot).text).toContain("cost 0.0231");
	});

	it("offers a forget button per stored memory and a back button", () => {
		const view = renderPage("mem", snapshot);
		const data = view.rows.flat().map((button) => button.data);
		expect(data).toContain("mem:fg:1");
		expect(data).toContain("mem:fg:2");
		expect(data.at(-1)).toBe("nav:set");
	});

	it("lists installed packages with a delete button each", () => {
		const view = renderPage("pkg", snapshot);
		expect(view.text).toContain("github.com/x/y");
		expect(view.rows.flat().map((button) => button.data)).toContain("pkg:rm:0");
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
		expect(markup?.inline_keyboard[0][0]).toEqual({ text: "✅ Approve all", callback_data: "mem:ok:all" });
	});

	it("maps buttons onto QQ command buttons, capped at 5x5", () => {
		const rows = qqKeyboard(keyboard)?.content.rows ?? [];
		expect(rows.length).toBeLessThanOrEqual(5);
		for (const row of rows) expect(row.buttons.length).toBeLessThanOrEqual(5);
		expect(rows[0].buttons[0].action.data).toBe("/memory approve all");
	});
});

describe("models.json", () => {
	it("writes a provider, keeps a backup and reads it back", () => {
		const dir = mkdtempSync(join(tmpdir(), "nekopal-models-"));
		writeFileSync(modelsJsonPath(dir), JSON.stringify({ providers: {} }));
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
