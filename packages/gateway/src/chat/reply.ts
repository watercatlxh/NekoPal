import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { logError } from "../log.ts";
import type { Adapter, SentHandle } from "../channel/types.ts";
import type { MessageKey, Lang } from "../i18n/index.ts";
import { t } from "../i18n/index.ts";

/** Minimum time between two edits of the placeholder, so a fast stream stays inside rate limits. */
const EDIT_INTERVAL_MS = 1_500;
/** Placeholder text while the first tool runs, before any reply text exists. */
const PLACEHOLDER = "⏳";
/** Plain-text preview length during streaming; the final message is sent separately. */
const PREVIEW_CHARS = 4_000;

function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

/**
 * Turns session events into chat messages.
 *
 * The first output is a placeholder message that is edited in place into a progress line and then
 * into the reply text; when editing is unavailable (QQ) the reply is sent once, at the end.
 */
export class ReplyController {
	private readonly chat: ChatController;
	private placeholder: SentHandle | undefined;
	private startedAt = 0;
	private toolCount = 0;
	private lastTool: string | undefined;
	private lastEditAt = 0;
	private text = "";
	private timer: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(chat: ChatController) {
		this.chat = chat;
	}

	/** Translate with the chat's current language. */
	private message(key: MessageKey, vars?: Record<string, string | number>): string {
		return t(this.chat.lang, key, vars);
	}

	async onEvent(event: AgentSessionEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				await this.begin();
				return;
			case "tool_execution_start":
				this.toolCount++;
				this.lastTool = event.toolName;
				this.scheduleProgress();
				return;
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					this.text += event.assistantMessageEvent.delta;
					this.scheduleProgress();
				}
				return;
			case "message_end":
				if (event.message.role === "assistant") await this.finishMessage(event.message);
				return;
			case "agent_settled":
				await this.settle();
				return;
		}
	}

	private async begin(): Promise<void> {
		this.stopped = false;
		this.text = "";
		this.toolCount = 0;
		this.lastTool = undefined;
		this.startedAt = Date.now();
		this.lastEditAt = 0;
		if (!this.chat.adapter.caps.edit) return;
		this.placeholder = (await this.chat.send(PLACEHOLDER))[0];
	}

	private progressLine(): string {
		const parts = [`⏳ ${formatElapsed(Date.now() - this.startedAt)}`];
		if (this.lastTool) parts.push(this.lastTool);
		if (this.toolCount > 0) parts.push(`${this.toolCount} ${this.toolCount === 1 ? "tool" : "tools"}`);
		const statuses = [...this.chat.statuses.values()];
		if (statuses.length > 0) parts.push(statuses.join(" · "));
		return parts.join(" · ");
	}

	/** Edit the placeholder at most once per interval; the timer flushes the newest text. */
	private scheduleProgress(): void {
		if (!this.placeholder || this.timer) return;
		const wait = Math.max(0, this.lastEditAt + EDIT_INTERVAL_MS - Date.now());
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flushProgress();
		}, wait);
		this.timer.unref();
	}

	private async flushProgress(): Promise<void> {
		const placeholder = this.placeholder;
		if (!placeholder || this.stopped) return;
		this.lastEditAt = Date.now();
		const body = this.text.trim().length > 0 ? this.text.slice(-PREVIEW_CHARS) : this.progressLine();
		try {
			await this.chat.adapter.editText(this.chat.chatId, placeholder, body);
		} catch (error) {
			logError("could not update the placeholder", error);
		}
	}

	private async finishMessage(message: AssistantMessage): Promise<void> {
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		if (message.stopReason === "error") {
			await this.finalize(this.message("error.run", { message: message.errorMessage ?? "unknown error" }), true);
			return;
		}
		if (message.stopReason === "aborted") {
			await this.finalize(this.message("run.stopped"), true);
			return;
		}
		if (text.trim().length === 0) return;
		await this.finalize(text, false);
	}

	/** Replace the placeholder with the final Markdown, or send it when the channel cannot edit. */
	private async finalize(markdown: string, plain: boolean): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		const placeholder = this.placeholder;
		this.placeholder = undefined;
		if (placeholder) await this.chat.deleteMessage(placeholder);
		if (plain) {
			await this.chat.sendPlain(markdown);
			return;
		}
		await this.chat.send(markdown);
	}

	private async settle(): Promise<void> {
		clearTimeout(this.timer);
		this.timer = undefined;
		const placeholder = this.placeholder;
		this.placeholder = undefined;
		if (placeholder) await this.chat.deleteMessage(placeholder);
	}
}

/** What the reply controller needs from a chat. */
export interface ChatController {
	readonly adapter: Adapter;
	readonly chatId: string;
	readonly lang: Lang;
	readonly statuses: Map<string, string>;
	send(markdown: string): Promise<SentHandle[]>;
	sendPlain(text: string): Promise<void>;
	deleteMessage(handle: SentHandle): Promise<void>;
}
