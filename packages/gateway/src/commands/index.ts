import type { AgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { findExactModelReferenceMatch, resolveModelReference } from "@earendil-works/pi-coding-agent";
import type { Inbound, Lang, SentHandle } from "../channel/types.ts";
import type { ChatContext } from "../chat/context.ts";
import type { ChatRegistry } from "../chat/registry.ts";
import { parseSchedule } from "../cron/schedule.ts";
import type { JobStore } from "../cron/store.ts";
import { t } from "../i18n/index.ts";
import { logError } from "../log.ts";
import type { MemoryOperation, MemoryStore, PendingStore } from "../memory/store.ts";

export interface CommandContext {
	chat: ChatContext;
	message: Inbound;
	/** Present the command result through the panel action, not a second panel. */
	panelOrigin?: { handle?: SentHandle };
	registry: ChatRegistry;
	memory: MemoryStore;
	pending: PendingStore;
	jobs: JobStore;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	agentDir: string;
	/** Applies approved skill operations; skills live in ~/.nekopal/skills. */
	skills: { apply(operations: MemoryOperation[]): void };
	/** Persist a chat's language and update the open chat. */
	setLang(lang: Lang): void;
	startedAt: number;
	version: string;
	enabledChannels: string[];
	/** The QQ proactive-quota line, when the QQ channel is running. */
	qqQuota?: () => string | undefined;
}

export interface Command {
	description: (lang: Lang) => string;
	run(context: CommandContext, args: string): Promise<void>;
}

/** Every `/command`, keyed by name without the slash. */
export type CommandTable = Map<string, Command>;

const DESCRIPTIONS: Record<string, (lang: Lang) => string> = {
	help: (lang) => t(lang, "cmd.help.desc"),
	status: (lang) => t(lang, "cmd.status.desc"),
	settings: (lang) => t(lang, "cmd.settings.desc"),
	new: (lang) => t(lang, "cmd.new.desc"),
	sessions: (lang) => t(lang, "cmd.sessions.desc"),
	resume: (lang) => t(lang, "cmd.resume.desc"),
	stop: (lang) => t(lang, "cmd.stop.desc"),
	model: (lang) => t(lang, "cmd.model.desc"),
	memory: (lang) => t(lang, "cmd.memory.desc"),
	jobs: (lang) => t(lang, "cmd.jobs.desc"),
	packages: (lang) => t(lang, "cmd.packages.desc"),
	cancel: (lang) => t(lang, "cmd.cancel.desc"),
};

/** `/name — description`, the line `/help` prints for a command. */
export function describe(name: string, lang: Lang): string {
	const description = DESCRIPTIONS[name];
	return `/${name} — ${description ? description(lang) : ""}`;
}

/** A command's one-line description, without the name. */
export function descriptionOf(name: string, lang: Lang): string {
	const description = DESCRIPTIONS[name];
	return description ? description(lang) : "";
}

export function parseCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return undefined;
	return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

export function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m${seconds % 60}s`;
	return `${seconds}s`;
}

/** Resolve `provider/id` (with optional thinking suffix) against the runtime's models. */
export function resolveModel(session: AgentSession, text: string) {
	const runtime = session.modelRuntime;
	const result = resolveModelReference(
		{ text, thinkingSuffix: "lenient", fuzzy: true },
		runtime.getModels(),
		(provider) => runtime.hasConfiguredAuth(provider),
	);
	return result.status === "resolved" ? result.model : findExactModelReferenceMatch(text, runtime.getModels());
}

export { logError, parseSchedule, t };
