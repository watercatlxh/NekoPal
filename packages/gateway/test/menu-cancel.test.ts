import type { AuthInteraction } from "@earendil-works/pi-ai";
import { DefaultPackageManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Button } from "../src/channel/types.ts";
import { t } from "../src/i18n/index.ts";
import { createHarness, fauxText, type Harness } from "./support/harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function button(h: Harness, prefix: string): Button {
	const found = h.adapter.keyboards
		.at(-1)
		?.flat()
		.find((b) => b.data.startsWith(prefix));
	if (!found) throw new Error(`No displayed button matching ${prefix}`);
	return found;
}

async function click(h: Harness, b: Button, panel = "panel", inbound = "click") {
	if (h.adapter.name === "telegram") await h.press(b.data, panel);
	else await h.deliver(b.command!, "42", inbound);
}

function chatOf(h: Harness) {
	return h.registry.chatFor({
		channel: h.adapter.name,
		chatId: "42",
		userId: "42",
		text: "",
		messageId: "inbound",
		attachments: [],
	});
}

describe("package source wait", () => {
	it.each(["telegram", "qq"] as const)(
		"clicking Cancel on the actual %s question never starts installation",
		async (channel) => {
			const h = await createHarness({ channel });
			const install = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue();
			await h.deliver("/packages", "42", "open");
			const origin = h.adapter.panelSends.at(-1)!.id;
			await click(h, button(h, "pkg:add"), origin, "add");
			const prompt = h.adapter.panelSends.at(-1)!;
			const question = t("en", "pkg.askSource");
			expect(h.adapter.sent.at(-1)).toBe(question);
			expect(h.adapter.sent.filter((text) => text === question)).toHaveLength(1);
			expect(prompt.id).not.toBe(origin);
			if (channel === "qq") expect(prompt.replyTo).toBe("add");
			const cancel = button(h, "set:cancel:");
			await click(h, cancel, prompt.id, "cancel-click");
			expect(button(h, "pkg:add")).toBeDefined();
			if (channel === "telegram") expect(h.adapter.editedIds.at(-1)).toBe(origin);
			else expect(h.adapter.panelSends.at(-1)?.replyTo).toBe("cancel-click");
			const chat = await chatOf(h);
			expect(chat.pendingPrompt).toBeUndefined();
			expect(chat.menuPrompt).toBeUndefined();
			await click(h, cancel, prompt.id);
			expect(h.adapter.sent.at(-1)).toBe(t("en", "panel.stale"));
			h.faux.setResponses([fauxText("ordinary reply")]);
			await h.deliver("hello");
			expect(await h.adapter.next("ordinary reply")).toContain("ordinary reply");
			expect(install).not.toHaveBeenCalled();
		},
	);

	it("rejects competing starters without replacing the package question or a newer draft", async () => {
		const h = await createHarness();
		const install = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue();
		await h.press("pkg:add");
		const chat = await chatOf(h);
		const waiting = chat.pendingPrompt;
		const cancel = button(h, "set:cancel:");
		for (const starter of ["pkg:add", "pvd:add", "pvd:login", "pvd:logout"]) {
			await h.press(starter);
			expect(h.adapter.sent.at(-1)).toBe(t("en", "panel.flowBusy"));
			expect(chat.pendingPrompt).toBe(waiting);
		}
		await h.deliver("/cancel");
		expect(button(h, "pkg:add")).toBeDefined();
		await h.press("pvd:add");
		const fresh = button(h, "set:cancel:");
		await h.press(cancel.data);
		await h.deliver("currentdraft");
		expect(h.adapter.edits.at(-1)).toBe(t("en", "wizard.baseUrl"));
		expect(button(h, "set:cancel:").data).toBe(fresh.data);
		expect(install).not.toHaveBeenCalled();
	});

	it("does not install a late source answer after its request was cancelled", async () => {
		const h = await createHarness();
		const chat = await chatOf(h);
		const gate = Promise.withResolvers<void>();
		const ask = chat.ask.bind(chat);
		vi.spyOn(chat, "ask").mockImplementationOnce(async (question) => {
			const answer = await ask(question);
			await gate.promise;
			return answer;
		});
		const install = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockResolvedValue();
		await h.press("pkg:add");
		await h.deliver("obsolete-package");
		await h.deliver("/cancel");
		await h.press("pkg:add");
		const fresh = chat.pendingPrompt;
		expect(fresh?.question).toBe(t("en", "pkg.askSource"));
		gate.resolve();
		await h.settle();
		expect(install).not.toHaveBeenCalled();
		expect(chat.pendingPrompt).toBe(fresh);
		await h.deliver("/cancel");
	});

	it("retires cancellation before the installer starts, without promising to undo it", async () => {
		const h = await createHarness();
		const chat = await chatOf(h);
		const gate = Promise.withResolvers<void>();
		const clear = vi.spyOn(h.adapter, "editMarkup");
		const install = vi.spyOn(DefaultPackageManager.prototype, "installAndPersist").mockImplementation(() => {
			expect(chat.menuPrompt).toBeUndefined();
			expect(chat.pendingPrompt).toBeUndefined();
			return gate.promise;
		});
		vi.spyOn(chat.session, "reload").mockResolvedValue();
		await h.press("pkg:add", "packages");
		const question = h.adapter.panelSends.at(-1)!.id;
		const old = button(h, "set:cancel:");
		await h.deliver("  example-package  ");
		expect(install).toHaveBeenCalledWith("example-package");
		expect(clear).toHaveBeenCalledWith("42", { id: question }, []);
		await h.press(old.data, question);
		await h.deliver("/cancel");
		await h.press("pkg:add");
		expect(h.adapter.sent.at(-1)).toBe(t("en", "panel.flowBusy"));
		expect(h.adapter.sent).not.toContain(t("en", "wizard.cancelled"));
		await h.press("nav:sys", "packages");
		await h.press("pkg:add");
		expect(h.adapter.sent.at(-1)).toBe(t("en", "panel.flowBusy"));
		const navigated = h.adapter.edits.length;
		gate.resolve();
		await h.settle();
		expect(h.adapter.sent).toContain(t("en", "pkg.installed", { source: "example-package" }));
		expect(h.adapter.edits).toHaveLength(navigated);
		expect(install).toHaveBeenCalledTimes(1);
	});
});

