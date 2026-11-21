import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Adapter, ChannelName, Inbound, Lang, ReplyFormat } from "../channel/types.ts";
import type { JobStore } from "../cron/store.ts";
import type { NekoPalExtensionOptions } from "../extension/nekopal-extension.ts";
import { languageFromCode } from "../i18n/index.ts";
import { log, logError } from "../log.ts";
import type { MemoryStore, PendingStore } from "../memory/store.ts";
import type { StateStore } from "../state.ts";
import { ChatContext } from "./context.ts";

export interface ChatRegistryOptions {
	state: StateStore;
	workspace: string;
	agentDir: string;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	memory: MemoryStore;
	pending: PendingStore;
	jobs: JobStore;
	redactor: NekoPalExtensionOptions["redactor"];
	defaultLang: Lang;
}

/** One ChatContext per channel chat, created on first use. */
export class ChatRegistry {
	private readonly options: ChatRegistryOptions;
	private readonly chats = new Map<string, ChatContext>();
	private readonly opening = new Map<string, Promise<ChatContext>>();
	private readonly adapters = new Map<string, Adapter>();

	constructor(options: ChatRegistryOptions) {
		this.options = options;
	}

	registerAdapter(adapter: Adapter): void {
		this.adapters.set(adapter.name, adapter);
	}

	adapterFor(name: ChannelName): Adapter | undefined {
		return this.adapters.get(name);
	}

	get size(): number {
		return this.chats.size;
	}

	all(): ChatContext[] {
		return [...this.chats.values()];
	}

	get running(): number {
		return this.all().filter((chat) => chat.isRunning).length;
	}

	/** Language a delivery to `chatId` uses: the open chat's, else the stored one, else the default. */
	langFor(channel: string, chatId: string): Lang {
		const key = `${channel}-${chatId}`;
		return this.chats.get(key)?.lang ?? this.options.state.chats[key]?.lang ?? this.options.defaultLang;
	}

	/** The chat for a message, created and started on first contact. */
	async chatFor(message: Inbound): Promise<ChatContext> {
		const key = `${message.channel}-${message.chatId}`;
		const existing = this.chats.get(key);
		if (existing) return existing;
		const pending = this.opening.get(key);
		if (pending) return pending;

		const adapter = this.adapters.get(message.channel);
		if (!adapter) throw new Error(`No adapter for ${message.channel}`);
		const lang =
			this.options.state.chats[key]?.lang ?? languageFromCode(message.languageCode) ?? this.options.defaultLang;
		const context: ChatContext = new ChatContext({
			adapter,
			chatId: message.chatId,
			userId: message.userId,
			lang,
			telegramReplyFormat: this.options.state.chats[key]?.telegramReplyFormat,
			workspace: this.options.workspace,
			agentDir: this.options.agentDir,
			settingsManager: this.options.settingsManager,
			modelRuntime: this.options.modelRuntime,
			memory: this.options.memory,
			pending: this.options.pending,
			jobs: this.options.jobs,
			redactor: this.options.redactor,
			onPromptNotice: (text) => context.sendMenuNotice(text, context.pendingPrompt),
		});
		context.setReviewEveryTurns(this.options.settingsManager.getNekoPal().memory?.reviewEveryTurns ?? 0);
		const ready = context
			.start()
			.then(() => {
				this.chats.set(key, context);
				log("info", `opened chat ${key}`);
				return context;
			})
			.finally(() => this.opening.delete(key));
		this.opening.set(key, ready);
		return ready;
	}

	/** Set a chat's language and persist it. */
	setLang(key: string, lang: Lang): void {
		this.options.state.mutate((state) => {
			state.chats[key] = { ...state.chats[key], lang };
		});
		const chat = this.chats.get(key);
		if (chat) chat.lang = lang;
	}

	setReplyFormat(chat: ChatContext, format: ReplyFormat): void {
		const key = `${chat.adapter.name}-${chat.chatId}`;
		this.options.state.mutate((state) => {
			state.chats[key] = { ...state.chats[key], telegramReplyFormat: format };
		});
		chat.telegramReplyFormat = format;
	}

	async dispose(): Promise<void> {
		await Promise.allSettled(this.opening.values());
		for (const chat of this.chats.values()) {
			try {
				await chat.dispose();
			} catch (error) {
				logError("could not dispose a chat", error);
			}
		}
		this.chats.clear();
	}
}
