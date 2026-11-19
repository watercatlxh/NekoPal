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

	it("runs /lang zh so later commands answer in Chinese", async () => {
		const harness = await createHarness();
		await harness.deliver("/lang zh");
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
