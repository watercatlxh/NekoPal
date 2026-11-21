/**
 * The panel's entry point: snapshot current state and map presses to validated commands.
 */

import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { CommandContext } from "../commands/index.ts";
import { formatPending, storedEntries } from "../commands/memory.ts";
import { type PanelPage, type PanelPress, panelKey, pendingKey } from "./encode.ts";
import { type PanelSnapshot, type PanelView, type ProviderView, renderPage } from "./model.ts";
import { listCustomProviders } from "./models-json.ts";

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
	for (const candidate of runtime.getAvailableSnapshot()) {
		const list = modelsByProvider.get(candidate.provider) ?? [];
		list.push(candidate.id);
		modelsByProvider.set(candidate.provider, list);
	}
	let custom: Set<string>;
	let configReadFailed = false;
	try {
		custom = new Set(listCustomProviders(context.agentDir));
	} catch {
		custom = new Set();
		configReadFailed = true;
	}
	const manager = new DefaultPackageManager({
		cwd: chat.workspace,
		agentDir: context.agentDir,
		settingsManager: context.settingsManager,
	});
	return {
		lang: chat.lang,
		telegramReplyFormat: chat.adapter.name === "telegram" ? chat.telegramReplyFormat : undefined,
		version: context.version,
		model: model ? `${model.provider}/${model.id}` : "none",
		thinking: chat.session.thinkingLevel,
		thinkingOptions: model?.reasoning
			? { modelKey: panelKey([model.provider, model.id]), levels: chat.session.getAvailableThinkingLevels() }
			: undefined,
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
		pendingKey: pendingKey(pendingEntries.map((entry) => entry.id)),
		jobs: context.jobs.load(),
		modelsByProvider: [...modelsByProvider.entries()].map(([id, models]) => ({ id, models })),
		providers: providerViews(runtime, custom),
		configReadFailed,
		packages: manager.listConfiguredPackages().map((entry) => entry.source),
		channels: context.enabledChannels,
		qqQuota: context.qqQuota?.(),
	};
}

/** Every provider the runtime knows, with how it is configured. */
function providerViews(
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
	for (const id of custom) {
		if (!views.some((provider) => provider.id === id)) views.push({ id, configured: false, custom: true });
	}
	return views;
}

/** Render one page from a fresh snapshot; `arg` narrows a page (a provider, a page number). */
export function view(context: CommandContext, page: PanelPage, arg = "", modelProvider?: string): PanelView {
	return renderPage(page, snapshot(context), arg, modelProvider);
}

/** Simple actions with no collection identity can reuse the typed command table. */
export function commandFor({ page, verb, arg }: PanelPress): string | undefined {
	if (page === "sys" && verb === "lang" && (arg === "en" || arg === "zh")) return `/settings lang ${arg}`;
	if (page === "sys" && verb === "fmt" && (arg === "rich" || arg === "mdv2")) return `/settings format ${arg}`;
	if (page === "ses" && arg === "" && (verb === "new" || verb === "stop")) return `/${verb}`;
	return undefined;
}
