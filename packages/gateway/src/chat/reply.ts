import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Adapter, ChannelStream, SentHandle } from "../channel/types.ts";
import type { Lang, MessageKey } from "../i18n/index.ts";
import { t } from "../i18n/index.ts";
import { logError } from "../log.ts";

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
 * Two delivery paths: channels that can edit (Telegram) get a placeholder message edited into a
 * progress line and then the reply text; channels that render a stream themselves (QQ) get the text
 * pushed through `openStream`. When neither is available the reply is sent once, at the end.
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
	private stream: ChannelStream | undefined;
	private streamed = false;

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
		this.streamed = false;
		this.toolCount = 0;
		this.lastTool = undefined;
		this.startedAt = Date.now();
		this.lastEditAt = 0;
		this.stream = this.chat.adapter.caps.stream
			? this.chat.adapter.openStream(this.chat.chatId, this.chat.replyTo)
			: undefined;
		if (this.stream || !this.chat.adapter.caps.edit) return;
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

	/** Push the newest text at most once per interval, to the stream or the placeholder. */
	private scheduleProgress(): void {
		if ((!this.placeholder && !this.stream) || this.timer) return;
		const wait = Math.max(0, this.lastEditAt + EDIT_INTERVAL_MS - Date.now());
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flushProgress();
		}, wait);
		this.timer.unref();
	}

	private async flushProgress(): Promise<void> {
		if (this.stopped) return;
		this.lastEditAt = Date.now();
		if (this.stream) {
			if (this.text.trim().length === 0) return;
			this.streamed = true;
			await this.stream.update(this.text);
			return;
		}
		const placeholder = this.placeholder;
		if (!placeholder) return;
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

	/** Finish the reply: end the stream, replace the placeholder, or send the Markdown. */
	private async finalize(markdown: string, plain: boolean): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		const stream = this.stream;
		this.stream = undefined;
		const placeholder = this.placeholder;
		this.placeholder = undefined;
		if (stream) {
			// The stream carries the reply only when it is still healthy and carries the same text.
			if (!plain && this.streamed && (await stream.finish(markdown)) !== undefined) return;
			stream.abort();
		}
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
		this.stream?.abort();
		this.stream = undefined;
		const placeholder = this.placeholder;
		this.placeholder = undefined;
		if (placeholder) await this.chat.deleteMessage(placeholder);
	}
}

/** What the reply controller needs from a chat. */
export interface ChatController {
	readonly adapter: Adapter;
	readonly chatId: string;
	/** Message id of the inbound message, so a reply can take a passive slot. */
	readonly replyTo: string | undefined;
	readonly lang: Lang;
	readonly statuses: Map<string, string>;
	send(markdown: string): Promise<SentHandle[]>;
	sendPlain(text: string): Promise<void>;
	deleteMessage(handle: SentHandle): Promise<void>;
}
