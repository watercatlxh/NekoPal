import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ChannelName } from "../channel/types.ts";
import type { MemoryStore } from "../memory/store.ts";

const CHANNEL_PROMPTS: Record<ChannelName, string> = {
	telegram: "Telegram",
	qq: "QQ",
};

function channelSection(channel: ChannelName): string {
	return `You are talking with the user through ${CHANNEL_PROMPTS[channel]}; replies may be read on a phone, hours later.
- Write standard Markdown (bold, italic, inline code, fenced code, links, lists, quotes). The gateway converts it for the platform; never add platform-specific escaping.
- Avoid tables and deep headings; prefer short paragraphs.
- Put long outputs (logs, generated files) in a file and deliver it with the send tool.`;
}

function cronSection(name: string): string {
	return `This run was triggered by the scheduled job "${name}". The user is not watching; complete the task autonomously. Your final reply is delivered to the user as the job result.`;
}

/** Values of the configured secrets, so tool output can mask them. */
export interface SecretRedactor {
	secrets(): string[];
}

function redact(text: string, secrets: string[]): string {
	let result = text;
	for (const secret of secrets) {
		if (secret.length >= 8) result = result.split(secret).join("***");
	}
	return result;
}

export interface NekoPalExtensionOptions {
	channel: ChannelName;
	/** `SOUL.md` to inject, when the host keeps one; absent means no soul section. */
	soulPath?: string;
	/** Reads SOUL.md and the memory files once per session, so a mid-session edit does not shift the cached prompt. */
	memory: MemoryStore;
	redactor: SecretRedactor;
	/** Set for a scheduled run: the job name, which replaces the memory section with the cron section. */
	cron?: { name: string };
}

/**
 * The NekoPal extension: injects the persona, memory, channel and cron prompt sections, and masks
 * secrets in tool output.
 *
 * Sections are written from `before_agent_start`, the only hook that can change the system prompt
 * sections. Every run of one session writes the same text, so the prompt prefix stays cacheable.
 */
export function nekopalExtension(options: NekoPalExtensionOptions): InlineExtension {
	const factory = (pi: ExtensionAPI): void => {
		let soulText = "";
		let memoryText = "";

		pi.on("session_start", () => {
			const path = options.soulPath;
			soulText = path && existsSync(path) ? readFileSync(path, "utf-8").trim() : "";
			memoryText = options.memory.formatForPrompt();
		});

		pi.on("before_agent_start", (event) => {
			if (soulText) event.systemPromptOptions.sections.soul = soulText;
			if (memoryText && !options.cron) event.systemPromptOptions.sections.memory = memoryText;
			event.systemPromptOptions.sections.channel = channelSection(options.channel);
			if (options.cron) event.systemPromptOptions.sections.cron = cronSection(options.cron.name);
		});

		pi.on("tool_result", (event) => {
			const secrets = options.redactor.secrets();
			if (secrets.length === 0) return;
			for (const block of event.content) {
				if (block.type === "text") block.text = redact(block.text, secrets);
			}
		});
	};

	return { name: "nekopal", factory, hidden: true, builtin: true };
}
