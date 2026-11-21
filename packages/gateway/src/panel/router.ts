/**
 * The panel's entry point: a snapshot of the chat, the page renderer, and the command a press maps to.
 *
 * The router reuses the existing command table instead of re-implementing each action, so a button
 * press and a typed command can never diverge.
 */

import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { CommandContext } from "../commands/index.ts";
import { formatPending, storedEntries } from "../commands/memory.ts";
import { decode, type PanelPage } from "./encode.ts";
import { type PanelSnapshot, type PanelView, type ProviderView, renderPage } from "./model.ts";
import { listCustomProviders, modelsJsonPath } from "./models-json.ts";

/** The providers a chat can sign in to; every one of them signs in with OAuth. */
export const LOGIN_PROVIDERS = {
	anthropic: "oauth",
	openai: "oauth",
	"openai-codex": "oauth",
	xai: "oauth",
	google: "oauth",
} as const;

/** The provider ids a chat can sign in to. */
export const LOGIN_PROVIDER_IDS = Object.keys(LOGIN_PROVIDERS) as readonly (keyof typeof LOGIN_PROVIDERS)[];

/** Collect everything a page renders from. */
export function snapshot(context: CommandContext): PanelSnapshot {
	const chat = context.chat;
	const runtime = chat.session.modelRuntime;
	const stats = chat.session.getSessionStats();
	const model = chat.session.model;
	const settings = context.settingsManager.getNekoPal();
	const stored = storedEntries(context.memory);
	const pendingEntries = context.pending.list();
	// Models grouped per configured provider, untruncated: the model page pages through them.
	const modelsByProvider = new Map<string, string[]>();
	for (const candidate of runtime.getModels()) {
		if (!runtime.hasConfiguredAuth(candidate.provider)) continue;
		const list = modelsByProvider.get(candidate.provider) ?? [];
		list.push(candidate.id);
		modelsByProvider.set(candidate.provider, list);
	}
	const custom = new Set(listCustomProviders(context.agentDir));
	const manager = new DefaultPackageManager({
		cwd: chat.workspace,
		agentDir: context.agentDir,
		settingsManager: context.settingsManager,
	});
	return {
		lang: chat.lang,
		version: context.version,
		model: model ? `${model.provider}/${model.id}` : "none",
		thinking: chat.session.thinkingLevel,
		uptimeMs: Date.now() - context.startedAt,
		sessionId: stats.sessionId,
		messages: stats.totalMessages,
		contextTokens: stats.tokens.total,
		contextWindow: model?.contextWindow ?? 0,
		cost: stats.cost,
		tokens: {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
		},
		chats: context.registry.size,
		running: context.registry.running,
		memoryUsage: context.memory.usage(),
		memoryBudget: {
			memory: settings.memory?.memoryChars ?? 1375,
			user: settings.memory?.userChars ?? 1375,
		},
		stored,
		pending: pendingEntries.length,
		pendingLines: formatPending(pendingEntries),
		jobs: context.jobs.load(),
		modelsByProvider: [...modelsByProvider.entries()].map(([id, models]) => ({ id, models })),
		providers: providerViews(context, runtime, custom),
		packages: manager.listConfiguredPackages().map((entry) => entry.source),
		channels: context.enabledChannels,
		qqQuota: context.qqQuota?.(),
	};
}

/** Every provider the runtime knows, with how it is configured. */
function providerViews(
	context: CommandContext,
	runtime: CommandContext["chat"]["session"]["modelRuntime"],
	custom: ReadonlySet<string>,
): ProviderView[] {
	const views: ProviderView[] = [];
	for (const provider of runtime.getProviders()) {
		const status = runtime.getProviderAuthStatus(provider.id);
		views.push({
			id: provider.id,
			configured: status.configured,
			...(status.source === undefined ? {} : { source: status.source }),
			custom: custom.has(provider.id),
		});
	}
	void context;
	return views;
}

/** Render one page from a fresh snapshot; `arg` narrows a page (a provider, a page number). */
export function view(context: CommandContext, page: PanelPage, arg = ""): PanelView {
	return renderPage(page, snapshot(context), arg);
}

/** The command a press maps to, or undefined when it only navigates or opens a wizard. */
export function commandFor(data: string): string | undefined {
	const press = decode(data);
	if (!press || press.verb === "nav") return undefined;
	const { page, verb, arg } = press;
	switch (page) {
		case "set":
			if (verb === "lang") return `/settings lang ${arg}`;
			return undefined;
		case "mdl":
			// The arg is `provider:index`, resolved to the model id the page listed there,
			// so a Telegram callback never has to fit a long model id in 64 bytes.
			if (verb === "set") return `/model mdl:${arg}`;
			return undefined;
		case "ses":
			if (verb === "new") return "/new";
			if (verb === "list") return "/sessions";
			if (verb === "stop") return "/stop";
			if (verb === "resume") return `/resume ${arg}`;
			if (verb === "page") return `/settings page ${arg}`;
			return undefined;
		case "pkg":
			if (verb === "rm") return `/packages rm ${arg}`;
			return undefined;
		case "mem":
			if (verb === "ok") return "/memory approve all";
			if (verb === "no") return "/memory reject all";
			if (verb === "fg") return `/memory forget ${arg}`;
			return undefined;
		case "job":
			if (verb === "pause" || verb === "resume" || verb === "rm") return `/jobs ${verb} ${arg}`;
			return undefined;
		case "pvd":
			if (verb === "rm") return `/settings pvd rm ${arg}`;
			return undefined;
	}
}

/** The page a press shows next: its own page, so a command's result stays in view. */
export function pageFor(data: string): PanelPage | undefined {
	return decode(data)?.page;
}

/** `models.json` for the chat's data directory, so the wizard and the daemon agree on one path. */
export function modelsPath(context: CommandContext): string {
	return modelsJsonPath(context.agentDir);
}
