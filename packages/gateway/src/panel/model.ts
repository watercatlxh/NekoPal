/**
 * The panel pages: plain data in, message text and button rows out.
 *
 * Every button maps onto a command the user could have typed, so the panel is only a visual entry
 * point and `/help` can never drift from it.
 */

import type { Lang } from "../channel/types.ts";
import { describe, formatUptime } from "../commands/index.ts";
import { formatJobs } from "../commands/jobs.ts";
import type { StoredEntry } from "../commands/memory.ts";
import type { Job } from "../cron/store.ts";
import { t } from "../i18n/index.ts";
import { actButton, navButton, type PanelButton, type PanelPage, runButton } from "./encode.ts";
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
	readonly jobs: readonly Job[];
	/** Every configured provider's model ids, untruncated. */
	readonly modelsByProvider: readonly { id: string; models: readonly string[] }[];
	readonly providers: readonly ProviderView[];
	readonly packages: readonly string[];
	readonly channels: readonly string[];
	readonly qqQuota?: string;
}

/** Parse the `mdl` page's argument slot: `provider`, optionally followed by a page number. */
function parseMdlArg(arg: string, snapshot: PanelSnapshot): [string, number] {
	const [provider, page] = arg.trim().split(/\s+/);
	const known = snapshot.modelsByProvider.some((candidate) => candidate.id === provider);
	const number = Number(page);
	return [known ? provider : "", Number.isInteger(number) && number >= 0 ? number : 0];
}

/** One rendered page. */
export interface PanelView {
	readonly text: string;
	readonly rows: ReadonlyArray<ReadonlyArray<PanelButton>>;
}

/** Buttons per row, so a wide page still reads as a grid on a phone. */
const PER_ROW = 2;
/** Stored memories a page shows as forget buttons. */
const FORGET_BUTTONS = 8;
/** Jobs a page shows. */
const JOB_BUTTONS = 4;
/** Model buttons one provider page shows before paging. */
const MODEL_PAGE_SIZE = 10;
/** Page buttons a provider page shows at once. */
const MAX_PAGE_BUTTONS = 5;
/** Providers a page shows. */
const PROVIDER_BUTTONS = 6;

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

/** The top page: what NekoPal is doing, and one button per area. */
function settingsPage(snapshot: PanelSnapshot): PanelView {
	const { lang } = snapshot;
	const percent = Math.round((snapshot.memoryUsage.memory / Math.max(1, snapshot.memoryBudget.memory)) * 100);
	const text = [
		t(lang, "panel.title", { version: snapshot.version }),
		t(lang, "settings.model", { model: snapshot.model, thinking: snapshot.thinking }),
		t(lang, "settings.lang", { lang }),
		t(lang, "settings.memory", {
			memory: snapshot.memoryUsage.memory,
			memoryBudget: snapshot.memoryBudget.memory,
			memoryPercent: percent,
			user: snapshot.memoryUsage.user,
			userBudget: snapshot.memoryBudget.user,
		}),
		t(lang, "panel.counts", {
			pending: snapshot.pending,
			jobs: snapshot.jobs.filter((job) => job.enabled).length,
		}),
	].join("\n");
	return {
		text,
		rows: [
			[navButton(t(lang, "panel.mdl"), "mdl"), navButton(t(lang, "panel.pvd"), "pvd")],
			[navButton(t(lang, "panel.ses"), "ses"), navButton(t(lang, "panel.pkg"), "pkg")],
			[navButton(t(lang, "panel.mem"), "mem"), navButton(t(lang, "panel.job"), "job")],
			[
				runButton(t(lang, "panel.langZh"), "set", "lang", "zh", "/settings lang zh"),
				runButton(t(lang, "panel.langEn"), "set", "lang", "en", "/settings lang en"),
			],
		],
	};
}

/**
 * The model root: one button per configured provider, marked when it owns the current model.
 * Picking a provider opens its paged model list, so any number of models stays reachable.
 */
