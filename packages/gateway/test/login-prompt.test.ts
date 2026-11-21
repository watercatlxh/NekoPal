import { getEventListeners } from "node:events";
import type { Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelName, SentHandle } from "../src/channel/types.ts";
import { ChatContext, type ChatContextOptions } from "../src/chat/context.ts";
import type { CommandContext } from "../src/commands/index.ts";
import { chatInteraction, loginCommand } from "../src/commands/login.ts";
import { FakeAdapter } from "./support/harness.ts";

// No agent session is started: only the real chat prompt and command lifecycles are exercised.
function fixture(channel: ChannelName = "telegram") {
	const adapter = new FakeAdapter(channel);
	const notice = vi.fn<(question: string) => Promise<void>>();
	const options: Pick<ChatContextOptions, "adapter" | "chatId" | "lang" | "onPromptNotice"> = {
		adapter,
		chatId: "42",
		lang: "en",
		onPromptNotice: notice,
	};
	const chat = new ChatContext(options as ChatContextOptions);
	notice.mockImplementation((text) => chat.sendMenuNotice(text, chat.pendingPrompt));
	const login = vi.fn<ModelRuntime["login"]>();
	const modelRuntime: Pick<ModelRuntime, "login"> = { login };
	const context = { chat, modelRuntime } as CommandContext;
	return { chat, notice, login, adapter, context };
}

