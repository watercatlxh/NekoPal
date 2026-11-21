import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { panelKey } from "../src/panel/encode.ts";
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
		await harness.deliver("/settings sys");
		const settings = await harness.adapter.next("Memory:");
		expect(settings).toContain("Memory:");
		expect(settings).toContain("2200");
	});
});

describe("panel button presses", () => {
	it("lists configured models rather than every bundled provider in /model", async () => {
		const h = await createHarness();
		await h.deliver("/model");
		const list = await h.adapter.next("faux: faux-1");
		expect(list).not.toMatch(/^(?:google|anthropic|openai|xai):/m);
	});

	it("asks for explicit reselection before prompting with a retired saved model", async () => {
		const h = await createHarness();
		await h.deliver("/settings");
		h.settingsManager.setDefaultModel("retired-model");
		h.faux.setResponses([fauxText("unexpected fallback")]);
		await h.deliver("hello");
		expect(await h.adapter.next("/settings mdl")).toContain("saved model");
		expect(h.settingsManager.getDefaultModel()).toBe("retired-model");
		expect(h.adapter.sent).not.toContain("unexpected fallback");
	});

	it("waits for one initialized chat when two panels open simultaneously", async () => {
		const h = await createHarness();
		await Promise.all([h.deliver("/settings", "42", "first"), h.deliver("/settings sys", "42", "second")]);
		await expect.poll(() => h.adapter.panelSends.map(({ replyTo }) => replyTo).sort()).toEqual(["first", "second"]);
		expect(h.registry.size).toBe(1);
	});

	it("leaves packages untouched for a stale selection and a missing typed index", async () => {
		const h = await createHarness();
		await h.deliver("/settings");
		await h.adapter.next("NekoPal");
		const a = join(h.workspace, "a"),
			b = join(h.workspace, "b");
		for (const source of [a, b]) mkdirSync(source);
		h.settingsManager.setPackages([a, b]);
		await h.deliver("/packages");
		const { id } = h.adapter.panelSends.at(-1)!;
		const old = h.adapter.panels
			.get(id)!
			.flat()
			.find((item) => item.data === `pkg:rm:${panelKey([a])}`)!;
		h.settingsManager.setPackages([b]);
		await h.press(old.data, id);
		await h.deliver("/packages rm");
		expect(h.settingsManager.getPackages()).toEqual([b]);
		expect(h.adapter.sent).toContain("List changed; select again");
	});

	it("rejects ambiguous memories and approvals after a new suggestion arrives", async () => {
		const h = await createHarness();
		h.memory.apply("memory", [
			{ action: "add", content: "tea" },
			{ action: "add", content: "tea" },
		]);
		const suggestion = {
			target: "user" as const,
			summary: "coffee",
			operations: [{ action: "add" as const, content: "coffee" }],
		};
		h.pending.add(suggestion);
		await h.deliver("/settings mem");
		const { id } = h.adapter.panelSends[0];
		const buttons = h.adapter.panels.get(id)!.flat();
		h.pending.add(suggestion);
		await h.press(buttons.find((button) => button.data.startsWith("mem:ok:"))!.data, id);
		await h.press(buttons.find((button) => button.data.startsWith("mem:fg:"))!.data, id);
		expect(h.pending.list()).toHaveLength(2);
		expect(h.memory.entries("user")).toEqual([]);
		expect(h.memory.entries("memory")).toEqual(["tea", "tea"]);
	});

	it.each(["telegram", "qq"] as const)("resumes the session selected on history page two on %s", async (channel) => {
		const h = await createHarness({ channel });
		await h.deliver("/settings ses");
		const dir = join(h.agentDir, "sessions", `${channel}-42`);
		for (let i = 0; i < 4; i++) {
			const timestamp = `2026-01-0${i + 1}T00:00:00.000Z`;
			const entries = [
				{ type: "session", version: 3, id: `history-${i}`, cwd: h.workspace, timestamp },
				{
					type: "message",
					id: `entry-${i}`,
					parentId: null,
					timestamp,
					message: { role: "user", content: `first ${i}`, timestamp: Date.parse(timestamp) },
				},
			];
			writeFileSync(join(dir, `${i}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		}
		async function click(prefix: string) {
			const { id } = h.adapter.panelSends.at(-1)!;
			await expect
				.poll(() =>
					h.adapter.panels
						.get(id)
						?.flat()
						.some((b) => b.data.startsWith(prefix)),
				)
				.toBe(true);
			const chosen = h.adapter.panels
				.get(id)!
				.flat()
				.find((b) => b.data.startsWith(prefix))!;
			if (channel === "telegram") await h.press(chosen.data, id);
			else await h.deliver(chosen.command);
			return chosen;
		}
		await click("ses:list");
		await expect
			.poll(() =>
				h.adapter.keyboards
					.at(-1)
					?.flat()
					.some((b) => b.data === "pg:ses:1"),
			)
			.toBe(true);
		await click("pg:ses:1");
		await expect
			.poll(() =>
				h.adapter.keyboards
					.at(-1)
					?.flat()
					.some((b) => b.data === "pg:ses:0"),
			)
			.toBe(true);
		const chosen = await click("ses:resume:");
		const selected = `history-${chosen.label.split("first ")[1]}`;
		expect(chosen.data).toBe(`ses:resume:${panelKey([selected])}`);
		await expect.poll(() => h.registry.all()[0].session.getSessionStats().sessionId).toBe(selected);
	});

	it("edits the same Telegram panel once when opening history", async () => {
		const h = await createHarness();
		await h.deliver("/settings ses");
		const { id } = h.adapter.panelSends[0];
		const list = h.adapter.panels
			.get(id)
			?.flat()
			.find((button) => button.data === "ses:list");
		await h.press(list!.data, id);
		await expect.poll(() => h.adapter.editedIds).toEqual([id]);
		expect(h.adapter.panelSends).toHaveLength(1);
		expect(h.adapter.panels.get(id)?.flat().at(-1)?.data).toBe("nav:ses");
	});

	it.each(["telegram", "qq"] as const)(
		"walks settings → system → language → packages → system on %s",
		async (channel) => {
			const h = await createHarness({ channel });
			await h.deliver("/settings");
			for (const data of ["nav:sys", "sys:lang:zh", "nav:pkg", "nav:sys", "sys:lang:en"]) {
				const { id } = h.adapter.panelSends.at(-1)!;
				const button = h.adapter.panels
					.get(id)!
					.flat()
					.find((b) => b.data === data)!;
				if (channel === "qq") await h.deliver(button.command, "42", data);
				else await h.press(button.data, id);
			}
			if (channel === "telegram") {
				expect(h.adapter.editedIds).toEqual(Array(5).fill(h.adapter.panelSends[0].id));
				expect(h.adapter.edits[2]).toContain("扩展包");
			} else {
				expect(h.adapter.panelSends.map((send) => send.replyTo)).toEqual([
					"inbound",
					"nav:sys",
					"sys:lang:zh",
					"nav:pkg",
					"nav:sys",
					"sys:lang:en",
				]);
				expect(h.adapter.sent[3]).toContain("扩展包");
			}
		},
	);

	it.each(["telegram", "qq"] as const)(
		"closes a browsing panel without aborting the running answer on %s",
		async (channel) => {
			const h = await createHarness({ channel });
			await h.deliver("/settings");
			const { id } = h.adapter.panelSends[0];
			const close = h.adapter.panels
				.get(id)!
				.flat()
				.find((b) => b.data === "set:close")!;
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			h.faux.setResponses([
				async () => {
					started.resolve();
					await release.promise;
					return fauxText("still running");
				},
			]);
			await h.deliver("hello");
			await started.promise;
			try {
				if (channel === "telegram") await h.press(close.data, id);
				else await h.deliver(close.command, "42", "close-click");
				expect(await h.adapter.next("Panel closed")).toBe("Panel closed");
				expect(h.adapter.keyboards.at(-1)).toEqual([]);
				expect(h.adapter.editedIds).toEqual(channel === "telegram" ? [id] : []);
				if (channel === "qq") expect(h.adapter.panelSends.at(-1)?.replyTo).toBe("close-click");
			} finally {
				release.resolve();
			}
			expect(await h.adapter.next("still running")).toBe("still running");
		},
	);

	it("routes a QQ keyboard command ahead of pending input, replying to the click", async () => {
		const h = await createHarness({ channel: "qq" });
		await h.deliver("/settings", "42", "root");
		const command = h.adapter.panels
			.get(h.adapter.panelSends[0].id)!
			.flat()
			.find((button) => button.data === "nav:ses")!.command;
		await h.deliver("/settings act pkg:add");
		await h.deliver(command!, "42", "click");
		await h.deliver("/cancel");
		expect(h.adapter.panelSends.filter(({ replyTo }) => replyTo === "click")).toHaveLength(1);
		expect(h.settingsManager.getPackages()).toEqual([]);
		expect(h.adapter.edits).toEqual([]);
	});

	it("renders the provider page from its own navigation button", async () => {
		const harness = await createHarness();
		await harness.press("nav:pvd");
		// The provider page renders instead of reporting a missing wizard.
		expect(await harness.adapter.next("Providers")).toContain("Providers");
	});

	it("opens a provider's model list from the model page's provider button", async () => {
		const harness = await createHarness();
		await harness.press(`mdl:pvd:${panelKey(["faux"])}`);
		// The provider page lists that provider's models; the root only names providers.
		const seen = harness.adapter.edits.join("\n") + harness.adapter.sent.join("\n");
		expect(seen).toContain("faux-1");
	});

	it("does not start an OAuth login from an unscoped old picker button", async () => {
		const harness = await createHarness();
		await harness.press("pvd:oauth:anthropic");
		expect(harness.adapter.sent).not.toContainEqual(expect.stringContaining("https://"));
		expect(harness.registry.all()[0].pendingPrompt).toBeUndefined();
	});

	it("answers a provider delete press without a wizard in flight", async () => {
		const harness = await createHarness();
		await harness.press(`pvd:rm:${panelKey(["faux"])}`);
		expect(await harness.adapter.next("List changed")).toContain("select again");
	});

	it("switches the language from the settings page button", async () => {
		const harness = await createHarness();
		await harness.press("sys:lang:zh");
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
