import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import { t } from "../i18n/index.ts";
import type { CommandContext } from "./index.ts";

/** Providers a chat can sign in to; all of them use OAuth. */
const OAUTH_PROVIDERS = ["anthropic", "openai", "openai-codex", "xai"] as const;

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

/** `/login [provider]`: list the providers, or start the OAuth flow for one. */
export async function loginCommand(context: CommandContext, args: string): Promise<void> {
	const chat = context.chat;
	const lang = chat.lang;
	const provider = args.trim();
	if (!provider) {
		const list = OAUTH_PROVIDERS.map((name) => `- ${name}`).join("\n");
		await chat.sendPlain(t(lang, "login.choose", { list }));
		return;
	}
	if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
		await chat.sendPlain(t(lang, "login.unknown", { provider }));
		return;
	}

	const interaction = chatInteraction(context);
	try {
		await context.modelRuntime.login(provider, "oauth" satisfies AuthType, interaction);
		await chat.say("login.done", { provider });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const timedOut = interaction.signal?.aborted === true && message !== "Login cancelled";
		await chat.sendPlain(t(lang, timedOut ? "login.timeout" : "login.cancelled"));
	} finally {
		chat.setLoginAbort(undefined);
	}
}

/** `/logout <provider>`: forget a stored credential. */
export async function logoutCommand(context: CommandContext, args: string): Promise<void> {
	const provider = args.trim();
	if (!provider) {
		await context.chat.sendPlain(`Usage: /logout <${OAUTH_PROVIDERS.join("|")}>`);
		return;
	}
	await context.modelRuntime.logout(provider);
	await context.chat.sendPlain(`✅ ${provider}`);
}