describe("OAuth menu lifetimes", () => {
	it("scopes every choice, Back and Cancel; late logout validation cannot mutate the next picker", async () => {
		const h = await createHarness();
		const list = vi
			.spyOn(ModelRuntime.prototype, "listCredentials")
			.mockResolvedValue([{ providerId: "google", type: "oauth" }]);
		const logout = vi.spyOn(ModelRuntime.prototype, "logout").mockResolvedValue();
		const login = vi.spyOn(ModelRuntime.prototype, "login").mockRejectedValue(new Error("unexpected login"));
		await h.press("pvd:login");
		const oldLogin = button(h, "pvd:oauth:google:");
		const oldBack = button(h, "pvd:back:");
		await h.press(button(h, "set:cancel:").data);
		expect(button(h, "pvd:login")).toBeDefined();
		await h.press("pvd:logout");
		const oldOut = button(h, "pvd:out:google:");
		const cancel = button(h, "set:cancel:");
		const check = Promise.withResolvers<void>();
		list.mockImplementationOnce(async () => {
			await check.promise;
			return [{ providerId: "google", type: "oauth" }];
		});
		await h.press(oldOut.data);
		await h.press(cancel.data);
		await h.press("pvd:logout");
		const current = button(h, "pvd:out:google:");
		check.resolve();
		await h.settle();
		for (const stale of [
			oldBack.data,
			oldLogin.data,
			oldOut.data,
			cancel.data,
			"pvd:oauth:google",
			"pvd:out:google",
		]) {
			await h.press(stale);
			expect(h.adapter.sent.at(-1)).toBe(t("en", "panel.stale"));
		}
		expect(logout).not.toHaveBeenCalled();
		expect(login).not.toHaveBeenCalled();
		await h.press(current.data);
		await h.press(current.data);
		expect(logout).toHaveBeenCalledTimes(1);
		expect(logout).toHaveBeenCalledWith("google");
	});

	it.each([
		{ channel: "telegram", mode: "manual", exit: "click" },
		{ channel: "qq", mode: "device", exit: "click" },
		{ channel: "qq", mode: "manual", exit: "slash" },
	] as const)(
		"$channel $mode login can be cancelled by $exit and immediately restarted",
		async ({ channel, mode, exit }) => {
			const h = await createHarness({ channel });
			const chat = await chatOf(h);
			const late = Promise.withResolvers<void>();
			let first!: AuthInteraction;
			const creds = { type: "oauth", access: "test", refresh: "test", expires: 0 } as const;
			const login = vi
				.spyOn(ModelRuntime.prototype, "login")
				.mockImplementationOnce(async (_provider, _type, interaction) => {
					first = interaction;
					if (mode === "device")
						interaction.notify({
							type: "device_code",
							verificationUri: "https://example.invalid/device",
							userCode: "ABC123",
						});
					else {
						interaction.notify({ type: "auth_url", url: "https://example.invalid/auth" });
						await interaction
							.prompt({ type: "manual_code", message: "Paste the mock redirect" })
							.catch(() => undefined);
					}
					await late.promise; // Simulate a provider reporting success even after explicit abort.
					return creds;
				})
				.mockImplementationOnce(async (_provider, _type, interaction) => {
					await interaction.prompt({ type: "text", message: "Second login question" });
					return creds;
				});
			await h.deliver("/settings pvd");
			await click(h, button(h, "pvd:login"));
			const provider = button(h, "pvd:oauth:anthropic:");
			const pickerCancel = button(h, "set:cancel:");
			await click(h, provider, "panel", "oauth-click");
			const prompt = h.adapter.panelSends.at(-1)!;
			const cancel = button(h, "set:cancel:");
			expect(cancel.data).not.toBe(pickerCancel.data);
			expect(h.adapter.sent.at(-1)).toContain(mode === "device" ? "ABC123" : "Paste the mock redirect");
			if (mode === "manual") {
				const url = h.adapter.panelSends.at(-2)!;
				expect(h.adapter.panels.get(url.id)?.flat()).toContainEqual(cancel);
			} else expect(chat.pendingPrompt).toBeUndefined();
			if (channel === "qq") expect(prompt.replyTo).toBe("oauth-click");
			await click(h, pickerCancel); // The expired picker cannot abort an actual login.
			expect(first.signal?.aborted).toBe(false);
			if (exit === "click") await click(h, cancel, prompt.id, "cancel-login");
			else await h.deliver("/cancel", "42", "cancel-login");
			expect(first.signal?.aborted).toBe(true);
			expect(chat.pendingPrompt).toBeUndefined();
			expect(h.adapter.sent).toContain(t("en", "login.cancelled"));
			if (channel === "qq") expect(h.adapter.panelSends.at(-1)?.replyTo).toBe("cancel-login");
			await click(h, button(h, "pvd:login"));
			await click(h, button(h, "pvd:oauth:anthropic:"));
			const second = chat.pendingPrompt;
			expect(second?.question).toBe("Second login question");
			late.resolve();
			await h.settle();
			first.notify({ type: "info", message: "obsolete callback" });
			await click(h, cancel, prompt.id);
			await click(h, provider);
			expect(chat.pendingPrompt).toBe(second);
			expect(h.adapter.sent).not.toContain("obsolete callback");
			expect(h.adapter.sent).not.toContain(t("en", "login.done", { provider: "anthropic" }));
			await h.deliver("mock answer");
			expect(h.adapter.sent).toContain(t("en", "login.done", { provider: "anthropic" }));
			expect(login).toHaveBeenCalledTimes(2);
		},
	);
});
