import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { setProtectedPaths } from "@earendil-works/pi-coding-agent";
import type { QqQuotaReporter } from "./channel/qq/adapter.ts";
import type { Adapter, ChannelName, Lang } from "./channel/types.ts";
import { Dispatcher } from "./chat/dispatch.ts";
import { ChatRegistry } from "./chat/registry.ts";
import { Scheduler } from "./cron/scheduler.ts";
import { JobStore } from "./cron/store.ts";
import { t } from "./i18n/index.ts";
import { log, logError } from "./log.ts";
import { SkillStore } from "./memory/skills.ts";
import { MemoryStore, PendingStore } from "./memory/store.ts";
import {
	AUTH_PATH,
	CRON_DIR,
	MEMORY_DIR,
	PENDING_DIR,
	SESSIONS_DIR,
	SETTINGS_BACKUP_PATH,
	SETTINGS_PATH,
	SKILLS_DIR,
	STATE_PATH,
} from "./paths.ts";
import type { StateStore } from "./state.ts";

export interface DaemonOptions {
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	adapters: Adapter[];
	version: string;
	workspace: string;
	agentDir: string;
	state: StateStore;
}

/** The running daemon: adapters, chats, the dispatcher and the scheduler. */
export class Daemon {
	private readonly options: DaemonOptions;
	private readonly state: StateStore;
	private readonly memory: MemoryStore;
	private readonly pending: PendingStore;
	private readonly skills: SkillStore;
	private readonly jobs: JobStore;
	private readonly registry: ChatRegistry;
	private readonly dispatcher: Dispatcher;
	private readonly scheduler: Scheduler;
	private readonly startedAt = Date.now();
	private stopped = false;

	constructor(options: DaemonOptions) {
		this.options = options;
		for (const dir of [MEMORY_DIR, PENDING_DIR, SKILLS_DIR, SESSIONS_DIR, CRON_DIR]) {
			mkdirSync(dir, { recursive: true });
		}

		const settings = options.settingsManager.getNekoPal();
		this.state = options.state;
		this.memory = new MemoryStore({
			budgets: {
				memoryChars: settings.memory?.memoryChars ?? 1375,
				userChars: settings.memory?.userChars ?? 1375,
			},
		});
		this.pending = new PendingStore();
		this.skills = new SkillStore();
		this.jobs = new JobStore();

		const redactor = { secrets: () => this.secrets() };
		const enabledChannels = options.adapters.map((adapter) => adapter.name);

		this.registry = new ChatRegistry({
			state: this.state,
			workspace: options.workspace,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager,
			modelRuntime: options.modelRuntime,
			memory: this.memory,
			pending: this.pending,
			jobs: this.jobs,
			redactor,
			defaultLang: settings.defaultLang ?? "en",
		});
		for (const adapter of options.adapters) this.registry.registerAdapter(adapter);

		this.dispatcher = new Dispatcher({
			registry: this.registry,
			state: this.state,
			settingsManager: options.settingsManager,
			modelRuntime: options.modelRuntime,
			memory: this.memory,
			pending: this.pending,
			jobs: this.jobs,
			agentDir: options.agentDir,
			workspace: options.workspace,
			skills: this.skills,
			startedAt: this.startedAt,
			version: options.version,
			enabledChannels,
			allowed: (channel, userId) => this.allowed(channel, userId),
			qqQuota: (chatId, lang) => this.qqQuota(chatId, lang),
		});

		this.scheduler = new Scheduler({
			store: this.jobs,
			workspace: options.workspace,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager,
			modelRuntime: options.modelRuntime,
			memory: this.memory,
			redactor,
			adapterFor: (channel) => this.registry.adapterFor(channel),
			langFor: (channel, chatId) => this.registry.langFor(channel, chatId),
		});
	}

	/** Start adapters, the scheduler and every open chat. */
	async start(): Promise<void> {
		this.warnEmptyAllowlists();
		setProtectedPaths([
			{ path: SETTINGS_PATH, message: "settings.toml is protected; change it with config_set" },
			{ path: SETTINGS_BACKUP_PATH, message: "settings.toml.bak is protected" },
			{ path: AUTH_PATH, message: "auth.json is protected; use /login and /logout" },
			{ path: STATE_PATH, message: "state.json is protected" },
		]);
		for (const adapter of this.options.adapters) {
			await adapter.start((message) => this.dispatcher.handle(message));
			log("info", `${adapter.name} adapter started`);
		}
		this.scheduler.start();
		log("info", `nekopal ${this.options.version} ready`);
	}

	/** Stop adapters, the scheduler, chats, and flush state. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.scheduler.stop();
		for (const adapter of this.options.adapters) {
			try {
				await adapter.stop();
			} catch (error) {
				logError(`could not stop the ${adapter.name} adapter`, error);
			}
		}
		await this.registry.dispose();
		this.state.flush();
		log("info", "stopped");
	}

	private allowed(channel: ChannelName, userId: string): boolean {
		const channels = this.options.settingsManager.getNekoPal().channels;
		if (channel === "telegram") {
			return (channels?.telegram?.allowedUsers ?? []).map(String).includes(userId);
		}
		return (channels?.qq?.allowedOpenIds ?? []).includes(userId);
	}

	/** The QQ quota line, when the QQ channel is running. */
	private qqQuota(chatId: string, lang: Lang): string | undefined {
		const adapter = this.registry.adapterFor("qq") as Partial<QqQuotaReporter> | undefined;
		return adapter?.quotaLine?.(chatId, lang);
	}

	/** An empty allowlist silently ignores everyone, so say so at startup. */
	private warnEmptyAllowlists(): void {
		for (const adapter of this.options.adapters) {
			const channels = this.options.settingsManager.getNekoPal().channels;
			const list = adapter.name === "telegram" ? channels?.telegram?.allowedUsers : channels?.qq?.allowedOpenIds;
			if ((list ?? []).length === 0) {
				log("warn", `${adapter.name} allowlist is empty; every message will be ignored`);
			}
		}
	}

	/** Values the redactor masks: channel secrets resolved from settings, plus the auth file's tokens. */
	private secrets(): string[] {
		const settings = this.options.settingsManager.getNekoPal();
		const values: string[] = [];
		const channels = settings.channels;
		for (const value of [channels?.telegram?.botToken, channels?.qq?.appSecret]) {
			if (typeof value === "string" && !value.startsWith("$") && !value.startsWith("!")) values.push(value);
		}
		if (existsSync(AUTH_PATH)) {
			try {
				const parsed = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as Record<string, unknown>;
				for (const credential of Object.values(parsed)) {
					const record = credential as { access?: unknown; refresh?: unknown; key?: unknown };
					for (const value of [record.access, record.refresh, record.key]) {
						if (typeof value === "string") values.push(value);
					}
				}
			} catch {
				// A malformed auth file is reported by the model runtime, not here.
			}
		}
		return values;
	}

	/** The message a start with no enabled channel prints. */
	static noChannelMessage(lang: Lang = "en"): string {
		return t(lang, "daemon.noChannel");
	}
}
