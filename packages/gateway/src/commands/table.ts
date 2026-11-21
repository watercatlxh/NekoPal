import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { Lang, SentHandle } from "../channel/types.ts";
import type { ChatContext } from "../chat/context.ts";
import { nextRun } from "../cron/schedule.ts";
import { t } from "../i18n/index.ts";
import { logError } from "../log.ts";
import { type PanelButton, type PanelPage, panelKey, runButton, toKeyboard } from "../panel/encode.ts";
import { pageFooter, pageSlice, preview } from "../panel/model.ts";
import { removeProvider } from "../panel/models-json.ts";
import { view as viewOf } from "../panel/router.ts";
import type { CommandContext, CommandTable } from "./index.ts";
import { describe, descriptionOf, formatUptime, parseSchedule, resolveModel } from "./index.ts";
import { formatJobs } from "./jobs.ts";
import { formatPending, formatStored, storedEntries } from "./memory.ts";

const HELP_ORDER = [
	"help",
	"status",
	"settings",
	"new",
	"sessions",
	"resume",
	"stop",
	"model",
	"memory",
	"jobs",
	"packages",
	"cancel",
];

function chatOf(context: CommandContext): ChatContext {
	return context.chat;
}

/** The chat command table. */
/** The command list for a platform menu: name without the slash, and its description. */
export function commandMenu(lang: Lang): Array<{ command: string; description: string }> {
	return HELP_ORDER.filter((name) => name !== "cancel").map((name) => ({
		command: name,
		description: descriptionOf(name, lang),
	}));
}

