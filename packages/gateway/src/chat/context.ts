import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	ExtensionUIContext,
	ModelRuntime,
	SessionInfo,
	SettingsManager,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	noOpUIContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Adapter, Lang, SentHandle } from "../channel/types.ts";
import type { JobStore } from "../cron/store.ts";
import type { NekoPalExtensionOptions } from "../extension/nekopal-extension.ts";
import { nekopalExtension } from "../extension/nekopal-extension.ts";
import { t } from "../i18n/index.ts";
import { logError } from "../log.ts";
import { formatTranscript, MemoryReview } from "../memory/review.ts";
import type { MemoryStore, PendingStore } from "../memory/store.ts";
import { SESSIONS_DIR } from "../paths.ts";
import { configSetTool } from "../tools/config-set.ts";
import { cronTool } from "../tools/cron.ts";
import { memoryTool } from "../tools/memory.ts";
import { sendTool } from "../tools/send.ts";
import { builtInExtensions } from "./builtin-extensions.ts";
import type { ChatController } from "./reply.ts";
import { ReplyController } from "./reply.ts";

/** The text blocks of a message, which is a string for user turns and blocks for assistant turns. */
function textOf(content: UserMessage["content"] | AssistantMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Prompt waiting for the user's next message, used by `/login` and extension dialogs. */
export interface PendingPrompt {
	question: string;
	resolve(value: string): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

export interface ChatContextOptions {
	adapter: Adapter;
	chatId: string;
	userId: string;
	lang: Lang;
	workspace: string;
	agentDir: string;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	memory: MemoryStore;
	pending: PendingStore;
	jobs: JobStore;
	redactor: NekoPalExtensionOptions["redactor"];
	onPromptNotice?(text: string): void;
}

/**
 * One conversation: its agent runtime, serial prompt queue, reply controller and UI context.
 *
 * Messages for one chat are handled one at a time in arrival order; a message that arrives while a
 * reply is running is queued into the session as a follow-up.
 */
export class ChatContext implements ChatController {
	readonly adapter: Adapter;
	readonly chatId: string;
	readonly userId: string;
	readonly statuses = new Map<string, string>();
	/** Inbound message this chat is answering, for platforms whose replies must reference it. */
	replyTo: string | undefined;
	lang: Lang;
	readonly workspace: string;
	readonly agentDir: string;
	readonly memory: MemoryStore;
	private readonly settingsManager: SettingsManager;
	private readonly modelRuntime: ModelRuntime;
	private readonly redactor: NekoPalExtensionOptions["redactor"];
	private readonly pendingStore: PendingStore;
	private readonly jobs: JobStore;
	/** Extension load failures, reported to the chat before its first reply. */
	private extensionErrors = 0;
	private readonly onPromptNotice: ((text: string) => void) | undefined;
	private runtime!: AgentSessionRuntime;
	private readonly reply: ReplyController;
	private queue: Promise<void> = Promise.resolve();
	private pending: PendingPrompt | undefined;
	private unsubscribes: Array<() => void> = [];
	private running = 0;
	private loginAbort: (() => void) | undefined;
	private userTurns = 0;
	private readonly review: MemoryReview;
	private reviewEveryTurns = 0;

	constructor(options: ChatContextOptions) {
		this.adapter = options.adapter;
		this.chatId = options.chatId;
		this.userId = options.userId;
		this.lang = options.lang;
		this.workspace = options.workspace;
		this.agentDir = options.agentDir;
		this.memory = options.memory;
		this.pendingStore = options.pending;
		this.jobs = options.jobs;
		this.settingsManager = options.settingsManager;
		this.modelRuntime = options.modelRuntime;
		this.redactor = options.redactor;
		this.onPromptNotice = options.onPromptNotice;
		this.reply = new ReplyController(this);
		this.review = new MemoryReview({
			workspace: this.workspace,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
			modelRuntime: this.modelRuntime,
			memory: this.memory,
			pending: this.pendingStore,
		});
	}

	get session(): AgentSession {
		return this.runtime.session;
	}

	get isRunning(): boolean {
		return this.running > 0;
	}

	get pendingPrompt(): PendingPrompt | undefined {
		return this.pending;
	}

	/** Create the session and bind extensions; call once at startup. */
	async start(): Promise<void> {
		const sessionDir = join(SESSIONS_DIR, `${this.adapter.name}-${this.chatId}`);
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(this.workspace, { recursive: true });

		this.runtime = await createAgentSessionRuntime(
			async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir,
					settingsManager: this.settingsManager,
					modelRuntime: this.modelRuntime,
					resourceLoaderOptions: {
						extensionFactories: [
							...builtInExtensions,
							nekopalExtension({
								channel: this.adapter.name,
								memory: this.memory,
								redactor: this.redactor,
							}),
						],
					},
				});
				const created = await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					customTools: this.customTools(),
				});
				const failed = services.resourceLoader.getExtensions().errors;
				this.extensionErrors = failed.length;
				for (const error of failed) logError(`extension failed to load: ${error.path}`, error.error);
				void this.reportExtensionErrors();
				return { ...created, services, diagnostics: services.diagnostics };
			},
			{
				cwd: this.workspace,
				agentDir: this.agentDir,
				sessionManager: SessionManager.continueRecent(this.workspace, sessionDir),
			},
		);
		this.runtime.setRebindSession(async (session) => this.bind(session));
		await this.bind(this.runtime.session);
	}

	/** Tell the chat about extensions that failed to load, once per session start. */
	private async reportExtensionErrors(): Promise<void> {
		const count = this.extensionErrors;
		if (count === 0) return;
		await this.say("ext.loadErrors", { n: count });
	}

	/** The NekoPal tools: memory, cron, send and config_set, all bound to this chat. */
	private customTools(): ToolDefinition[] {
		const deliver = { channel: this.adapter.name, chatId: this.chatId };
		return [
			memoryTool({ store: this.memory, pending: this.pendingStore, origin: "chat" }),
			cronTool({ store: this.jobs, deliver }),
			sendTool({ adapter: this.adapter, chatId: this.chatId, cwd: this.workspace }),
			configSetTool({ settingsManager: this.settingsManager }),
		];
	}

	private async bind(session: AgentSession): Promise<void> {
		for (const unsubscribe of this.unsubscribes) unsubscribe();
		this.unsubscribes = [];
		this.unsubscribes.push(
			session.subscribe((event) => {
				void this.onSessionEvent(event);
			}),
		);
		await session.bindExtensions({
			mode: "rpc",
			uiContext: this.uiContext(),
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => this.runtime.newSession(options),
				fork: async (entryId, options) => {
					const result = await this.runtime.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => this.runtime.switchSession(sessionPath, options),
				reload: async () => {
					await session.reload();
				},
			},
			onError: (error) => {
				logError(`extension error in ${error.extensionPath} (${error.event})`, error.error);
			},
		});
	}

	private async onSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") this.running++;
		if (event.type === "agent_settled") {
			this.running = Math.max(0, this.running - 1);
			if (this.running === 0) void this.maybeReview();
		}
		try {
			await this.reply.onEvent(event);
		} catch (error) {
			logError("reply failed", error);
		}
	}

	/** The extension UI context: dialogs become chat questions, statuses join the progress line. */
	private uiContext(): ExtensionUIContext {
		return {
			...noOpUIContext,
			get theme() {
				return noOpUIContext.theme;
			},
			notify: (message, type) => {
				const prefix = type === "warning" ? "⚠️ " : type === "error" ? "❌ " : "";
				void this.sendPlain(`${prefix}${message}`);
			},
			setStatus: (key, text) => {
				if (text === undefined) this.statuses.delete(key);
				else this.statuses.set(key, text);
			},
			setWidget: (key, lines) => {
				const value = typeof lines === "function" ? undefined : lines;
				if (value === undefined) this.statuses.delete(key);
				else this.statuses.set(key, value.join(" | "));
			},
			select: async (title, options) => {
				const list = options.map((option, index) => `${index + 1}. ${option}`).join("\n");
				const answer = await this.ask(`${title}\n${list}`);
				if (answer === undefined) return undefined;
				const index = Number(answer.trim());
				return Number.isInteger(index) && index >= 1 && index <= options.length ? options[index - 1] : answer;
			},
			input: async (title, placeholder) => this.ask(placeholder ? `${title}\n(${placeholder})` : title),
			confirm: async (title, message) => {
				const answer = await this.ask(`${title}\n${message}\n\n(y/n)`);
				return answer !== undefined && /^(y|yes|是|好)$/i.test(answer.trim());
			},
		};
	}

	/** Ask the user a question; resolves with their next message, or undefined after 10 minutes. */
	ask(question: string): Promise<string | undefined> {
		this.cancelPending();
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const timer = setTimeout(() => {
			this.pending = undefined;
			resolve(undefined);
		}, 10 * 60_000);
		timer.unref();
		this.pending = {
			question,
			resolve: (value) => {
				clearTimeout(timer);
				resolve(value);
			},
			reject: () => {
				clearTimeout(timer);
				resolve(undefined);
			},
			timer,
		};
		this.onPromptNotice?.(question);
		return promise;
	}

	/** Answer the pending question with the user's message; false when nothing was pending. */
	answerPending(text: string): boolean {
		const pending = this.pending;
		if (!pending) return false;
		this.pending = undefined;
		clearTimeout(pending.timer);
		pending.resolve(text);
		return true;
	}

	/** Register the abort used when `/cancel` answers a login prompt; undefined clears it. */
	setLoginAbort(abort: (() => void) | undefined): void {
		this.loginAbort = abort;
	}

	/** Cancel a pending question; `/cancel` also aborts a login waiting for its answer. */
	cancelPending(): void {
		const abort = this.loginAbort;
		const pending = this.pending;
		if (pending) {
			this.pending = undefined;
			clearTimeout(pending.timer);
			pending.reject(new Error("cancelled"));
		}
		abort?.();
	}

	/** Count a user turn and run the background review when the configured interval is reached. */
	noteUserTurn(): void {
		this.userTurns++;
	}

	/** Set the review interval; 0 disables it. */
	setReviewEveryTurns(turns: number): void {
		this.reviewEveryTurns = turns;
	}

	/** The review reads the chat's own transcript, so it sees what the user actually said. */
	private async maybeReview(): Promise<void> {
		if (this.reviewEveryTurns <= 0 || this.userTurns < this.reviewEveryTurns || this.review.isRunning) return;
		this.userTurns = 0;
		const messages = this.session.messages
			.filter((message) => message.role === "user" || message.role === "assistant")
			.map((message) => ({ role: message.role, text: textOf(message.content) }));
		const staged = await this.review.review(formatTranscript(messages));
		if (staged > 0) await this.say("memory.pendingNotice", { n: staged });
	}

	/** Run `task` after every earlier task of this chat. */
	enqueue(task: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(task).catch((error) => {
			logError("chat task failed", error);
		});
		return this.queue;
	}

	async send(markdown: string): Promise<SentHandle[]> {
		return this.adapter.sendMarkdown(this.chatId, markdown, this.replyTo);
	}

	async sendPlain(text: string): Promise<void> {
		await this.adapter.sendMarkdown(this.chatId, text, this.replyTo);
	}

	async deleteMessage(handle: SentHandle): Promise<void> {
		await this.adapter.deleteMessage(this.chatId, handle);
	}

	/** Reply with a translated message. */
	async say(key: Parameters<typeof t>[1], vars?: Record<string, string | number>): Promise<void> {
		await this.sendPlain(t(this.lang, key, vars));
	}

	/** Start a fresh session for this chat. */
	async newSession(): Promise<void> {
		await this.runtime.newSession();
	}

	/** Switch to the session file at `path`. */
	async switchSession(path: string): Promise<void> {
		await this.runtime.switchSession(path);
	}

	/** Recent sessions of this chat, newest first. */
	async listSessions(): Promise<SessionInfo[]> {
		return SessionManager.list(this.workspace, join(SESSIONS_DIR, `${this.adapter.name}-${this.chatId}`));
	}

	async dispose(): Promise<void> {
		this.cancelPending();
		for (const unsubscribe of this.unsubscribes) unsubscribe();
		this.unsubscribes = [];
		await this.runtime.dispose();
	}
}
