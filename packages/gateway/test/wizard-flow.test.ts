import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../src/i18n/index.ts";
import { API_KINDS, modelsJsonPath } from "../src/panel/models-json.ts";
import { LOGIN_PROVIDER_IDS } from "../src/panel/router.ts";
import { createHarness, fauxText, type Harness } from "./support/harness.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function buttons(h: Harness) {
	return h.adapter.keyboards.at(-1)?.flat() ?? [];
}

function button(h: Harness, prefix: string) {
	const found = buttons(h).find((b) => b.data.startsWith(prefix));
	if (!found) throw new Error(`Expected a ${prefix} button`);
	return found;
}

const panelId = "provider-panel";

async function start(h: Harness) {
	if (h.adapter.name === "qq") await h.deliver("/settings act pvd:add", "42", "add");
	else await h.press("pvd:add", panelId);
	return button(h, "set:cancel:").data.slice("set:cancel:".length);
}

async function chooseApi(h: Harness, id = "testapi") {
	await h.deliver(id);
	await h.deliver("https://example.invalid/v1/");
	const choice = button(h, "pvd:api:0:");
	if (h.adapter.name === "qq") await h.deliver(choice.command!, "42", "choose");
	else await h.press(choice.data, panelId);
}

function output(h: Harness): string {
	return [...h.adapter.sent, ...h.adapter.edits].join("\n");
}

describe("custom provider flow", () => {
	it("edits the originating panel, masks credentials, and consumes confirmation once", async () => {
		const h = await createHarness();
		const flow = await start(h);
		const path = modelsJsonPath(h.agentDir);
		await h.deliver("testapi");
		await h.deliver("https://example.invalid/v1");
		expect(buttons(h).map((b) => b.data)).toEqual([
			...API_KINDS.map((_, i) => `pvd:api:${i}:${flow}`),
			`set:cancel:${flow}`,
		]);
		await h.press(`pvd:api:99:${flow}`, panelId);
		await h.press(`pvd:save:${flow}`, panelId);
		expect(existsSync(path)).toBe(false);
		await h.press(button(h, "pvd:api:0:").data, panelId);
		const fetch = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "example-model" }] }));
		vi.stubGlobal("fetch", fetch);
		vi.stubEnv("WIZARD_TEST_TOKEN", "fake-resolved-credential");
		const logs = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		await h.deliver("$WIZARD_TEST_TOKEN", "42", "user-secret-message");
		expect(fetch).toHaveBeenCalledWith(
			"https://example.invalid/v1/models",
			expect.objectContaining({
				headers: expect.objectContaining({ authorization: "Bearer fake-resolved-credential" }),
			}),
		);
		expect(h.adapter.edits.at(-1)).toContain("apiKey: ••••");
		expect(new Set(h.adapter.editedIds)).toEqual(new Set([panelId]));
		expect(h.adapter.panelSends).toHaveLength(0);
		const save = button(h, "pvd:save:").data;
		const refresh = vi
			.spyOn(ModelRuntime.prototype, "refresh")
			.mockResolvedValue({ errors: new Map(), aborted: false });
		await h.press(save, panelId);
		await h.press(save, panelId);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(path, "utf8")).providers.testapi).toMatchObject({
			apiKey: "$WIZARD_TEST_TOKEN",
			models: [expect.objectContaining({ id: "example-model" })],
		});
		expect(output(h)).toContain(t("en", "wizard.saved", { id: "testapi", n: 1 }));
		expect(`${output(h)}\n${JSON.stringify(logs.mock.calls)}`).not.toMatch(
			/fake-resolved-credential|WIZARD_TEST_TOKEN/,
		);
	});

	it.each(["id", "baseUrl", "api", "apiKey", "confirm"] as const)(
		"cancels from the displayed %s step without saving",
		async (step) => {
			const h = await createHarness();
			const id = await start(h);
			if (step !== "id") await h.deliver("testapi");
			if (step === "api" || step === "apiKey" || step === "confirm") await h.deliver("https://example.invalid/v1");
			if (step === "apiKey" || step === "confirm") await h.press(button(h, "pvd:api:1:").data, panelId);
			if (step === "confirm") {
				vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [] })));
				await h.deliver("unused-secret");
			}
			const cancel = button(h, "set:cancel:");
			expect(cancel.data).toBe(`set:cancel:${id}`);
			await h.press(cancel.data, panelId);
			expect(buttons(h).map((b) => b.data)).toContain("pvd:add");
			await h.press(`pvd:save:${id}`, panelId);
			expect(existsSync(modelsJsonPath(h.agentDir))).toBe(false);
		},
	);

	it.each(["/cancel", "button", "navigate"])("%s aborts discovery and ignores a late response", async (exit) => {
		const h = await createHarness();
		const flow = await start(h);
		await chooseApi(h);
		const deferred = Promise.withResolvers<Response>();
		let signal: AbortSignal | undefined;
		const fetch = vi.fn((_url: string, options: RequestInit) => {
			signal = options.signal ?? undefined;
			return deferred.promise;
		});
		vi.stubGlobal("fetch", fetch);
		await h.deliver("fake-literal-token");
		await h.deliver("second-answer");
		await h.press(`pvd:save:${flow}`, panelId);
		expect(fetch).toHaveBeenCalledTimes(1);
		if (exit === "button") await h.press(button(h, "set:cancel:").data, panelId);
		else if (exit === "navigate") await h.press("nav:set", panelId);
		else await h.deliver("/cancel");
		expect(signal?.aborted).toBe(true);
		deferred.resolve(Response.json({ data: ["late"] }));
		await h.settle();
		expect(output(h)).not.toContain(t("en", "wizard.confirm"));
		expect(output(h)).not.toContain("fake-literal-token");
		expect(existsSync(modelsJsonPath(h.agentDir))).toBe(false);
		h.faux.setResponses([fauxText("agent received the next turn")]);
		await h.deliver("hello");
		expect(await h.adapter.next("agent received the next turn")).toContain("agent received");
	});

	it("never applies an earlier flow's API, save or cancel to a new draft", async () => {
		const h = await createHarness();
		const old = await start(h);
		await chooseApi(h, "oldapi");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Bearer fake-literal-token")));
		await h.deliver("fake-literal-token");
		const staleSave = button(h, "pvd:save:").data;
		const staleCancel = button(h, "set:cancel:").data;
		await h.press(staleCancel, panelId);
		const current = await start(h);
		expect(current).not.toBe(old);
		await h.deliver("freshapi");
		await h.deliver("https://example.invalid/v1");
		await h.press(`pvd:api:0:${old}`, panelId);
		await h.press(button(h, `pvd:api:1:${current}`).data, panelId);
		await h.deliver("fake-literal-token");
		await h.press(staleCancel, panelId);
		await h.press(staleSave, panelId);
		expect(existsSync(modelsJsonPath(h.agentDir))).toBe(false);
		expect(button(h, "pvd:save:").data).toBe(`pvd:save:${current}`);
		expect(output(h)).toContain("api: openai-responses");
		expect(output(h)).not.toContain("fake-literal-token");
	});

	it("does not overwrite an ID occupied between probe and save", async () => {
		const h = await createHarness();
		await start(h);
		await chooseApi(h);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: ["model"] })));
		await h.deliver("fake-literal-token");
		const path = modelsJsonPath(h.agentDir);
		const intervening = '{"providers":{"testapi":{"apiKey":"existing"}}}';
		writeFileSync(path, intervening);
		await h.press(button(h, "pvd:save:").data, panelId);
		expect(readFileSync(path, "utf8")).toBe(intervening);
		expect(output(h)).toContain(t("en", "wizard.writeFailed"));
	});

	it("reports a committed write even when reload fails, without exposing the exception", async () => {
		const h = await createHarness();
		await start(h);
		await chooseApi(h);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
		await h.deliver("fake-literal-token");
		const refresh = vi.spyOn(ModelRuntime.prototype, "refresh").mockResolvedValue({
			errors: new Map([["testapi", new Error("fake-literal-token")]]),
			aborted: false,
		});
		const save = button(h, "pvd:save:").data;
		await h.press(save, panelId);
		await h.press(save, panelId);
		expect(output(h)).toContain(t("en", "wizard.loadFailed"));
		expect(output(h)).not.toContain("fake-literal-token");
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(modelsJsonPath(h.agentDir), "utf8")).providers.testapi).toBeDefined();
	});

	it("sends QQ buttons on each question and replies to the inbound message, never edits it", async () => {
		const h = await createHarness({ channel: "qq" });
		await start(h);
		await chooseApi(h);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: ["id"] })));
		await h.deliver("fake-literal-token", "42", "key-message");
		expect(h.adapter.panelSends.map((send) => send.replyTo)).toEqual([
			"add",
			"inbound",
			"inbound",
			"choose",
			"key-message",
		]);
		expect(h.adapter.editedIds).toHaveLength(0);
		await h.deliver(button(h, "set:cancel:").command!, "42", "cancel-click");
		expect(h.adapter.panelSends.at(-1)?.replyTo).toBe("cancel-click");
		expect(existsSync(modelsJsonPath(h.agentDir))).toBe(false);
	});
});