function scope(id: string) {
	const data = `set:cancel:${id}`;
	return { id, keyboard: [[{ label: "Cancel", data, command: `/settings act ${data}` }]] };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("ChatContext.ask", () => {
	it("does not publish an already-aborted question or replace the live question", async () => {
		const { chat, notice } = fixture();
		const controller = new AbortController();
		const first = chat.ask("first?", controller.signal);
		await expect(chat.ask("obsolete?", AbortSignal.abort())).resolves.toBeUndefined();
		expect(notice.mock.calls).toEqual([["first?"]]);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
		expect(chat.answerPending("answer")).toBe(true);
		await expect(first).resolves.toBe("answer");
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});

	it("removes the old listener on replacement and leaves the replacement alone on a late abort", async () => {
		vi.useFakeTimers();
		const { chat } = fixture();
		const old = new AbortController();
		const current = new AbortController();
		const first = chat.ask("first?", old.signal);
		const second = chat.ask("second?", current.signal);
		await expect(first).resolves.toBeUndefined();
		expect(getEventListeners(old.signal, "abort")).toHaveLength(0);
		old.abort();
		expect(chat.pendingPrompt?.question).toBe("second?");
		expect(vi.getTimerCount()).toBe(1);
		chat.cancelPending();
		await expect(second).resolves.toBeUndefined();
		expect(getEventListeners(current.signal, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("expires unanswered questions and detaches the listener", async () => {
		vi.useFakeTimers();
		const { chat } = fixture();
		const controller = new AbortController();
		const pending = chat.ask("code?", controller.signal);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await expect(pending).resolves.toBeUndefined();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(chat.answerPending("hello")).toBe(false);
	});

	it.each(["answer", "abort"] as const)("removes only the question keyboard on %s", async (end) => {
		const { chat, notice, adapter } = fixture();
		const clear = vi.spyOn(adapter, "editMarkup");
		const flow = scope("flow");
		const parent = await chat.sendRich("Providers", undefined, flow.keyboard);
		chat.menuPrompt = flow;
		await chat.sendMenuNotice("Authorization URL");
		const signal = new AbortController();
		const answer = chat.ask("Code?", signal.signal);
		await notice.mock.results[0].value;
		expect(adapter.sent).toEqual(["Providers", "Authorization URL", "Code?"]);
		expect(adapter.keyboards).toEqual([flow.keyboard, flow.keyboard, flow.keyboard]);
		const [, auth, question] = adapter.panelSends;
		if (end === "answer") chat.answerPending("123");
		else signal.abort();
		await expect(answer).resolves.toBe(end === "answer" ? "123" : undefined);
		expect(clear.mock.calls).toEqual([[chat.chatId, { id: question.id }, []]]);
		chat.menuPrompt = undefined;
		expect(clear).toHaveBeenLastCalledWith(chat.chatId, { id: auth.id }, []);
		expect(clear).not.toHaveBeenCalledWith(chat.chatId, parent, []);
	});

	it("retires a late question send without editing the new flow", async () => {
		const { chat, adapter, notice } = fixture();
		const delayed = Promise.withResolvers<SentHandle>();
		vi.spyOn(adapter, "sendRich").mockReturnValueOnce(delayed.promise);
		const clear = vi.spyOn(adapter, "editMarkup");
		chat.menuPrompt = scope("old");
		const old = chat.ask("First?");
		chat.cancelPending();
		await expect(old).resolves.toBeUndefined();
		chat.menuPrompt = scope("new");
		const current = chat.ask("Second?");
		await notice.mock.results[1].value;
		delayed.resolve({ id: "late-old" });
		await notice.mock.results[0].value;
		expect(clear.mock.calls).toEqual([[chat.chatId, { id: "late-old" }, []]]);
		expect(chat.answerPending("new answer")).toBe(true);
		await expect(current).resolves.toBe("new answer");
	});
});

describe("chat login", () => {
	it("sends QQ authorization notices with their flow ID and the current passive reply reference", async () => {
		const { chat, adapter, context } = fixture("qq");
		const clear = vi.spyOn(adapter, "editMarkup");
		const send = vi.spyOn(chat, "sendMenuNotice");
		const flow = scope("device");
		chat.menuPrompt = flow;
		const interaction = chatInteraction(context, new AbortController().signal);
		chat.replyTo = "press";
		interaction.notify({ type: "device_code", verificationUri: "https://device.test", userCode: "ABC" });
		chat.replyTo = "answer";
		interaction.notify({ type: "auth_url", url: "https://auth.test", instructions: "Read before continuing" });
		interaction.notify({ type: "progress", message: "redirect error: secret" });
		await Promise.all(send.mock.results.map((result) => result.value));
		expect(adapter.sent).toHaveLength(2);
		expect(adapter.sent[0]).toContain("ABC");
		expect(adapter.sent[1]).toContain("Read before continuing");
		expect(adapter.keyboards).toEqual([flow.keyboard, flow.keyboard]);
		expect(adapter.panelSends.map((send) => send.replyTo)).toEqual(["press", "answer"]);
		chat.menuPrompt = scope("other");
		interaction.notify({ type: "auth_url", url: "https://obsolete.test" });
		expect(clear).not.toHaveBeenCalled();
		expect(adapter.sent).toHaveLength(2);
	});

	it("does not let a cancelled provider publish into a new login, even when it ignores abort", async () => {
		const { chat, context, login, adapter } = fixture();
		const late = Promise.withResolvers<Credential>();
		login.mockReturnValueOnce(late.promise);
		chat.menuPrompt = scope("first");
		const first = loginCommand(context, "google");
		chat.menuPrompt = undefined;
		chat.cancelPending();
		chat.menuPrompt = scope("second");
		login.mockImplementationOnce(async (_provider, _type, interaction) => {
			await interaction.prompt({ type: "text", message: "Second login?" });
			return { type: "oauth", access: "test", refresh: "test", expires: 0 };
		});
		const second = loginCommand(context, "google");
		await first;
		late.resolve({ type: "oauth", access: "obsolete", refresh: "obsolete", expires: 0 });
		await late.promise;
		expect(adapter.sent).toEqual(["Second login?"]);
		expect(chat.answerPending("yes")).toBe(true);
		await second;
		expect(adapter.sent).toHaveLength(2);
		expect(adapter.sent[1]).toContain("Signed in to google");
	});

	it("retires the manual-code prompt when the callback wins, not the whole login", async () => {
		vi.useFakeTimers();
		const { chat, context } = fixture();
		const flow = new AbortController();
		const manual = new AbortController();
		const interaction = chatInteraction(context, flow.signal);
		const pending = interaction.prompt({ type: "manual_code", message: "redirect?", signal: manual.signal });
		manual.abort();
		expect(chat.answerPending("ordinary conversation")).toBe(false);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(flow.signal.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["cancel", "timeout"] as const)(
		"reports %s by source even if the provider masks the reason",
		async (stop) => {
			vi.useFakeTimers();
			const { chat, context, login, adapter } = fixture();
			const register = vi.spyOn(chat, "setLoginAbort");
			login.mockImplementationOnce(async (_id, _type, interaction) => {
				try {
					await interaction.prompt({ type: "text", message: "code?" });
				} catch {
					throw new Error("Login cancelled");
				}
				throw new Error("Unexpected prompt answer");
			});
			const done = loginCommand(context, "google");
			await loginCommand(context, "google");
			expect(login).toHaveBeenCalledTimes(1);
			expect(adapter.sent.at(-1)).toContain("already in progress");
			if (stop === "cancel") chat.cancelPending();
			else await vi.advanceTimersByTimeAsync(10 * 60_000);
			await done;
			expect(adapter.sent.at(-1)).toBe(stop === "cancel" ? "Login cancelled" : "Login timed out");
			expect(register).toHaveBeenLastCalledWith(undefined);
			expect(chat.pendingPrompt).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);

			login.mockResolvedValueOnce({ type: "oauth", access: "test", refresh: "test", expires: 0 });
			await loginCommand(context, "google");
			expect(adapter.sent.at(-1)).toContain("Signed in to google");
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it.each(["Login cancelled", "redirect=https://localhost/?code=secret&state=private"])(
		"reports provider failures without classifying or echoing their text",
		async (message) => {
			vi.useFakeTimers();
			const { context, login, adapter } = fixture();
			login.mockRejectedValueOnce(new Error(message));
			await loginCommand(context, "google");
			expect(adapter.sent).toEqual(["Login failed: google"]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