export function createCommands(): CommandTable {
	const commands: CommandTable = new Map();

	commands.set("help", {
		description: (lang) => t(lang, "cmd.help.desc"),
		async run(context) {
			const lang = context.chat.lang;
			const lines = HELP_ORDER.map((name) => describe(name, lang));
			await context.chat.sendPlain(`${t(lang, "help.header")}\n${lines.join("\n")}`);
		},
	});

	commands.set("status", {
		description: (lang) => t(lang, "cmd.status.desc"),
		async run(context) {
			const chat = chatOf(context);
			const lang = chat.lang;
			const stats = chat.session.getSessionStats();
			const contextTokens = stats.tokens.total;
			const window = chat.session.model?.contextWindow ?? 0;
			await chat.sendPlain(
				[
					t(lang, "status.running", {
						uptime: formatUptime(Date.now() - context.startedAt),
						version: context.version,
					}),
					t(lang, "status.session", {
						id: stats.sessionId.slice(0, 8),
						messages: stats.totalMessages,
						context: window > 0 ? `${Math.round(contextTokens / 1000)}k/${Math.round(window / 1000)}k` : "-",
					}),
					t(lang, "status.chats", { chats: context.registry.size, running: context.registry.running }),
				].join("\n"),
			);
		},
	});

	commands.set("settings", {
		description: (lang) => t(lang, "cmd.settings.desc"),
		async run(context, args) {
			await runSettings(context, args.trim());
		},
	});

	commands.set("new", {
		description: (lang) => t(lang, "cmd.new.desc"),
		async run(context) {
			await context.chat.newSession();
			await context.chat.say("session.new");
		},
	});

	commands.set("sessions", {
		description: (lang) => t(lang, "cmd.sessions.desc"),
		async run(context) {
			await showResume(context, 0);
		},
	});

	commands.set("resume", {
		description: (lang) => t(lang, "cmd.resume.desc"),
		async run(context, args) {
			const chat = chatOf(context);
			const sessions = await context.chat.listSessions();
			// No argument lists them as a paged panel; an argument resumes directly.
			if (args.trim() === "") {
				await showResume(context, 0);
				return;
			}
			const index = Number(args);
			const target = Number.isInteger(index) && index >= 1 ? sessions[index - 1] : undefined;
			const found = target ?? sessions.find((session) => session.id.startsWith(args));
			if (!found) {
				await chat.say("session.notFound", { ref: args || "(none)" });
				return;
			}
			await context.chat.switchSession(found.path);
			await chat.say("session.resumed", { id: found.id.slice(0, 8) });
		},
	});

	commands.set("stop", {
		description: (lang) => t(lang, "cmd.stop.desc"),
		async run(context) {
			const chat = chatOf(context);
			chat.session.clearQueue();
			await chat.session.abort();
		},
	});

	commands.set("model", {
		description: (lang) => t(lang, "cmd.model.desc"),
		async run(context, args) {
			const chat = chatOf(context);
			if (!args) return showPanel(context, "mdl");
			const model = resolveModel(chat.session, args);
			if (!model) {
				await chat.say("model.notFound", { ref: args });
				return;
			}
			await chat.session.setModel(model, { persist: true });
			await chat.say("model.set", { model: `${model.provider}/${model.id}` });
		},
	});

	commands.set("memory", {
		description: (lang) => t(lang, "cmd.memory.desc"),
		async run(context, args) {
			const chat = chatOf(context);
			const lang = chat.lang;
			const [action = "list", ...rest] = args.split(/\s+/).filter(Boolean);
			const ref = rest.join(" ");

			if (action === "list") {
				const stored = formatStored(context.memory);
				const pending = formatPending(context.pending.list());
				await chat.sendPlain([stored, pending].filter(Boolean).join("\n\n"));
				return;
			}

			if (action === "approve" || action === "reject") {
				const entries = context.pending.list();
				if (entries.length === 0) {
					await chat.say("memory.nonePending");
					return;
				}
				const chosen =
					ref === "all" ? entries : entries.filter((entry) => entry.id.startsWith(ref) || entry.id === ref);
				if (chosen.length === 0) {
					await chat.say("memory.nonePending");
					return;
				}
				let applied = 0;
				let skillsChanged = false;
				for (const entry of chosen) {
					if (action === "reject") {
						context.pending.remove(entry.id);
						applied++;
						continue;
					}
					try {
						if (entry.target === "skill") {
							context.skills.apply(entry.operations);
							skillsChanged = true;
						} else {
							context.memory.apply(entry.target, entry.operations);
						}
						context.pending.remove(entry.id);
						applied++;
					} catch (error) {
						await chat.sendPlain(error instanceof Error ? error.message : String(error));
					}
				}
				// A new skill only enters the index on reload, and every chat shares the skills directory.
				if (skillsChanged) {
					for (const other of context.registry.all()) {
						await other.session.reload().catch((error: unknown) => logError("could not reload a chat", error));
					}
				}
				await chat.say(action === "approve" ? "memory.approved" : "memory.rejected", { n: applied });
				return;
			}

			if (action === "forget") {
				// `/memory list` numbers both stores in one sequence, so map back to the store index.
				const entry = storedEntries(context.memory).find((candidate) => candidate.number === Number(ref));
				if (!entry) {
					await chat.say("memory.notFound", { n: ref });
					return;
				}
				const removed = context.memory.forget(entry.target, entry.index);
				await chat.say("memory.forgot", { entry: removed.slice(0, 60) });
				return;
			}

			await chat.sendPlain(describe("memory", lang));
		},
	});

	commands.set("jobs", {
		description: (lang) => t(lang, "cmd.jobs.desc"),
		async run(context, args) {
			const chat = chatOf(context);
			const lang = chat.lang;
			const [action = "list", ...rest] = args.split(/\s+/).filter(Boolean);
			const ref = rest.join(" ");
			if (action === "list") {
				const jobs = context.jobs.load();
				await chat.sendPlain(jobs.length === 0 ? t(lang, "jobs.empty") : formatJobs(jobs, lang));
				return;
			}
			if (action === "add") {
				const [name, schedule, ...promptParts] = rest;
				if (!name || !schedule || promptParts.length === 0) {
					await chat.sendPlain("Usage: /jobs add <name> <schedule> <prompt>");
					return;
				}
				const now = new Date();
				const parsed = parseSchedule(schedule, now);
				const runAt = nextRun(parsed, now);
				if (runAt === undefined) {
					await chat.sendPlain("The schedule has no next run.");
					return;
				}
				const job = context.jobs.add({
					name,
					schedule,
					prompt: promptParts.join(" "),
					deliver: { channel: chat.adapter.name, chatId: chat.chatId },
					enabled: true,
					nextRunAt: runAt,
				});
				await chat.say("jobs.added", { name: job.name, id: job.id });
				return;
			}
			const job = context.jobs.find(ref);
			if (!job) {
				await chat.say("jobs.notFound", { ref });
				return;
			}
			if (action === "rm" || action === "remove") {
				context.jobs.remove(job.id);
				await chat.say("jobs.removed", { id: job.id });
				return;
			}
			if (action === "pause" || action === "resume") {
				context.jobs.update(job.id, (entry) => {
					entry.enabled = action === "resume";
				});
				await chat.say(action === "pause" ? "jobs.paused" : "jobs.resumed", { id: job.id });
				return;
			}
			await chat.sendPlain(describe("jobs", lang));
		},
	});

	commands.set("packages", {
		description: (lang) => t(lang, "cmd.packages.desc"),
		async run(context, args) {
			await runPackages(context, args.trim());
		},
	});

	commands.set("cancel", {
		description: (lang) => t(lang, "cmd.cancel.desc"),
		async run(context) {
			context.chat.cancelPending();
		},
	});

	return commands;
}

