import { join } from "node:path";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	findExactModelReferenceMatch,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Adapter, Lang } from "../channel/types.ts";
import { builtInExtensions } from "../chat/builtin-extensions.ts";
import type { NekoPalExtensionOptions } from "../extension/nekopal-extension.ts";
import { nekopalExtension } from "../extension/nekopal-extension.ts";
import { t } from "../i18n/index.ts";
import { log, logError } from "../log.ts";
import type { MemoryStore } from "../memory/store.ts";
import { cronTool } from "../tools/cron.ts";
import { sendTool } from "../tools/send.ts";
import { graceMs, nextRun, parseSchedule } from "./schedule.ts";
import type { Job, JobStore } from "./store.ts";

const TICK_MS = 60_000;

export interface SchedulerOptions {
	store: JobStore;
	workspace: string;
	agentDir: string;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	memory: MemoryStore;
	redactor: NekoPalExtensionOptions["redactor"];
	adapterFor(channel: Job["deliver"]["channel"]): Adapter | undefined;
	langFor(channel: Job["deliver"]["channel"], chatId: string): Lang;
}

/** Runs due jobs on a one-minute tick, one at a time, and delivers their replies. */
export class Scheduler {
	private readonly options: SchedulerOptions;
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	/** Deliveries waiting for QQ quota, retried on every tick and dropped on restart. */
	private readonly undelivered: Array<{ channel: Job["deliver"]["channel"]; chatId: string; text: string }> = [];

	constructor(options: SchedulerOptions) {
		this.options = options;
	}

	start(): void {
		this.timer = setInterval(() => {
			void this.tick();
		}, TICK_MS);
		this.timer.unref();
		void this.tick();
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Run every job whose next run is due. Exposed for tests. */
	async tick(now: Date = new Date()): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.retryUndelivered();
			for (const job of this.options.store.load()) {
				if (!job.enabled || job.nextRunAt > now.getTime()) continue;
				await this.handleDue(job, now);
			}
		} finally {
			this.running = false;
		}
	}

	private async handleDue(job: Job, now: Date): Promise<void> {
		const schedule = parseSchedule(job.schedule, now, job.timezone);
		const lateness = now.getTime() - job.nextRunAt;
		if (lateness > graceMs(schedule, now, job.timezone)) {
			this.options.store.update(job.id, (entry) => {
				entry.lastStatus = "missed";
				entry.nextRunAt = nextRun(schedule, now, job.timezone) ?? now.getTime();
				if (schedule.kind === "once") entry.enabled = false;
			});
			log("info", `job ${job.id} missed its run window`);
			return;
		}

		// Advance before running, so a crash mid-run does not repeat it.
		const advanced = this.options.store.update(job.id, (entry) => {
			const next = nextRun(schedule, now, job.timezone);
			if (next === undefined) entry.enabled = false;
			else entry.nextRunAt = next;
		});
		if (!advanced) return;
		await this.run(advanced);
	}

	private async run(job: Job): Promise<void> {
		const startedAt = Date.now();
		try {
			const model = job.model
				? findExactModelReferenceMatch(job.model, this.options.modelRuntime.getModels())
				: undefined;
			const loader = new DefaultResourceLoader({
				cwd: this.options.workspace,
				agentDir: this.options.agentDir,
				settingsManager: this.options.settingsManager,
				extensionFactories: [
					...builtInExtensions,
					nekopalExtension({
						channel: job.deliver.channel,
						soulPath: join(this.options.agentDir, "SOUL.md"),
						memory: this.options.memory,
						redactor: this.options.redactor,
						cron: { name: job.name },
					}),
				],
			});
			await loader.reload();
			const adapter = this.options.adapterFor(job.deliver.channel);
			if (!adapter) throw new Error(`no ${job.deliver.channel} adapter`);
			const { session } = await createAgentSession({
				cwd: this.options.workspace,
				agentDir: this.options.agentDir,
				settingsManager: this.options.settingsManager,
				modelRuntime: this.options.modelRuntime,
				model,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(this.options.workspace),
				// The default tool set without `memory`: a scheduled run reads context, it does not
				// rewrite the memory stores. `send` lets it deliver files, not just its final text.
				tools: ["-memory"],
				customTools: [
					sendTool({ adapter, chatId: job.deliver.chatId, cwd: this.options.workspace }),
					cronTool({ store: this.options.store, deliver: job.deliver }),
				],
			});
			try {
				await session.prompt(job.prompt);
				await session.waitForIdle();
				const text = session.getLastAssistantText() ?? "";
				if (text.trim()) {
					const lang = this.options.langFor(job.deliver.channel, job.deliver.chatId);
					this.deliver(job, `${t(lang, "cron.prefix", { name: job.name })}\n\n${text}`);
				}
				this.options.store.update(job.id, (entry) => {
					entry.lastRunAt = startedAt;
					entry.lastStatus = "ok";
					entry.lastError = undefined;
				});
			} finally {
				await session.dispose();
			}
		} catch (error) {
			logError(`job ${job.id} failed`, error);
			const lang = this.options.langFor(job.deliver.channel, job.deliver.chatId);
			const message = error instanceof Error ? error.message : String(error);
			this.deliver(job, t(lang, "cron.failed", { name: job.name, message }));
			this.options.store.update(job.id, (entry) => {
				entry.lastRunAt = startedAt;
				entry.lastStatus = "error";
				entry.lastError = message;
			});
		}
	}

	private deliver(job: Job, text: string): void {
		const adapter = this.options.adapterFor(job.deliver.channel);
		if (!adapter) {
			log("warn", `no ${job.deliver.channel} adapter to deliver job ${job.id}`);
			return;
		}
		void adapter.sendMarkdown(job.deliver.chatId, text).catch((error: unknown) => {
			logError(`could not deliver job ${job.id}; retrying next tick`, error);
			this.undelivered.push({ channel: job.deliver.channel, chatId: job.deliver.chatId, text });
		});
	}

	private async retryUndelivered(): Promise<void> {
		while (this.undelivered.length > 0) {
			const entry = this.undelivered[0];
			const adapter = this.options.adapterFor(entry.channel);
			if (!adapter) return;
			try {
				await adapter.sendMarkdown(entry.chatId, entry.text);
				this.undelivered.shift();
			} catch {
				return;
			}
		}
	}
}
