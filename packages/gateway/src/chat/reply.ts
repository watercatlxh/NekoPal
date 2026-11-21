import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { RICH_LIMIT } from "../channel/telegram/rich.ts";
import {
	type Adapter,
	type ChannelStream,
	type ReplyFormat,
	type SentHandle,
	ToolCallRejected,
} from "../channel/types.ts";
import type { Lang } from "../i18n/index.ts";
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
/** Keep previews (including a rejected rich send's Markdown fallback) inside one source chunk. */
const PREVIEW_CHARS = 3_500;

interface ToolEntry extends ToolLine {
	readonly args: unknown;
	/** The first send, which may still be in flight when the agent reports the result. */
	initial?: Promise<SentHandle>;
}

/** State for exactly one assistant message, retained by its queued finalizer. */
interface AssistantOutput {
	text: string;
	stream?: ChannelStream;
	handle?: SentHandle;
	previewAttempted: boolean;
	shown?: string;
	lastFlushAt?: number;
	timer?: NodeJS.Timeout;
	flushPending: boolean;
}

/** Events are not awaited by the agent. Take ownership synchronously and serialize only delivery. */
export class ReplyController {
	private readonly chat: ChatController;
	private run?: RunDelivery;

	constructor(chat: ChatController) {
		this.chat = chat;
	}

	async onEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "agent_start") {
			void this.run?.settle();
			this.run = new RunDelivery(this.chat);
			return;
		}
		const run = this.run;
		if (event.type === "agent_settled") {
			this.run = undefined;
			await run?.settle();
		} else {
			await run?.onEvent(event);
		}
	}
}

class RunDelivery {
	private readonly adapter: Adapter;
	private readonly chatId: string;
	private readonly replyTo: string | undefined;
	private readonly lang: Lang;
	private readonly format: ReplyFormat;
	private readonly tools = new Map<string, ToolEntry>();
	private tail = Promise.resolve();
	private output?: AssistantOutput;
	private readonly workingTimer: NodeJS.Timeout;
	private summaryTimer?: NodeJS.Timeout;
	private summarySent = false;
	private stopped = false;

	constructor(chat: ChatController) {
		// ChatContext.replyTo can change while a delivery from this run is still pending.
		this.adapter = chat.adapter;
		this.chatId = chat.chatId;
		this.replyTo = chat.replyTo;
		this.lang = chat.lang;
		this.format = this.adapter.name === "telegram" && chat.telegramReplyFormat === "mdv2" ? "mdv2" : "rich";
		// Reserve QQ's final reply slot before a typing notice or tool summary can spend it.
		if (this.adapter.caps.stream && !this.adapter.caps.edit) this.currentOutput();
		const notify = () =>
			this.adapter.notifyWorking(this.chatId, this.replyTo).catch((error: unknown) => {
				logError("could not send the working notice", error);
			});
		void notify();
		this.workingTimer = setInterval(notify, WORKING_REFRESH_MS);
		this.workingTimer.unref();
	}

	private enqueue<T>(operation: string, deliver: () => Promise<T>): Promise<T> {
		const result = this.tail.then(deliver);
		// One failure must not poison subsequent deliveries. Retain the original promise for
		// operations (notably tool edits) that need to distinguish a rejection from a timeout.
		this.tail = result.then(
			() => undefined,
			(error: unknown) => logError(operation, error),
		);
		return result;
	}