/** Present exactly one panel, editing only a known bot message. Returns its handle. */
export async function presentPanel(
	chat: ChatContext,
	text: string,
	rows: ReadonlyArray<ReadonlyArray<PanelButton>>,
	handle?: SentHandle,
	replyTo = chat.replyTo,
): Promise<SentHandle> {
	const keyboard = toKeyboard(rows);
	const displayed = text.length > 4096 ? `${text.slice(0, 4095).replace(/[\uD800-\uDBFF]$/, "")}…` : text;
	if (handle && chat.adapter.caps.edit && (await chat.editRich(handle, displayed, keyboard))) return handle;
	return chat.sendRich(displayed, replyTo, keyboard);
}

export async function showPanel(
	context: CommandContext,
	page: PanelPage,
	arg = "",
	modelProvider?: string,
): Promise<void> {
	const rosterNotice = page === "mdl" ? await googleRosterNotice(context) : "";
	const view = viewOf(context, page, arg, modelProvider);
	await presentPanel(
		context.chat,
		[view.text, rosterNotice].filter(Boolean).join("\n"),
		view.rows,
		context.panelOrigin?.handle,
		context.message.messageId,
	);
}

async function googleRosterNotice(context: CommandContext): Promise<string> {
	const { modelRuntime, chat } = context;
	if (!modelRuntime.isUsingOAuth("google")) return "";
	try {
		const result = await modelRuntime.refresh({ providers: ["google"], signal: AbortSignal.timeout(10_000) });
		if (result.aborted || result.errors.has("google")) return t(chat.lang, "model.rosterFailed");
		return modelRuntime.getModels("google").length ? "" : t(chat.lang, "model.rosterEmpty");
	} catch {
		return t(chat.lang, "model.rosterFailed");
	}
}

/** A page name as `/settings <page>` spells it, or undefined when it is not one. */
export function isPage(name: string): name is PanelPage {
	return (
		name === "set" ||
		name === "mdl" ||
		name === "think" ||
		name === "pvd" ||
		name === "ses" ||
		name === "pkg" ||
		name === "mem" ||
		name === "job" ||
		name === "sys"
	);
}

/**
 * Show the sessions of this chat as pages of buttons.
 *
 * A press resumes the session it names; the page buttons move between pages without leaving the
 * panel, which is what makes a long history usable from a phone.
 */
export async function showResume(context: CommandContext, page: number): Promise<void> {
	const chat = context.chat;
	const sessions = await chat.listSessions();
	const { items, current, pages, start } = pageSlice(sessions, page, 3);
	const lines = [t(chat.lang, "session.pages", { total: sessions.length, page: current + 1, pages })];
	if (!items.length) lines.push(t(chat.lang, "session.listEmpty"));
	const rows: PanelButton[][] = items.map((session, offset) => {
		const number = start + offset + 1;
		const first = preview(session.firstMessage, 80) || session.id.slice(0, 8);
		lines.push(`${number}. ${first} · ${session.id.slice(0, 8)}`);
		return [runButton(`${number}. ${preview(first, 40)}`, "ses", "resume", panelKey([session.id]))];
	});
	rows.push(pageFooter(chat.lang, "ses", current, pages, (n) => `pg:ses:${n}`));
	await presentPanel(chat, lines.join("\n"), rows, context.panelOrigin?.handle, context.message.messageId);
}

