import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { details, fence } from "../channel/telegram/rich.ts";
import type { Adapter, ChannelStream, Keyboard, SentHandle } from "../channel/types.ts";
import type { Lang, MessageKey } from "../i18n/index.ts";
import { t } from "../i18n/index.ts";
import { logError } from "../log.ts";
import { formatToolLine, resultText, summarizeArgs, type ToolLine, toolBody } from "./tool-summary.ts";

/** Minimum time between two edits of the reply message, so a fast stream stays inside rate limits. */
const EDIT_INTERVAL_MS = 1_500;
/** Delay before the first send, so a one-character bubble never flashes. */
const FIRST_SEND_DELAY_MS = 400;
/** Tool summaries a channel without editable messages shows in its one progress message. */
const MAX_SUMMARY_LINES = 3;
/** Typing indicators expire on the platform side, so refresh them well inside that window. */
const WORKING_REFRESH_MS = 5_000;
/** Plain-text preview length during streaming; the final message is sent separately. */
const PREVIEW_CHARS = 4_000;

/** One tool call and the message it owns. */
interface ToolEntry {
	readonly id: string;
	readonly name: string;
	readonly args: unknown;
	readonly summary: string;
	status: "running" | "ok" | "error";
	/** The message showing this call; absent on channels that cannot edit. */
	handle?: SentHandle;
	result?: string;
}

/**
 * Turns session events into chat messages.
 *
 * Two rendering paths, chosen by `caps`:
 *
 * - **Editable, rich channel (Telegram)**: every tool call gets its own message, sent when the call
 *   starts and edited when it ends, with the arguments and output folded behind a `<details>`
 *   summary. The reply text is a separate message, created on the first delta and edited in place
 *   until it is final. Nothing is ever deleted except a reply that outgrew one message.
 * - **Streaming channel (QQ)**: no edits and a tight reply budget, so the calls collapse into one
 *   summary message and the reply goes out through the platform's stream.
 */
