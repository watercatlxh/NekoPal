import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import type { ChatContext } from "../chat/context.ts";
import type { Lang } from "../channel/types.ts";
import { t } from "../i18n/index.ts";
import type { CommandContext, CommandTable } from "./index.ts";
import { nextRun } from "../cron/schedule.ts";
import { describe, formatUptime, modelLabel, parseSchedule, resolveModel } from "./index.ts";
import { formatPending, formatStored, formatUsage } from "./memory.ts";
import { formatJobs } from "./jobs.ts";
import { loginCommand, logoutCommand } from "./login.ts";

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
	"lang",
	"login",
	"logout",
	"install",
	"remove",
	"packages",
	"cancel",
];

function chatOf(context: CommandContext): ChatContext {
	return context.chat;
}

/** The chat command table. */
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
		async run(context) {
			const chat = chatOf(context);
			const lang = chat.lang;
			const settings = context.settingsManager.getNekoPal();
			const usage = formatUsage(context.memory);
			const pending = context.pending.list().length;
			const jobs = context.jobs.load().filter((job) => job.enabled).length;
			const lines = [
				t(lang, "settings.header"),
				t(lang, "settings.model", {
					model: modelLabel(chat.session),
					thinking: chat.session.thinkingLevel,
				}),
				t(lang, "settings.lang", { lang }),
				t(lang, "settings.memory", {
					memory: usage.memory,
					memoryBudget: settings.memory?.memoryChars ?? 0,
					memoryPercent: Math.round((usage.memory / (settings.memory?.memoryChars ?? 1)) * 100),
					user: usage.user,
					userBudget: settings.memory?.userChars ?? 0,
				}),
			];
			if (pending > 0) lines.push(t(lang, "settings.pending", { n: pending }));
			lines.push(t(lang, "settings.jobs", { n: jobs }));
			lines.push(t(lang, "settings.channels", { channels: context.enabledChannels.join(" · ") }));
			if (context.qqQuota) lines.push(context.qqQuota());
			await chat.sendPlain(lines.join("\n"));
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
			const chat = chatOf(context);
			const sessions = await context.chat.listSessions();
			if (sessions.length === 0) {
				await chat.say("session.listEmpty");
				return;
			}
			const lines = sessions.slice(0, 10).map((session, index) => {
				const first = session.firstMessage.replace(/\s+/g, " ").slice(0, 40);
				return `${index + 1}. ${session.modified.toLocaleString()} · ${first} · ${session.id.slice(0, 8)}`;
			});
			await chat.sendPlain(lines.join("\n"));
		},
	});

	commands.set("resume", {
		description: (lang) => t(lang, "cmd.resume.desc"),
		async run(context, args) {
			const chat = chatOf(context);
			const sessions = await context.chat.listSessions();
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
				const lines = [t(lang, "model.current", { model: modelLabel(chat.session), thinking: chat.session.thinkingLevel })];
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
					ref === "all"
						? entries
						: entries.filter((entry) => entry.id.startsWith(ref) || entry.id === ref);
				if (chosen.length === 0) {
					await chat.say("memory.nonePending");
					return;
				}
				let applied = 0;
				for (const entry of chosen) {
					if (action === "reject") {
						context.pending.remove(entry.id);
						applied++;
						continue;
					}
					try {
						if (entry.target === "skill") {
							context.skills.apply(entry.operations);
						} else {
							context.memory.apply(entry.target, entry.operations);
						}
						context.pending.remove(entry.id);
						applied++;
					} catch (error) {
						await chat.sendPlain(error instanceof Error ? error.message : String(error));
					}
				}
				await chat.say(action === "approve" ? "memory.approved" : "memory.rejected", { n: applied });
				return;
			}

			if (action === "forget") {
				const index = Number(ref);
				const target = context.memory.entries("memory").length > 0 ? "memory" : "user";
				const removed = context.memory.forget(target, index);
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

	commands.set("lang", {
		description: (lang) => t(lang, "cmd.lang.desc"),
		async run(context, args) {
			const next = args.trim().toLowerCase();
			if (next !== "en" && next !== "zh") {
				await context.chat.sendPlain("Usage: /lang <en|zh>");
				return;
			}
			context.setLang(next);
			await context.chat.say("lang.set", { lang: next });
		},
	});

	commands.set("login", {
		description: (lang) => t(lang, "cmd.login.desc"),
		async run(context, args) {
			await loginCommand(context, args);
		},
	});

	commands.set("logout", {
		description: (lang) => t(lang, "cmd.logout.desc"),
		async run(context, args) {
			await logoutCommand(context, args);
		},
	});

	commands.set("install", {
		description: (lang) => t(lang, "cmd.install.desc"),
		async run(context, args) {
			await installCommand(context, args, "install");
		},
	});

	commands.set("remove", {
		description: (lang) => t(lang, "cmd.remove.desc"),
		async run(context, args) {
			await installCommand(context, args, "remove");
		},
	});

	commands.set("packages", {
		description: (lang) => t(lang, "cmd.packages.desc"),
		async run(context) {
			const packages = context.settingsManager.getPackages();
			await context.chat.sendPlain(
				packages.length === 0
					? t(context.chat.lang, "pkg.list", { list: "(none)" })
					: t(context.chat.lang, "pkg.list", { list: packages.join("\n") }),
			);
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

async function installCommand(context: CommandContext, source: string, action: "install" | "remove"): Promise<void> {
	const chat = context.chat;
	if (!source.trim()) {
		await chat.sendPlain(`Usage: /${action} <source>`);
		return;
	}
	const manager = new DefaultPackageManager({
		cwd: chat.workspace,
		agentDir: context.agentDir,
		settingsManager: context.settingsManager,
	});
	if (action === "install") await manager.installAndPersist(source);
	else await manager.removeAndPersist(source);
	for (const other of context.registry.all()) await other.session.reload();
	await chat.say(action === "install" ? "pkg.installed" : "pkg.removed", { source });
}