/**
 * `/settings [page]`: the panel root, or one of its pages by name.
 *
 * `/settings lang <en|zh>` and `/settings pvd rm <id>` are the two actions a button cannot carry
 * alone, so they are reachable by typing as well.
 */
async function runSettings(context: CommandContext, args: string): Promise<void> {
	const chat = context.chat;
	const [head = "", ...rest] = args.split(/\s+/).filter(Boolean);
	if (head === "format") {
		if (chat.adapter.name !== "telegram") {
			await chat.say("panel.telegramOnly");
			return;
		}
		const [format] = rest;
		if (rest.length !== 1 || (format !== "rich" && format !== "mdv2")) {
			await chat.sendPlain("Usage: /settings format <rich|mdv2>");
			return;
		}
		context.registry.setReplyFormat(chat, format);
		if (!context.panelOrigin) await showPanel(context, "sys");
		return;
	}
	if (head === "page") {
		await showResume(context, Number(rest[0] ?? "0"));
		return;
	}
	if (head === "resume" && rest[0] === "page") {
		await showResume(context, Number(rest[1] ?? "0"));
		return;
	}
	if (head === "lang") {
		const next = rest[0]?.toLowerCase();
		if (next !== "en" && next !== "zh") {
			await chat.sendPlain("Usage: /settings lang <en|zh>");
			return;
		}
		context.setLang(next);
		if (!context.panelOrigin) await showPanel(context, "sys");
		return;
	}
	if (head === "pvd" && rest[0] === "rm") {
		const id = rest[1] ?? "";
		if (id === "" || !removeProvider(context.agentDir, id)) {
			await chat.sendPlain(`没有自定义提供商 ${id}`);
			return;
		}
		await refreshAfterWrite(context, "wizard.removed", { id });
		if (!context.panelOrigin) await showPanel(context, "pvd");
		return;
	}
	if (!context.panelOrigin) await showPanel(context, isPage(head) ? head : "set", rest.join(" "));
}

/**
 * `/packages [rm <n>]`: the package panel, or the removal a button stands for.
 *
 * Installing asks for a source in the chat, so it needs no argument.
 */
async function runPackages(context: CommandContext, args: string): Promise<void> {
	const [head, ref = ""] = args.split(/\s+/).filter(Boolean);
	if (head === "rm") {
		const target = /^\d+$/.test(ref) ? packageManager(context).listConfiguredPackages()[Number(ref)] : undefined;
		if (!target) {
			await context.chat.sendPlain("Usage: /packages rm <number>");
			return;
		}
		await removePackage(context, target.source);
		if (!context.panelOrigin) await showPanel(context, "pkg");
		return;
	}
	if (!context.panelOrigin) await showPanel(context, "pkg");
}

export function packageManager(context: CommandContext): DefaultPackageManager {
	return new DefaultPackageManager({
		cwd: context.chat.workspace,
		agentDir: context.agentDir,
		settingsManager: context.settingsManager,
	});
}

export async function removePackage(context: CommandContext, source: string): Promise<void> {
	await packageManager(context).removeAndPersist(source);
	for (const other of context.registry.all()) await other.session.reload();
	await context.chat.say("pkg.removed", { source });
}

/** The write has already committed; never retry it or claim a failed reload succeeded. */
export async function refreshAfterWrite(
	context: CommandContext,
	success: "wizard.saved" | "wizard.removed",
	args: Record<string, string | number>,
): Promise<void> {
	let loaded = false;
	try {
		const { errors, aborted } = await context.modelRuntime.refresh();
		loaded = !aborted && errors.size === 0 && !context.modelRuntime.getError();
	} catch {
		// Configuration errors can include credentials; report only the outcome.
	}
	await context.chat.say(loaded ? success : "wizard.loadFailed", args);
}