export class ReplyController {
	private readonly chat: ChatController;
	/** The reply text's message, on channels that can edit it. */
	private handle: SentHandle | undefined;
	private tools: ToolEntry[] = [];
	private lastEditAt = 0;
	private firstFlush = true;
	/** Whether a channel without editable messages already got its one tool-summary message. */
	private noticeSent = false;
	private text = "";
	private timer: NodeJS.Timeout | undefined;
	private workingTimer: NodeJS.Timeout | undefined;
	private stopped = false;
	private stream: ChannelStream | undefined;

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
			case "tool_execution_start": {
				// A call a tool made through `executeTool` belongs to its parent's message.
				if (event.parentToolCallId !== undefined) return;
				const entry: ToolEntry = {
					id: event.toolCallId,
					name: event.toolName,
					args: event.args,
					summary: summarizeArgs(event.toolName, event.args),
					status: "running",
				};
				this.tools.push(entry);
				await this.toolStarted(entry);
				return;
			}
			case "tool_execution_end": {
				if (event.parentToolCallId !== undefined) return;
				const entry = this.tools.find((candidate) => candidate.id === event.toolCallId);
				if (!entry) return;
				entry.status = event.isError ? "error" : "ok";
				entry.result = resultText(event.result);
				await this.toolFinished(entry);
				return;
			}
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
		this.tools = [];
		this.handle = undefined;
		this.lastEditAt = 0;
		this.firstFlush = true;
		this.noticeSent = false;
		this.stream = this.chat.adapter.caps.stream
			? this.chat.adapter.openStream(this.chat.chatId, this.chat.replyTo)
			: undefined;
		// Platforms that show a typing indicator get one as soon as the run starts.
		await this.chat.adapter.notifyWorking(this.chat.chatId, this.chat.replyTo);
		this.scheduleWorkingNotice();
	}

	/**
	 * The fold for one call: `emoji name · summary` stays visible, the arguments and output hide
	 * behind a `<details>` whose summary is just the toggle word.
	 */
	private fold(entry: ToolEntry): string {
		const marker = entry.status === "ok" ? "✓" : entry.status === "error" ? "✗" : "🔧";
		const head =
			entry.summary === "" ? `${marker} **${entry.name}**` : `${marker} **${entry.name}** · ${entry.summary}`;
		const body = toolBody(entry.args, entry.result ?? "");
		const toggle = this.message(entry.status === "error" ? "reply.foldFailed" : "reply.fold");
		return `${head}\n${details(toggle, body === "" ? "" : fence("", body))}`;
	}

	/** A call started: on an editable rich channel it gets a message of its own, folded. */
	private async toolStarted(entry: ToolEntry): Promise<void> {
		if (this.stopped) return;
		if (!this.chat.adapter.caps.edit || !this.chat.adapter.caps.rich) {
			// A channel without edits cannot rewrite the message, so the calls share one summary
			// message sent after the first delay, and a long run is summarised once.
			this.scheduleProgress();
			return;
		}
		try {
			entry.handle = await this.chat.sendRich(this.fold(entry), this.chat.replyTo);
		} catch (error) {
			logError("could not send the tool message", error);
		}
	}

	/** A call ended: rewrite its own message with the output and the final marker. */
	private async toolFinished(entry: ToolEntry): Promise<void> {
		if (this.stopped) return;
		const handle = entry.handle;
		if (handle === undefined) {
			this.scheduleProgress();
			return;
		}
		try {
			await this.chat.editRich(handle, this.fold(entry));
		} catch (error) {
			logError("could not update the tool message", error);
		}
	}

	/** The call lines a channel without per-call messages shows, newest first. */
	private summaryLines(): string[] {
		const shown = this.tools.slice(0, MAX_SUMMARY_LINES);
		const overflow = this.tools.length - shown.length;
		const lines: string[] = [this.message("reply.tools", { n: this.tools.length })];
		for (const entry of shown) lines.push(formatToolLine(entry as ToolLine));
		if (overflow > 0) lines.push(this.message("reply.toolsMore", { n: overflow }));
		return lines;
	}

	/** Refresh the typing indicator while the run lasts; a no-op on channels without one. */
	private scheduleWorkingNotice(): void {
		if (this.workingTimer) return;
		this.workingTimer = setInterval(() => {
			void this.chat.adapter.notifyWorking(this.chat.chatId, this.chat.replyTo);
		}, WORKING_REFRESH_MS);
		this.workingTimer.unref();
	}

	private stopWorkingNotice(): void {
		clearInterval(this.workingTimer);
		this.workingTimer = undefined;
	}

	/** Push the newest reply text at most once per interval. */
	private scheduleProgress(): void {
		if (this.timer) return;
		const interval = this.firstFlush ? FIRST_SEND_DELAY_MS : EDIT_INTERVAL_MS;
		const wait = Math.max(0, this.lastEditAt + interval - Date.now());
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flushProgress();
		}, wait);
		this.timer.unref();
	}

	private async flushProgress(): Promise<void> {
		if (this.stopped) return;
		this.lastEditAt = Date.now();
		this.firstFlush = false;
		if (this.stream) {
			// No edits on this path, so the calls share one message. It waits for the first call to
			// finish: sent at the start it would only ever show a running marker.
			const settled = this.tools.some((entry) => entry.status !== "running");
			if (!this.chat.adapter.caps.edit && !this.noticeSent && settled) {
				this.noticeSent = true;
				await this.chat.sendPlain(this.summaryLines().join("\n"));
			}
			if (this.text.trim().length === 0) return;
			await this.stream.update(this.text);
			return;
		}
		if (!this.chat.adapter.caps.edit) return;
		const preview = this.text.slice(-PREVIEW_CHARS);
		if (preview.trim() === "") return;
		const handle = this.handle;
		if (handle === undefined) {
			this.handle = await this.chat.sendRich(preview, this.chat.replyTo);
			return;
		}
		try {
			await this.chat.adapter.editText(this.chat.chatId, handle, preview);
		} catch (error) {
			logError("could not update the reply message", error);
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

	/** Finish the reply: end the stream, edit the reply message in place, or send it. */
	private async finalize(markdown: string, plain: boolean): Promise<void> {
		this.stopped = true;
		this.stopWorkingNotice();
		clearTimeout(this.timer);
		this.timer = undefined;
		const stream = this.stream;
		this.stream = undefined;
		if (stream) {
			// The stream already claimed a reply slot, so finishing it is what delivers the reply.
			if (!plain && (await stream.finish(markdown)) !== undefined) return;
			stream.abort();
		}
		const handle = this.handle;
		this.handle = undefined;
		if (handle !== undefined) {
			const edited = plain
				? await this.chat.adapter
						.editText(this.chat.chatId, handle, markdown)
						.then(() => true)
						.catch((error: unknown) => {
							logError("could not finalize the reply message", error);
							return false;
						})
				: await this.chat.editRich(handle, markdown).catch((error: unknown) => {
						logError("could not finalize the reply message", error);
						return false;
					});
			if (edited) return;
			await this.chat.deleteMessage(handle);
		}
		if (plain) {
			await this.chat.sendPlain(markdown);
			return;
		}
		await this.chat.send(markdown);
	}

	private async settle(): Promise<void> {
		this.stopWorkingNotice();
		clearTimeout(this.timer);
		this.timer = undefined;
		this.stream?.abort();
		this.stream = undefined;
		this.handle = undefined;
	}
}

/** What the reply controller needs from a chat. */
export interface ChatController {
	readonly adapter: Adapter;
	readonly chatId: string;
	/** Message id of the inbound message, so a reply can take a passive slot. */
	readonly replyTo: string | undefined;
	readonly lang: Lang;
	send(markdown: string): Promise<SentHandle[]>;
	sendPlain(text: string): Promise<void>;
	/** Send one message as rich Markdown, with optional buttons. */
	sendRich(markdown: string, replyTo?: string, keyboard?: Keyboard): Promise<SentHandle>;
	/** Replace a message with rich Markdown; false when it does not fit or cannot be edited. */
	editRich(handle: SentHandle, markdown: string, keyboard?: Keyboard): Promise<boolean>;
	deleteMessage(handle: SentHandle): Promise<void>;
}