function modelsPage(snapshot: PanelSnapshot): PanelView {
	const { lang } = snapshot;
	const currentProvider = snapshot.model.split("/")[0];
	const buttons = snapshot.modelsByProvider.map((provider) =>
		runButton(
			`${provider.id === currentProvider ? "✅ " : ""}${provider.id} (${provider.models.length})`,
			"mdl",
			"pvd",
			provider.id,
			`/settings mdl ${provider.id}`,
		),
	);
	return { text: t(lang, "panel.mdlTitle", { model: snapshot.model }), rows: withBack("mdl", lang, buttons) };
}

/**
 * One provider's models, paged. The `page` argument arrives through the panel's page slot
 * (`arg` is `provider` on the provider page itself).
 */
function providerModelsPage(snapshot: PanelSnapshot, providerId: string, page: number): PanelView {
	const { lang } = snapshot;
	const provider = snapshot.modelsByProvider.find((candidate) => candidate.id === providerId);
	if (provider === undefined) return modelsPage(snapshot);
	const pages = Math.max(1, Math.ceil(provider.models.length / MODEL_PAGE_SIZE));
	const current = Math.min(Math.max(page, 0), pages - 1);
	const slice = provider.models.slice(current * MODEL_PAGE_SIZE, (current + 1) * MODEL_PAGE_SIZE);
	const lines = [t(lang, "panel.mdlTitle", { model: snapshot.model }), `— ${providerId} (${current + 1}/${pages})`];
	const buttons: PanelButton[] = [];
	for (const [offset, id] of slice.entries()) {
		const index = current * MODEL_PAGE_SIZE + offset;
		const currentModel = snapshot.model === `${providerId}/${id}`;
		buttons.push(
			runButton(
				currentModel ? `✅ ${id}` : id,
				"mdl",
				"set",
				`${providerId}:${index}`,
				`/model ${providerId}/${id}`,
			),
		);
	}
	const rows = grid(buttons);
	if (pages > 1) {
		const pageRow: PanelButton[] = [];
		if (current > 0) {
			pageRow.push(
				runButton("⬅️", "mdl", "pg", `${providerId}:${current - 1}`, `/settings mdl ${providerId} ${current - 1}`),
			);
		}
		const from = Math.max(0, Math.min(current - Math.floor(MAX_PAGE_BUTTONS / 2), pages - MAX_PAGE_BUTTONS));
		for (let index = from; index < Math.min(pages, from + MAX_PAGE_BUTTONS); index += 1) {
			pageRow.push(
				runButton(
					index === current ? `·${index + 1}·` : String(index + 1),
					"mdl",
					"pg",
					`${providerId}:${index}`,
					`/settings mdl ${providerId} ${index}`,
				),
			);
		}
		if (current < pages - 1) {
			pageRow.push(
				runButton("➡️", "mdl", "pg", `${providerId}:${current + 1}`, `/settings mdl ${providerId} ${current + 1}`),
			);
		}
		rows.push(pageRow);
	}
	rows.push([navButton(t(lang, "panel.back"), "mdl")]);
	return { text: lines.join("\n"), rows };
}

function providersPage(snapshot: PanelSnapshot): PanelView {
	const { lang } = snapshot;
	const lines = [t(lang, "panel.pvdTitle")];
	const buttons: PanelButton[] = [];
	for (const provider of snapshot.providers.slice(0, PROVIDER_BUTTONS)) {
		const mark = provider.configured ? "✅" : "⬜";
		lines.push(`${mark} ${provider.id}${provider.custom ? " · custom" : ""}`);
		if (provider.custom) {
			buttons.push(runButton(`🗑 ${provider.id}`, "pvd", "rm", provider.id, `/settings pvd rm ${provider.id}`));
		}
	}
	buttons.push(actButton(t(lang, "panel.pvdAdd"), "pvd:add"));
	buttons.push(actButton(t(lang, "panel.login"), "pvd:login"));
	buttons.push(actButton(t(lang, "panel.logout"), "pvd:logout"));
	return { text: lines.join("\n"), rows: withBack("pvd", lang, buttons) };
}

