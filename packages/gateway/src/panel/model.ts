/**
 * The panel pages: plain data in, message text and button rows out.
 *
 * Callback keys identify entries independently of their current position.
 */

import type { Lang, ReplyFormat } from "../channel/types.ts";
import { formatUptime } from "../commands/index.ts";
import type { StoredEntry } from "../commands/memory.ts";
import type { Job } from "../cron/store.ts";
import { t } from "../i18n/index.ts";
import { actButton, navButton, type PanelButton, type PanelPage, panelKey, runButton } from "./encode.ts";
import { API_KINDS, type ApiKind } from "./models-json.ts";

/** One provider as the panel shows it. */
export interface ProviderView {
	readonly id: string;
	readonly configured: boolean;
	/** How it is configured, when the runtime says. */
	readonly source?: string;
	/** True when the provider came from `models.json` rather than the built-in catalog. */
	readonly custom: boolean;
}

/** Everything a page renders from, captured once per render so the functions stay pure. */
export interface PanelSnapshot {
	readonly lang: Lang;
	readonly telegramReplyFormat?: ReplyFormat;
	readonly version: string;
	readonly model: string;
	readonly thinking: string;
	readonly uptimeMs: number;
	readonly sessionId: string;
	readonly messages: number;
	readonly contextTokens: number;
	readonly contextWindow: number;
	readonly cost: number;
	readonly tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	readonly chats: number;
	readonly running: number;
	readonly memoryUsage: { memory: number; user: number };
	readonly memoryBudget: { memory: number; user: number };
	readonly stored: readonly StoredEntry[];
	readonly pending: number;
	readonly pendingLines: string;
	readonly pendingKey: string;
	readonly configReadFailed?: boolean;
	readonly jobs: readonly Job[];
	/** Every configured provider's model ids, untruncated. */
	readonly modelsByProvider: readonly { id: string; models: readonly string[] }[];
	readonly providers: readonly ProviderView[];
	readonly packages: readonly string[];
	readonly channels: readonly string[];
	readonly qqQuota?: string;
}

/** One rendered page. */
export interface PanelView {
	readonly text: string;
	readonly rows: ReadonlyArray<ReadonlyArray<PanelButton>>;
}

const PER_ROW = 2;
const GRID_SIZE = 6;

