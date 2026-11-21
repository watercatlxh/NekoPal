import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { Lang, SentHandle } from "../channel/types.ts";
import type { ChatContext } from "../chat/context.ts";
import { nextRun } from "../cron/schedule.ts";
import { t } from "../i18n/index.ts";
import { logError } from "../log.ts";
import { navButton, type PanelButton, type PanelPage, runButton, toKeyboard } from "../panel/encode.ts";
import { removeProvider } from "../panel/models-json.ts";
import { view as viewOf } from "../panel/router.ts";
import type { CommandContext, CommandTable } from "./index.ts";
import { describe, descriptionOf, formatUptime, modelLabel, parseSchedule, resolveModel } from "./index.ts";
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
			const lang = chat.lang;
			if (!args) {
				const models = chat.session.modelRuntime.getModels();
				const groups = new Map<string, string[]>();
				for (const model of models) {
					const list = groups.get(model.provider) ?? [];
					if (list.length < 10) list.push(model.id);
					groups.set(model.provider, list);
				}
				const lines = [
					t(lang, "model.current", { model: modelLabel(chat.session), thinking: chat.session.thinkingLevel }),
				];
				for (const [provider, ids] of groups) lines.push(`${provider}: ${ids.join(", ")}`);
				await chat.sendPlain(lines.join("\n"));
				return;
			}
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

/**
 * Show a panel page: buttons where the channel has them, the same text where it does not.
 *
 * `handle` rewrites an existing message in place, which is what a button press does; without it the
 * page opens as a new message.
 */
export async function showPanel(
	context: CommandContext,
	page: PanelPage,
	handle?: SentHandle,
	arg = "",
): Promise<void> {
	const chat = context.chat;
	const view = viewOf(context, page, arg);
	if (!chat.adapter.caps.edit) {
		// No buttons and no way to rewrite the message: the text alone is still useful.
		await chat.sendPlain(view.text);
		return;
	}
	const keyboard = toKeyboard(view.rows);
	if (handle !== undefined && (await chat.editRich(handle, view.text, keyboard))) return;
	await chat.sendRich(view.text, undefined, keyboard);
}

/** A page name as `/settings <page>` spells it, or undefined when it is not one. */
export function isPage(name: string): name is PanelPage {
	return (
		name === "set" ||
		name === "mdl" ||
		name === "pvd" ||
		name === "ses" ||
		name === "pkg" ||
		name === "mem" ||
		name === "job"
	);
}

/** Sessions per page of the `/resume` panel. */
const SESSIONS_PER_PAGE = 5;
/** Page buttons shown at once, so the row stays tappable. */
const MAX_PAGE_BUTTONS = 5;

/**
 * Show the sessions of this chat as pages of buttons.
 *
 * A press resumes the session it names; the page buttons move between pages without leaving the
 * panel, which is what makes a long history usable from a phone.
 */
export async function showResume(context: CommandContext, page: number): Promise<void> {
	const chat = context.chat;
	const sessions = await chat.listSessions();
	if (sessions.length === 0) {
		await chat.sendPlain(t(chat.lang, "session.listEmpty"));
		return;
	}
	const pages = Math.ceil(sessions.length / SESSIONS_PER_PAGE);
	const current = Math.min(Math.max(page, 0), pages - 1);
	const slice = sessions.slice(current * SESSIONS_PER_PAGE, (current + 1) * SESSIONS_PER_PAGE);
	const lines = [t(chat.lang, "session.pages", { total: sessions.length, page: current + 1, pages })];
	const rows: PanelButton[][] = [];
	for (const [offset, session] of slice.entries()) {
		const number = current * SESSIONS_PER_PAGE + offset + 1;
		const first = session.firstMessage.replace(/\s+/g, " ").slice(0, 28);
		rows.push([runButton(`${number}. ${first}`, "ses", "resume", String(number), `/resume ${number}`)]);
	}
	if (pages > 1) {
		const pageRow: PanelButton[] = [];
		if (current > 0) pageRow.push(runButton("⬅️", "ses", "page", String(current - 1), `/resume page ${current - 1}`));
		const from = Math.max(0, Math.min(current - Math.floor(MAX_PAGE_BUTTONS / 2), pages - MAX_PAGE_BUTTONS));
		for (let index = from; index < Math.min(pages, from + MAX_PAGE_BUTTONS); index += 1) {
			pageRow.push(
				runButton(
					index === current ? `·${index + 1}·` : String(index + 1),
					"ses",
					"page",
					String(index),
					`/resume page ${index}`,
				),
			);
		}
		if (current < pages - 1)
			pageRow.push(runButton("➡️", "ses", "page", String(current + 1), `/resume page ${current + 1}`));
		rows.push(pageRow);
	}
	rows.push([navButton(t(chat.lang, "panel.back"), "set")]);
	await chat.sendRich(lines.join("\n"), undefined, toKeyboard(rows));
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
		await showPanel(context, "set");
		return;
	}
	if (head === "pvd" && rest[0] === "rm") {
		const id = rest[1] ?? "";
		if (id === "" || !removeProvider(context.agentDir, id)) {
			await chat.sendPlain(`没有自定义提供商 ${id}`);
			return;
		}
		await context.modelRuntime.refresh();
		await chat.say("wizard.removed", { id });
		await showPanel(context, "pvd");
		return;
	}
	await showPanel(context, isPage(head) ? head : "set", undefined, rest.join(" "));
}

/**
 * `/packages [rm <n>]`: the package panel, or the removal a button stands for.
 *
 * Installing asks for a source in the chat, so it needs no argument.
 */
async function runPackages(context: CommandContext, args: string): Promise<void> {
	const [head, ref = ""] = args.split(/\s+/).filter(Boolean);
	if (head === "rm") {
		const manager = new DefaultPackageManager({
			cwd: context.chat.workspace,
			agentDir: context.agentDir,
			settingsManager: context.settingsManager,
		});
		const target = manager.listConfiguredPackages()[Number(ref)];
		if (!target) {
			await context.chat.sendPlain(`没有第 ${ref} 个扩展包`);
			return;
		}
		await manager.removeAndPersist(target.source);
		for (const other of context.registry.all()) await other.session.reload();
		await context.chat.say("pkg.removed", { source: target.source });
		await showPanel(context, "pkg");
		return;
	}
	await showPanel(context, "pkg");
}
