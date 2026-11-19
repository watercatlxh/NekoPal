import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ChannelName, Inbound, Lang } from "../channel/types.ts";
import type { CommandContext, CommandTable } from "../commands/index.ts";
import { parseCommand } from "../commands/index.ts";
import { createCommands } from "../commands/table.ts";
import type { JobStore } from "../cron/store.ts";
import { t } from "../i18n/index.ts";
import { log } from "../log.ts";
import type { MemoryStore, PendingStore } from "../memory/store.ts";
import type { StateStore } from "../state.ts";
import type { ChatContext } from "./context.ts";
import type { ChatRegistry } from "./registry.ts";

/** A message whose sender is not on the channel allowlist. */
const IGNORE_LOG_INTERVAL_MS = 60 * 60_000;

export interface DispatcherOptions {
	registry: ChatRegistry;
	state: StateStore;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	memory: MemoryStore;
	pending: PendingStore;
	jobs: JobStore;
	agentDir: string;
	skills: { apply(operations: import("../memory/store.ts").MemoryOperation[]): void };
	startedAt: number;
	version: string;
	enabledChannels: string[];
	qqQuota?: () => string;
	/** Allowlist per channel: Telegram user ids, QQ openids. */
	allowed(channel: ChannelName, userId: string): boolean;
}

/**
 * Routes inbound messages: allowlist, pending questions, commands, then the agent.
 *
 * Every chat's work is serialized through its own promise chain, so a message that arrives while a
 * reply runs is queued rather than interleaved.
 */
export class Dispatcher {
	private readonly options: DispatcherOptions;
	private readonly commands: CommandTable;
	private readonly ignoredAt = new Map<string, number>();

	constructor(options: DispatcherOptions) {
		this.options = options;
		this.commands = createCommands();
	}

	get commandTable(): CommandTable {
		return this.commands;
	}

	handle(message: Inbound): void {
		if (!this.options.allowed(message.channel, message.userId)) {
			const key = `${message.channel}-${message.userId}`;
			const last = this.ignoredAt.get(key) ?? 0;
			if (Date.now() - last > IGNORE_LOG_INTERVAL_MS) {
				this.ignoredAt.set(key, Date.now());
				log("info", `ignored ${message.channel} message from ${message.userId} (not in allowlist)`);
			}
			return;
		}
		void this.dispatch(message);
	}

	private async dispatch(message: Inbound): Promise<void> {
		const chat = await this.options.registry.chatFor(message);
		const parsed = parseCommand(message.text);

		// A pending question takes the next message, except /cancel, which aborts it.
		if (chat.pendingPrompt && parsed?.name !== "cancel") {
			if (chat.answerPending(message.text)) return;
		}

		if (parsed && this.commands.has(parsed.name)) {
			// Commands run outside the chat's queue so /stop can interrupt a running turn.
			const command = this.commands.get(parsed.name)!;
			void command
				.run(this.commandContext(chat, message), parsed.args)
				.catch((error: unknown) => log("error", `/${parsed.name} failed: ${String(error)}`));
			return;
		}

		await chat.enqueue(async () => {
			// Replies to this turn reference the inbound message, so QQ can use passive slots.
			chat.replyTo = message.messageId;
			const images = message.attachments
				.filter((attachment) => attachment.kind === "image")
				.map((attachment) => ({
					type: "image" as const,
					data: attachment.data.toString("base64"),
					mimeType: attachment.mimeType,
				}));
			const text = this.withAttachments(message);
			chat.noteUserTurn();
			try {
				await chat.session.prompt(text, {
					images: images.length > 0 ? images : undefined,
					streamingBehavior: chat.session.isStreaming ? "followUp" : undefined,
				});
				if (chat.session.isStreaming && chat.session.pendingMessageCount > 0) {
					await chat.say("queue.acked", { n: chat.session.pendingMessageCount });
				}
			} catch (error) {
				log("warn", `prompt failed: ${String(error)}`);
				await chat.say("error.busy");
			}
		});
	}

	/** Save non-image attachments to the workspace inbox and append their paths and transcripts. */
	private withAttachments(message: Inbound): string {
		const parts = [message.text];
		for (const attachment of message.attachments) {
			if (attachment.kind === "image") continue;
			const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
			const dir = join(this.options.agentDir, "workspace", "inbox");
			mkdirSync(dir, { recursive: true });
			const path = join(dir, `${stamp}-${attachment.fileName}`);
			writeFileSync(path, attachment.data);
			parts.push(`[attachment saved: ${path}]`);
		}
		for (const attachment of message.attachments) {
			if (attachment.transcript) parts.push(`[voice transcript: ${attachment.transcript}]`);
		}
		return parts.join("\n");
	}

	private commandContext(chat: ChatContext, message: Inbound): CommandContext {
		return {
			chat,
			message,
			registry: this.options.registry,
			memory: this.options.memory,
			pending: this.options.pending,
			jobs: this.options.jobs,
			settingsManager: this.options.settingsManager,
			modelRuntime: this.options.modelRuntime,
			agentDir: this.options.agentDir,
			skills: this.options.skills,
			setLang: (lang: Lang) => {
				this.options.registry.setLang(`${message.channel}-${message.chatId}`, lang);
			},
			startedAt: this.options.startedAt,
			version: this.options.version,
			enabledChannels: this.options.enabledChannels,
			qqQuota: this.options.qqQuota,
		};
	}
}

export { t };