export function preview(text: string, max = 240): string {
	const flat = text.replace(/\s+/g, " ");
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

export function pageSlice<T>(items: readonly T[], page: number, size = GRID_SIZE) {
	const pages = Math.max(1, Math.ceil(items.length / size));
	const current = Number.isInteger(page) && page >= 0 ? Math.min(page, pages - 1) : 0;
	const start = current * size;
	return { items: items.slice(start, start + size), current, pages, start };
}

export function pageFooter(
	lang: Lang,
	parent: PanelPage,
	current: number,
	pages: number,
	data: (page: number) => string,
) {
	const row: PanelButton[] = [];
	if (current > 0) row.push(actButton(t(lang, "panel.prev"), data(current - 1)));
	if (current + 1 < pages) row.push(actButton(t(lang, "panel.next"), data(current + 1)));
	row.push(navButton(t(lang, "panel.back"), parent));
	return row;
}

function pagedRows(
	lang: Lang,
	page: PanelPage,
	parent: PanelPage,
	slice: { current: number; pages: number },
	rows: PanelButton[][],
	fixed: PanelButton[] = [],
): PanelButton[][] {
	if (fixed.length) rows.push(fixed);
	rows.push(pageFooter(lang, parent, slice.current, slice.pages, (n) => `pg:${page}:${n}`));
	return rows;
}

function pageTitle(title: string, slice: { current: number; pages: number }): string {
	return slice.pages > 1 ? `${title} (${slice.current + 1}/${slice.pages})` : title;
}

/** Lay `buttons` out in rows of `PER_ROW`. */
function grid(buttons: readonly PanelButton[]): PanelButton[][] {
	const rows: PanelButton[][] = [];
	for (let index = 0; index < buttons.length; index += PER_ROW) rows.push(buttons.slice(index, index + PER_ROW));
	return rows;
}

/** `page`'s buttons, with a back row appended unless it is the settings root. */
function withBack(page: PanelPage, lang: Lang, buttons: readonly PanelButton[]): PanelButton[][] {
	const rows = grid(buttons);
	if (page !== "set") rows.push([navButton(t(lang, "panel.back"), "set")]);
	return rows;
}

function settingsPage(snapshot: PanelSnapshot): PanelView {
	const { lang } = snapshot;
	return {
		text: [
			t(lang, "panel.title", { version: preview(snapshot.version) }),
			t(lang, "settings.model", { model: preview(snapshot.model), thinking: snapshot.thinking }),
			t(lang, "panel.counts", {
				pending: snapshot.pending,
				jobs: snapshot.jobs.filter((job) => job.enabled).length,
			}),
		].join("\n"),
		rows: [
			[navButton(t(lang, "panel.ses"), "ses"), navButton(t(lang, "panel.mdl"), "mdl")],
			[navButton(t(lang, "panel.mem"), "mem"), navButton(t(lang, "panel.job"), "job")],
			[navButton(t(lang, "panel.sys"), "sys"), actButton(t(lang, "panel.close"), "set:close")],
		],
	};
}

function systemPage(snapshot: PanelSnapshot): PanelView {
	const { lang, memoryUsage, memoryBudget } = snapshot;
	return {
		text: [
			t(lang, "panel.sys"),
			t(lang, "status.running", { version: preview(snapshot.version), uptime: formatUptime(snapshot.uptimeMs) }),
			t(lang, "status.chats", { chats: snapshot.chats, running: snapshot.running }),
			t(lang, "settings.lang", { lang }),
			t(lang, "settings.memory", {
				memory: memoryUsage.memory,
				memoryBudget: memoryBudget.memory,
				memoryPercent: Math.round((memoryUsage.memory / Math.max(1, memoryBudget.memory)) * 100),
				user: memoryUsage.user,
				userBudget: memoryBudget.user,
			}),
			t(lang, "panel.channels", { channels: preview(snapshot.channels.join(", ")) || "—" }),
			snapshot.qqQuota && preview(snapshot.qqQuota),
		]
			.filter(Boolean)
			.join("\n"),
		rows: [
			[
				navButton(t(lang, "panel.pkg"), "pkg"),
				runButton(t(lang, "panel.langZh"), "sys", "lang", "zh"),
				runButton(t(lang, "panel.langEn"), "sys", "lang", "en"),
			],
			...(snapshot.telegramReplyFormat
				? [
						(["rich", "mdv2"] as const).map((format) =>
							runButton(
								`${snapshot.telegramReplyFormat === format ? "✓ " : ""}${format === "rich" ? t(lang, "panel.rich") : "MarkdownV2"}`,
								"sys",
								"fmt",
								format,
							),
						),
					]
				: []),
			[navButton(t(lang, "panel.back"), "set")],
		],
	};
}

function modelsPage(snapshot: PanelSnapshot, page: number): PanelView {
	const { lang } = snapshot;
	const slice = pageSlice(snapshot.modelsByProvider, page);
	const buttons = slice.items.map((provider) =>
		runButton(
			`${snapshot.model.startsWith(`${provider.id}/`) ? "✅ " : ""}${preview(provider.id, 48)} (${provider.models.length})`,
			"mdl",
			"pvd",
			panelKey([provider.id]),
		),
	);
	const title = t(lang, "panel.mdlTitle", { model: preview(snapshot.model) });
	return {
		text: [pageTitle(title, slice), ...(buttons.length ? [] : [t(lang, "panel.empty")])].join("\n"),
		rows: pagedRows(lang, "mdl", "set", slice, grid(buttons), [navButton(t(lang, "panel.pvd"), "pvd")]),
	};
}

function providerModelsPage(
	snapshot: PanelSnapshot,
	provider: PanelSnapshot["modelsByProvider"][number],
	page: number,
): PanelView {
	const { lang } = snapshot;
	const { id } = provider;
	const slice = pageSlice(provider.models, page);
	const rows = grid(
		slice.items.map((model) =>
			runButton(
				`${snapshot.model === `${id}/${model}` ? "✅ " : ""}${preview(model, 56)}`,
				"mdl",
				"set",
				panelKey([id, model]),
			),
		),
	);
	rows.push(pageFooter(lang, "mdl", slice.current, slice.pages, (n) => `mdl:pg:${panelKey([id])}:${n}`));
	return {
		text: [t(lang, "panel.mdlTitle", { model: preview(snapshot.model) }), pageTitle(preview(id), slice)].join("\n"),
		rows,
	};
}

function providersPage(snapshot: PanelSnapshot, page: number): PanelView {
	const { lang } = snapshot;
	const slice = pageSlice(snapshot.providers, page);
	const lines = slice.items.map(
		(provider) => `${provider.configured ? "✅" : "⬜"} ${preview(provider.id)}${provider.custom ? " · custom" : ""}`,
	);
	const buttons = slice.items
		.filter((provider) => provider.custom)
		.map((provider) => runButton(`🗑 ${preview(provider.id, 52)}`, "pvd", "rm", panelKey([provider.id])));
	return {
		text: [
			pageTitle(t(lang, "panel.pvdTitle"), slice),
			...(snapshot.configReadFailed ? [t(lang, "wizard.readFailed")] : []),
			...(lines.length ? lines : [t(lang, "panel.empty")]),
		].join("\n"),
		rows: pagedRows(lang, "pvd", "mdl", slice, grid(buttons), [
			actButton(t(lang, "panel.login"), "pvd:login"),
			actButton(t(lang, "panel.logout"), "pvd:logout"),
			actButton(t(lang, "panel.pvdAdd"), "pvd:add"),
		]),
	};
}

/** The API-kind step of the custom-provider wizard: one button per shape. */
export function apiKindRows(flowId: string): PanelButton[][] {
	return grid(API_KINDS.map((kind: ApiKind, index) => actButton(kind, `pvd:api:${index}:${flowId}`)));
}

function sessionsPage(snapshot: PanelSnapshot): PanelView {
	const { lang } = snapshot;
	const context =
		snapshot.contextWindow > 0
			? `${Math.round(snapshot.contextTokens / 1000)}k/${Math.round(snapshot.contextWindow / 1000)}k`
			: "-";
	const text = [
		t(lang, "panel.sesTitle"),
		t(lang, "status.session", { id: snapshot.sessionId.slice(0, 8), messages: snapshot.messages, context }),
		t(lang, "panel.usage", {
			input: formatTokens(snapshot.tokens.input),
			output: formatTokens(snapshot.tokens.output),
			cache: formatTokens(snapshot.tokens.cacheRead),
			cost: snapshot.cost.toFixed(4),
		}),
	].join("\n");
	const buttons = [
		runButton(t(lang, "panel.new"), "ses", "new", ""),
		runButton(t(lang, "panel.list"), "ses", "list", ""),
		runButton(t(lang, "panel.stop"), "ses", "stop", ""),
	];
	return { text, rows: withBack("ses", lang, buttons) };
}

function packagesPage(snapshot: PanelSnapshot, page: number): PanelView {
	const { lang } = snapshot;
	const slice = pageSlice(snapshot.packages, page);
	const lines = slice.items.map((source) => `- ${preview(source)}`);
	const buttons = slice.items.map((source) => runButton(`🗑 ${shortSource(source)}`, "pkg", "rm", panelKey([source])));
	return {
		text: [pageTitle(t(lang, "panel.pkgTitle"), slice), ...(lines.length ? lines : [t(lang, "pkg.none")])].join("\n"),
		rows: pagedRows(lang, "pkg", "sys", slice, grid(buttons), [actButton(t(lang, "panel.pkgAdd"), "pkg:add")]),
	};
}

function memoryPage(snapshot: PanelSnapshot, page: number): PanelView {
	const { lang } = snapshot;
	const slice = pageSlice(snapshot.stored, page);
	const lines = [
		pageTitle(t(lang, "panel.memTitle", { n: snapshot.stored.length, pending: snapshot.pending }), slice),
	];
	if (!slice.items.length) lines.push(t(lang, "memory.empty"));
	for (const entry of slice.items) lines.push(`${entry.number}. [${entry.target}] ${preview(entry.text, 160)}`);
	const fixed: PanelButton[] = [];
	if (snapshot.pending > 0) {
		lines.push(
			snapshot.pendingLines.length <= 2500
				? snapshot.pendingLines
				: t(lang, "panel.pendingMore", { n: snapshot.pending }),
		);
		fixed.push(
			runButton(t(lang, "panel.approveAll"), "mem", "ok", snapshot.pendingKey),
			runButton(t(lang, "panel.rejectAll"), "mem", "no", snapshot.pendingKey),
		);
	}
	const buttons = slice.items.map((entry) =>
		runButton(t(lang, "panel.forget", { n: entry.number }), "mem", "fg", panelKey([entry.target, entry.text])),
	);
	return { text: lines.join("\n"), rows: pagedRows(lang, "mem", "set", slice, grid(buttons), fixed) };
}

function jobsPage(snapshot: PanelSnapshot, page: number): PanelView {
	const { lang } = snapshot;
	const slice = pageSlice(snapshot.jobs, page, 3);
	const lines = [pageTitle(t(lang, "panel.jobTitle"), slice)];
	if (!slice.items.length) lines.push(t(lang, "jobs.empty"));
	const rows = slice.items.map((job) => {
		const key = panelKey([job.id]);
		const status = job.enabled ? (job.lastStatus ?? "pending") : "paused";
		lines.push(
			`${preview(job.id, 32)} · ${preview(job.name)} · ${preview(job.schedule, 64)} · ${new Date(job.nextRunAt).toLocaleString(lang)} · ${status}`,
		);
		return [
			runButton(`${job.enabled ? "⏸" : "▶️"} ${preview(job.name, 48)}`, "job", job.enabled ? "pause" : "resume", key),
			runButton(`🗑 ${preview(job.name, 48)}`, "job", "rm", key),
		];
	});
	return { text: lines.join("\n"), rows: pagedRows(lang, "job", "set", slice, rows) };
}

/** Render a page; a model provider can be specified by name in typed commands. */
export function renderPage(page: PanelPage, snapshot: PanelSnapshot, arg = "", modelProvider?: string): PanelView {
	switch (page) {
		case "set":
			return settingsPage(snapshot);
		case "sys":
			return systemPage(snapshot);
		case "mdl": {
			const [name, n] = arg.trim().split(/\s+/);
			const provider = snapshot.modelsByProvider.find((candidate) => candidate.id === (modelProvider ?? name));
			return provider
				? providerModelsPage(snapshot, provider, Number(modelProvider === undefined ? n : arg))
				: modelsPage(snapshot, Number(arg));
		}
		case "pvd":
			return providersPage(snapshot, Number(arg));
		case "ses":
			return sessionsPage(snapshot);
		case "pkg":
			return packagesPage(snapshot, Number(arg));
		case "mem":
			return memoryPage(snapshot, Number(arg));
		case "job":
			return jobsPage(snapshot, Number(arg));
	}
}

/** `1234` → `1.2k`, so a token count fits one line. */
export function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	const thousands = value / 1000;
	return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

/** The last path segment of a package source, for a button label. */
function shortSource(source: string): string {
	const trimmed = source.replace(/\/+$/, "");
	const slash = trimmed.lastIndexOf("/");
	const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
	return preview(name, 22);
}
