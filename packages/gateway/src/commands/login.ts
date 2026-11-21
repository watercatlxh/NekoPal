import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import { t } from "../i18n/index.ts";
import { LOGIN_PROVIDER_IDS } from "../panel/router.ts";
import type { CommandContext } from "./index.ts";

const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * A chat-backed `AuthInteraction`: links and codes are sent as messages, and prompts read the
 * user's next message. The flow fails after ten minutes or when `/cancel` answers a prompt.
 */
export function chatInteraction(context: CommandContext): AuthInteraction {
	const chat = context.chat;
	const lang = chat.lang;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
	timeout.unref();
	// Any prompt answer cancels a pending login through /cancel.
	chat.setLoginAbort(() => controller.abort());

	const notify = (event: AuthEvent): void => {
		if (event.type === "auth_url") {
			void chat.sendPlain(
				`${t(lang, "login.openUrl", { url: event.url })}\n${event.instructions ?? ""}\n${t(lang, "login.pasteWarning")}`,
			);
			return;
		}
		if (event.type === "device_code") {
			void chat.sendPlain(
				`${t(lang, "login.deviceCode", { url: event.verificationUri, code: event.userCode })}\n${t(lang, "login.pasteWarning")}`,
			);
			return;
		}
		if (event.type === "info") void chat.sendPlain(event.message);
		if (event.type === "progress") void chat.sendPlain(event.message);
	};

	const prompt = async (request: AuthPrompt): Promise<string> => {
		if (request.type === "select") {
			const list = request.options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
			const answer = await chat.ask(`${request.message}\n${list}`);
			if (answer === undefined) throw new Error("Login cancelled");
			const index = Number(answer.trim());
			const chosen =
				Number.isInteger(index) && index >= 1 && index <= request.options.length
					? request.options[index - 1]
					: request.options.find((option) => option.id === answer.trim());
			return chosen?.id ?? answer;
		}
		const answer = await chat.ask(request.message);
		if (answer === undefined) throw new Error("Login cancelled");
		return answer;
	};

	return {
		signal: controller.signal,
		notify,
		prompt,
	};
}

/** Chats with a login in flight, so a second press cannot stack a zombie flow on the first. */
const activeLogins = new Set<string>();

/** `/login [provider]`: list the providers, or start the OAuth flow for one. */
export async function loginCommand(context: CommandContext, args: string): Promise<void> {
	const chat = context.chat;
	const lang = chat.lang;
	const key = `${chat.adapter.name}-${chat.chatId}`;
	if (activeLogins.has(key)) {
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

	const interaction = chatInteraction(context);
	activeLogins.add(key);
	try {
		await context.modelRuntime.login(provider, "oauth" satisfies AuthType, interaction);
		await chat.say("login.done", { provider });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// A user abort is "cancelled"; the timer firing is "timed out"; anything else carries
		// the provider's own message, so a failed exchange is not mistaken for a cancellation.
		const cancelled = message === "Login cancelled" || message === "login cancelled";
		const timedOut = !cancelled && interaction.signal?.aborted === true;
		await chat.sendPlain(
			cancelled
				? t(lang, "login.cancelled")
				: timedOut
					? t(lang, "login.timeout")
					: t(lang, "login.failed", { message }),
		);
	} finally {
		activeLogins.delete(key);
		chat.setLoginAbort(undefined);
	}
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