	onEvent(event: AgentSessionEvent): Promise<void> | void {
		if (this.stopped) return this.tail;
		switch (event.type) {
			case "tool_execution_start":
				if (event.parentToolCallId === undefined) this.toolStarted(event.toolCallId, event.toolName, event.args);
				break;
			case "tool_execution_end":
				if (event.parentToolCallId === undefined) this.toolFinished(event.toolCallId, event.result, event.isError);
				break;
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					const delta = event.assistantMessageEvent.delta;
					const output = this.currentOutput();
					output.text += delta;
					if (output.lastFlushAt !== undefined || delta.trim() !== "") this.scheduleProgress(output);
				}
				return; // Buffering a delta never waits for network I/O.
			case "message_end":
				if (event.message.role === "assistant") this.finishMessage(event.message);
				break;
		}
		return this.tail;
	}

	private toolStarted(id: string, name: string, args: unknown): void {
		if (this.tools.has(id)) return;
		const entry: ToolEntry = { id, name, args, summary: summarizeArgs(name, args), status: "running" };
		this.tools.set(id, entry);
		const { adapter, chatId, replyTo } = this;
		const send = adapter.sendToolCall;
		if (send && adapter.editToolCall) {
			entry.initial = this.enqueue("could not send the tool message", () =>
				send.call(adapter, chatId, name, toolBody(args, ""), replyTo),
			);
		}
	}

	private toolFinished(id: string, result: unknown, failed: boolean): void {
		const entry = this.tools.get(id);
		if (entry?.status !== "running") return;
		entry.status = failed ? "error" : "ok";
		const initial = entry.initial;
		if (!initial) {
			if (!this.summarySent && !this.summaryTimer) {
				this.summaryTimer = setTimeout(() => this.queueSummary(), FIRST_SEND_DELAY_MS);
				this.summaryTimer.unref();
			}
			return;
		}
		const { adapter, chatId, replyTo, lang } = this;
		void this.enqueue("could not finish the tool message", async () => {
			const details = toolBody(entry.args, resultText(result), failed ? t(lang, "reply.toolFailed") : undefined);
			let handle: SentHandle | undefined;
			try {
				handle = await initial;
			} catch (error) {
				if (!(error instanceof ToolCallRejected)) return; // Ambiguous delivery; never duplicate it.
			}
			if (handle && (await adapter.editToolCall!(chatId, handle, entry.name, details))) return;
			await adapter.sendToolCall!(chatId, entry.name, details, replyTo);
		});
	}

	/** On QQ the completed calls share one plain summary, even without a native stream. */
	private queueSummary(): void {
		clearTimeout(this.summaryTimer);
		this.summaryTimer = undefined;
		if (this.summarySent || (this.adapter.sendToolCall && this.adapter.editToolCall)) return;
		const entries = Array.from(this.tools.values());
		if (!entries.some((entry) => entry.status !== "running")) return;
		this.summarySent = true;
		const shown = entries.slice(0, MAX_SUMMARY_LINES);
		const lines = [t(this.lang, "reply.tools", { n: entries.length }), ...shown.map(formatToolLine)];
		if (shown.length < entries.length) {
			lines.push(t(this.lang, "reply.toolsMore", { n: entries.length - shown.length }));
		}
		void this.enqueue("could not send the tool summary", () =>
			this.adapter.sendMarkdown(this.chatId, lines.join("\n"), this.replyTo),
		);
	}

	private currentOutput(): AssistantOutput {
		this.output ??= {
			text: "",
			previewAttempted: false,
			flushPending: false,
			stream: this.adapter.caps.stream ? this.adapter.openStream(this.chatId, this.replyTo) : undefined,
		};
		return this.output;
	}

	private scheduleProgress(output: AssistantOutput): void {
		if (output.timer || output.flushPending || (!output.stream && !this.adapter.caps.edit)) return;
		if (output.previewAttempted && !output.handle) return;
		const wait =
			output.lastFlushAt === undefined
				? FIRST_SEND_DELAY_MS
				: Math.max(0, output.lastFlushAt + EDIT_INTERVAL_MS - Date.now());
		output.timer = setTimeout(() => {
			output.timer = undefined;
			output.flushPending = true;
			void this.enqueue("could not deliver the reply preview", async () => {
				if (output !== this.output) return; // A final arrived before this flush got its turn.
				output.lastFlushAt = Date.now();
				const text = output.text;
				try {
					await this.flushProgress(output, text);
				} finally {
					output.flushPending = false;
					if (output === this.output && output.text !== text) this.scheduleProgress(output);
				}
			});
		}, wait);
		output.timer.unref();
	}

	/** Pass original Markdown to the adapter; it owns rendering and any parse fallback. */
	private async sendAnswer(text: string): Promise<SentHandle | undefined> {
		const { adapter, chatId, replyTo } = this;
		if (this.format === "rich" && adapter.caps.rich && text.length <= RICH_LIMIT) {
			return adapter.sendRich(chatId, text, replyTo);
		}
		return (await adapter.sendMarkdown(chatId, text, replyTo))[0];
	}

	private editAnswer(handle: SentHandle, text: string): Promise<boolean> {
		const { adapter, chatId } = this;
		return this.format === "mdv2"
			? (adapter.editMarkdown?.(chatId, handle, text) ?? Promise.resolve(false))
			: adapter.editRich(chatId, handle, text);
	}

	private async flushProgress(output: AssistantOutput, text: string): Promise<void> {
		if (output.stream) {
			await output.stream.update(text);
			return;
		}
		let end = Math.min(PREVIEW_CHARS, this.adapter.caps.maxChars, text.length);
		if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
		const preview = text.slice(0, end);
		if (preview === output.shown || preview.trim() === "") return;
		if (output.handle) {
			// A timed-out edit may still have changed the remote text. Only deduplicate against
			// an acknowledged edit, never against what was visible before that request.
			output.shown = undefined;
			if (!(await this.editAnswer(output.handle, preview))) return;
		} else {
			if (output.previewAttempted) return;
			output.previewAttempted = true;
			output.handle = await this.sendAnswer(preview);
		}
		output.shown = preview;
	}

	private detachOutput(): AssistantOutput | undefined {
		const output = this.output;
		this.output = undefined;
		clearTimeout(output?.timer);
		return output;
	}

	private finishMessage(message: AssistantMessage): void {
		const plain = message.stopReason === "error" || message.stopReason === "aborted";
		let text: string;
		if (plain) {
			this.stop();
			text =
				message.stopReason === "error"
					? t(this.lang, "error.run", { message: message.errorMessage ?? "unknown error" })
					: t(this.lang, "run.stopped");
		} else {
			text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
		}
		// Lock the final now; neither a later delta nor settle may clear this output's pending handle.
		if (text.trim() === "") {
			if (this.output?.text) this.discardOutput(); // Otherwise keep any reserved QQ slot.
			return;
		}
		if (!plain) this.currentOutput();
		const output = this.detachOutput();
		this.queueSummary();
		void this.enqueue("could not finalize the reply message", () => this.finalize(output, text, plain));
	}

	private async finalize(output: AssistantOutput | undefined, text: string, plain: boolean): Promise<void> {
		const { adapter, chatId, replyTo } = this;
		if (output?.stream) {
			if (!plain && (await output.stream.finish(text)) !== undefined) return;
			output.stream.abort();
		}
		const handle = output?.handle;
		if (!handle && output?.previewAttempted) return; // A timed-out initial send may have succeeded.
		if (handle) {
			if (plain) {
				await adapter.editText(chatId, handle, text);
				return;
			}
			if (output.shown === text || (await this.editAnswer(handle, text))) return;
			// An explicit false (not an exception) permits replacement. Retain the preview if sending fails.
			const sent = await adapter.sendMarkdown(chatId, text, replyTo);
			if (sent.length > 0) await adapter.deleteMessage(chatId, handle);
		} else if (plain) {
			await adapter.sendMarkdown(chatId, text, replyTo);
		} else {
			await this.sendAnswer(text);
		}
	}

	private stop(): void {
		this.stopped = true;
		clearInterval(this.workingTimer);
	}

	private discardOutput(): void {
		const output = this.detachOutput();
		if (!output || (!output.stream && !output.previewAttempted)) return;
		// A send already in flight can still return its handle after an empty final or settle.
		void this.enqueue("could not discard the reply preview", async () => {
			output.stream?.abort();
			if (output.handle) await this.adapter.deleteMessage(this.chatId, output.handle);
		});
	}

	settle(): Promise<void> {
		this.stop();
		this.discardOutput();
		this.queueSummary();
		return this.tail;
	}
}

/** What the reply controller needs from a chat. */
export interface ChatController {
	readonly adapter: Adapter;
	readonly chatId: string;
	/** Message id of the inbound message, so a reply can take a passive slot. */
	readonly replyTo: string | undefined;
	readonly lang: Lang;
	readonly telegramReplyFormat?: ReplyFormat;
}
