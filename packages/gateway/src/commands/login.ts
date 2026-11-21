import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import { t } from "../i18n/index.ts";
import { log } from "../log.ts";
import { LOGIN_PROVIDER_IDS } from "../panel/router.ts";
import type { CommandContext } from "./index.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** Present provider events and prompts for the lifetime of one login. */
export function chatInteraction(context: CommandContext, signal: AbortSignal): AuthInteraction {
	const chat = context.chat;
	const lang = chat.lang;
	const scopeId = chat.menuPrompt?.id;

	const notify = (event: AuthEvent): void => {
		if (signal.aborted || chat.menuPrompt?.id !== scopeId) return;
		// Only publish the actionable auth events. Free-form progress can repeat a question
		// or include provider diagnostics; questions themselves are presented by ask().
		let text: string;
		if (event.type === "auth_url") {
			text = `${t(lang, "login.openUrl", { url: event.url })}\n${event.instructions ?? ""}\n${t(lang, "login.pasteWarning")}`;
		} else if (event.type === "device_code") {
			text = `${t(lang, "login.deviceCode", { url: event.verificationUri, code: event.userCode })}\n${t(lang, "login.pasteWarning")}`;
		} else {
			return;
		}
		void chat.sendMenuNotice(text).catch(() => log("warn", "could not deliver login notice"));
	};

	const prompt = async (request: AuthPrompt): Promise<string> => {
		if (chat.menuPrompt?.id !== scopeId) throw new DOMException("Login closed", "AbortError");
		// A loopback callback may win against a manual-code prompt without cancelling the login.
		const promptSignal = request.signal ? AbortSignal.any([signal, request.signal]) : signal;
		const question =
			request.type === "select"
				? `${request.message}\n${request.options.map((option, index) => `${index + 1}. ${option.label}`).join("\n")}`
				: request.message;
		const answer = await chat.ask(question, promptSignal);
		promptSignal.throwIfAborted();
		if (answer === undefined) throw new Error("Prompt closed");
		if (request.type === "select") {
			const index = Number(answer.trim());
			const chosen =
				Number.isInteger(index) && index >= 1 && index <= request.options.length
					? request.options[index - 1]
					: request.options.find((option) => option.id === answer.trim());
			return chosen?.id ?? answer;
		}
		return answer;
	};

	return {
		signal,
		notify,
		prompt,
	};
}

/** Chats with a login in flight, so a second press cannot stack a zombie flow on the first. */
const activeLogins = new Map<string, AbortSignal>();

async function signIn(context: CommandContext, provider: string, signal: AbortSignal): Promise<string> {
	const lang = context.chat.lang;
	await context.modelRuntime.login(provider, "oauth" satisfies AuthType, chatInteraction(context, signal));
	signal.throwIfAborted();
	let result = t(lang, "login.done", { provider });
	if (provider === "google") {
		try {
			const refresh = await context.modelRuntime.refresh({ providers: [provider], signal });
			if (refresh.aborted || refresh.errors.has(provider)) result += `\n${t(lang, "model.rosterFailed")}`;
		} catch {
			result += `\n${t(lang, "model.rosterFailed")}`;
		}
	}
	return result;
}

/** `/login [provider]`: list the providers, or start the OAuth flow for one. */
export async function loginCommand(context: CommandContext, args: string): Promise<void> {
	const chat = context.chat;
	const lang = chat.lang;
	const key = `${chat.adapter.name}-${chat.chatId}`;
	const previous = activeLogins.get(key);
	if (previous && !previous.aborted) {
		await chat.sendPlain(t(lang, "login.busy"));
		return;
	}
	const provider = args.trim();
	if (!provider) {
		const list = LOGIN_PROVIDER_IDS.map((name) => `- ${name}`).join("\n");
		await chat.sendPlain(t(lang, "login.choose", { list }));
		return;
	}
	if (!LOGIN_PROVIDER_IDS.includes(provider as (typeof LOGIN_PROVIDER_IDS)[number])) {
		await chat.sendPlain(t(lang, "login.unknown", { provider }));
		return;
	}

	const controller = new AbortController();
	const { signal } = controller;
	const scopeId = chat.menuPrompt?.id;
	const timeoutReason = new DOMException("Login timed out", "TimeoutError");
	const timer = setTimeout(() => controller.abort(timeoutReason), LOGIN_TIMEOUT_MS);
	timer.unref();
	chat.setLoginAbort(() => controller.abort());
	activeLogins.set(key, signal);
	// Stop waiting even for a provider that is slow to observe its abort signal.
	const stopped = Promise.withResolvers<never>();
	const onAbort = () => stopped.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	let result: string;
	try {
		result = await Promise.race([signIn(context, provider, signal), stopped.promise]);
		signal.throwIfAborted();
	} catch {
		// Provider errors can contain redirect URLs, authorization codes or entire response bodies.
		// Only the validated provider ID is safe to include in a failure notice.
		result =
			controller.signal.reason === timeoutReason
				? t(lang, "login.timeout")
				: controller.signal.aborted
					? t(lang, "login.cancelled")
					: t(lang, "login.failed", { message: provider });
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		if (activeLogins.get(key) === signal) {
			activeLogins.delete(key);
			chat.setLoginAbort(undefined);
		}
		// Retire any outstanding provider prompts and ignore late events after the operation settles.
		controller.abort();
	}
	// A cancelled menu has already acknowledged cancellation and restored its parent.
	if (chat.menuPrompt?.id === scopeId && !activeLogins.has(key)) await chat.sendPlain(result);
}

/** `/logout <provider>`: forget a stored credential. */
export async function logoutCommand(context: CommandContext, args: string): Promise<void> {
	const provider = args.trim();
	if (!provider) {
		await context.chat.sendPlain(`Usage: /logout <${LOGIN_PROVIDER_IDS.join("|")}>`);
		return;
	}
	await context.modelRuntime.logout(provider);
	await context.chat.sendPlain(`✅ ${provider}`);
}