/** The API-kind step of the custom-provider wizard: one button per shape. */
export function apiKindRows(): PanelButton[][] {
	return grid(API_KINDS.map((kind: ApiKind) => actButton(kind, `pvd:api:${kind}`)));
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
		runButton(t(lang, "panel.new"), "ses", "new", "", "/new"),
		runButton(t(lang, "panel.list"), "ses", "list", "", "/sessions"),
		runButton(t(lang, "panel.stop"), "ses", "stop", "", "/stop"),
	];
	return { text, rows: withBack("ses", lang, buttons) };
}

function packagesPage(snapshot: PanelSnapshot): PanelView {
	const { lang } = snapshot;
	const lines = [t(lang, "panel.pkgTitle")];
	if (snapshot.packages.length === 0) lines.push(t(lang, "pkg.none"));
	else for (const source of snapshot.packages) lines.push(`- ${source}`);
	const buttons: PanelButton[] = [actButton(t(lang, "panel.pkgAdd"), "pkg:add")];
	for (const [index, source] of snapshot.packages.entries()) {
		buttons.push(runButton(`🗑 ${shortSource(source)}`, "pkg", "rm", String(index), `/packages rm ${index}`));
	}
	return { text: lines.join("\n"), rows: withBack("pkg", lang, buttons) };
}

function memoryPage(snapshot: PanelSnapshot): PanelView {
	const { lang } = snapshot;
	const lines = [t(lang, "panel.memTitle", { n: snapshot.stored.length, pending: snapshot.pending })];
	if (snapshot.pendingLines !== "") lines.push(snapshot.pendingLines);
	const buttons: PanelButton[] = [];
	if (snapshot.pending > 0) {
		buttons.push(
			runButton(t(lang, "panel.approveAll"), "mem", "ok", "all", "/memory approve all"),
			runButton(t(lang, "panel.rejectAll"), "mem", "no", "all", "/memory reject all"),
		);
	}
	for (const entry of snapshot.stored.slice(0, FORGET_BUTTONS)) {
		buttons.push(
			runButton(
				t(lang, "panel.forget", { n: entry.number }),
				"mem",
				"fg",
				String(entry.number),
				`/memory forget ${entry.number}`,
			),
		);
	}
	return { text: lines.join("\n"), rows: withBack("mem", lang, buttons) };
}

function jobsPage(snapshot: PanelSnapshot): PanelView {
	const { lang } = snapshot;
	const text =
		snapshot.jobs.length === 0
			? t(lang, "jobs.empty")
			: [t(lang, "panel.jobTitle"), formatJobs([...snapshot.jobs], lang)].join("\n");
	const buttons: PanelButton[] = [];
	for (const job of snapshot.jobs.slice(0, JOB_BUTTONS)) {
		const short = job.id.slice(0, 8);
		const verb = job.enabled ? "pause" : "resume";
		buttons.push(
			runButton(`${job.enabled ? "⏸" : "▶️"} ${job.name}`, "job", verb, short, `/jobs ${verb} ${short}`),
			runButton(`🗑 ${job.name}`, "job", "rm", short, `/jobs rm ${short}`),
		);
	}
	return { text, rows: withBack("job", lang, buttons) };
}

/** Render one page. The `arg` slot carries a provider (and page) for the model pages. */
export function renderPage(page: PanelPage, snapshot: PanelSnapshot, arg = ""): PanelView {
	switch (page) {
		case "set":
			return settingsPage(snapshot);
		case "mdl":
			return arg === "" ? modelsPage(snapshot) : providerModelsPage(snapshot, ...parseMdlArg(arg, snapshot));
		case "pvd":
			return providersPage(snapshot);
		case "ses":
			return sessionsPage(snapshot);
		case "pkg":
			return packagesPage(snapshot);
		case "mem":
			return memoryPage(snapshot);
		case "job":
			return jobsPage(snapshot);
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
	return name.length > 20 ? `${name.slice(0, 19)}…` : name;
}

/** The text a channel without buttons shows for `/settings`. */
export function panelFallback(lang: Lang, version: string): string {
	return [t(lang, "panel.title", { version }), describe("settings", lang), describe("help", lang)].join("\n");
}

export { formatUptime };
