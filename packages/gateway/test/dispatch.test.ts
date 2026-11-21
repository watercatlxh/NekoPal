import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness, fauxText, settle } from "./support/harness.ts";

describe("Dispatcher", () => {
	it("drops a message from a user outside the allowlist", async () => {
		const harness = await createHarness();
		await harness.deliver("hello", "99");
		await settle();
		expect(harness.adapter.sent).toEqual([]);
	});

	it("answers an allowed message and renders the reply", async () => {
		const harness = await createHarness();
		harness.faux.setResponses([fauxText("hi there")]);
		await harness.deliver("hello");
		expect(await harness.adapter.next("hi there")).toContain("hi there");
	});

	it("runs /settings lang zh so later commands answer in Chinese", async () => {
		const harness = await createHarness();
		await harness.deliver("/settings lang zh");
		expect(await harness.adapter.next("语言")).toContain("语言");
		await harness.deliver("/help");
		expect(await harness.adapter.next("命令")).toContain("命令");
	});

	it("shows the memory budget in /settings", async () => {
		const harness = await createHarness();
		await harness.deliver("/settings");
		const settings = await harness.adapter.next("Memory:");
		expect(settings).toContain("Memory:");
		expect(settings).toContain("2200");
	});
});

describe("panel button presses", () => {
	it("renders the provider page from its own navigation button", async () => {
		const harness = await createHarness();
		await harness.press("nav:pvd");
		// The provider page renders instead of reporting a missing wizard.
		expect(await harness.adapter.next("Providers")).toContain("Providers");
	});

	it("opens a provider's model list from the model page's provider button", async () => {
		const harness = await createHarness();
		await harness.press("mdl:pvd:faux");
		// The provider page lists that provider's models; the root only names providers.
		const seen = harness.adapter.edits.join("\n") + harness.adapter.sent.join("\n");
		expect(seen).toContain("faux-1");
	});

	it("starts a login without a draft in flight", async () => {
		const harness = await createHarness();
		// The OAuth press used to hit the "no wizard in flight" message and never start.
		await harness.press("pvd:oauth:anthropic");
		await harness.press("pvd:key:google");
		const seen = harness.adapter.sent.join("\n");
		expect(seen).not.toContain("没有进行中的自定义 API 流程");
	});

	it("answers a provider delete press without a wizard in flight", async () => {
		const harness = await createHarness();
		await harness.press("pvd:rm:faux");
		// A built-in provider is not custom, so removal reports it is not declared.
		expect(await harness.adapter.next("faux")).toContain("faux");
	});

	it("switches the language from the settings page button", async () => {
		const harness = await createHarness();
		await harness.press("set:lang:zh");
		// The settings page re-renders in Chinese.
		expect(await harness.adapter.next("语言：zh")).toContain("语言：zh");
	});

	it("asks for a package source and installs it", async () => {
		const harness = await createHarness();
		const root = mkdtempSync(join(tmpdir(), "nekopal-pkg-"));
		// A local directory the installer accepts: it only needs to exist.
		const source = join(root, "my-extension");
		mkdirSync(source, { recursive: true });
		await harness.press("pkg:add");
		// The ask is language-dependent, so wait for the prompt notice and answer it.
		await harness.adapter.next("install");
		await harness.deliver(source);
		expect(await harness.adapter.next("Installed")).toContain(source);
	});
});