describe("OAuth picker", () => {
	it("offers only supported OAuth logins and rechecks stored OAuth credentials at logout", async () => {
		const h = await createHarness();
		const credentials = vi.spyOn(ModelRuntime.prototype, "listCredentials").mockResolvedValue([
			{ providerId: "google", type: "oauth" },
			{ providerId: "openai", type: "api_key" },
			{ providerId: "custom", type: "oauth" },
		]);
		const logout = vi.spyOn(ModelRuntime.prototype, "logout").mockResolvedValue();
		await h.press("pvd:login", panelId);
		const loginId = button(h, "set:cancel:").data.slice("set:cancel:".length);
		expect(
			buttons(h)
				.filter((b) => b.data.startsWith("pvd:oauth:"))
				.map((b) => b.data),
		).toEqual(LOGIN_PROVIDER_IDS.map((id) => `pvd:oauth:${id}:${loginId}`));
		await h.press(button(h, "pvd:back:").data, panelId);
		await h.press("pvd:logout", panelId);
		const logoutId = button(h, "set:cancel:").data.slice("set:cancel:".length);
		expect(logoutId).not.toBe(loginId);
		expect(
			buttons(h)
				.filter((b) => b.data.startsWith("pvd:out:"))
				.map((b) => b.data),
		).toEqual([`pvd:out:google:${logoutId}`]);
		const out = button(h, "pvd:out:").data;
		credentials.mockResolvedValue([{ providerId: "google", type: "api_key" }]);
		await h.press(out, panelId);
		await h.press("pvd:out:custom", panelId);
		expect(logout).not.toHaveBeenCalled();
		expect(output(h)).toContain(t("en", "panel.stale"));
	});
});
