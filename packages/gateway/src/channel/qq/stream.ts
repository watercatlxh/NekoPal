import type { SentHandle } from "../types.ts";
import type { QqApi } from "./api.ts";

/** Longest text one stream may carry; a longer reply ends the stream and continues as messages. */
const MAX_STREAM_CHARS = 3_000;

export interface StreamBudget {
	/** Reserve one reply slot; returns the frame fields, or undefined when the budget is spent. */
	take(): { msgId?: string; msgSeq?: number } | undefined;
}

export interface QqStreamOptions {
	api: QqApi;
	chatId: string;
	budget: StreamBudget;
	/** Delivers the part of a long reply that does not fit in the stream. */
	sendRest?(markdown: string): Promise<void>;
	logError(message: string, error: unknown): void;
}

/**
 * One streamed QQ reply: repeated `stream_messages` calls that replace the visible text.
 *
 * QQ rejects a stream whose prefix changes (40007), so every frame carries the same text prefix; a
 * reply longer than the limit ends the stream there and delivers the remainder as messages. The
 * first failure disables the stream for this reply, so the caller can send the final text normally.
 */
export class QqStream {
	private readonly options: QqStreamOptions;
	private readonly frame: { msgId?: string; msgSeq?: number };
	private streamId: string | undefined;
	private index = 0;
	private lastText = "";
	private degraded = false;
	private finished = false;

	private constructor(options: QqStreamOptions, frame: { msgId?: string; msgSeq?: number }) {
		this.options = options;
		this.frame = frame;
	}

	/** Open a stream, or return undefined when no reply slot is available. */
	static open(options: QqStreamOptions): QqStream | undefined {
		const frame = options.budget.take();
		if (frame === undefined) return undefined;
		return new QqStream(options, frame);
	}

	get isDegraded(): boolean {
		return this.degraded;
	}

	/** Replace the visible text. A failure degrades the stream instead of failing the reply. */
	async update(text: string): Promise<void> {
		if (this.degraded || this.finished) return;
		const content = streamPrefix(text);
		if (content === this.lastText) return;
		try {
			await this.post(content, 1);
			this.lastText = content;
		} catch (error) {
			this.degraded = true;
			this.options.logError("qq: stream update failed; sending the reply as a message", error);
		}
	}

	/** End the stream with the final text; returns the sent message, or undefined when degraded. */
	async finish(text: string): Promise<SentHandle | undefined> {
		if (this.finished) return undefined;
		this.finished = true;
		if (this.degraded) return undefined;

		const head = streamPrefix(text);
		const rest = text.slice(head.length).replace(/^\n+/, "");
		try {
			const response = await this.post(head, 10);
			if (rest !== "") await this.sendRest(rest);
			return { id: response.id ?? this.streamId ?? this.frame.msgId ?? "" };
		} catch (error) {
			this.degraded = true;
			this.options.logError("qq: could not finish the stream; sending the reply as a message", error);
			return undefined;
		}
	}

	/** Give up without sending the final text, used when a run is aborted. */
	abort(): void {
		this.finished = true;
	}

	/** Deliver the overflow of a long reply; without a handler the stream simply ends there. */
	private async sendRest(markdown: string): Promise<void> {
		const send = this.options.sendRest;
		if (send === undefined) {
			this.options.logError("qq: reply is longer than one stream and no overflow handler is set", undefined);
			return;
		}
		await send(markdown);
	}

	private async post(content: string, state: number): Promise<{ id?: string }> {
		const body: Record<string, unknown> = {
			input_mode: "replace",
			input_state: state,
			content_type: "markdown",
			content_raw: content,
			index: this.index++,
		};
		if (this.frame.msgId !== undefined) {
			body.msg_id = this.frame.msgId;
			body.msg_seq = this.frame.msgSeq;
		}
		if (this.streamId !== undefined) body.stream_msg_id = this.streamId;

		const response = await this.options.api.call<{ id?: string; stream_msg_id?: string }>(
			"POST",
			`/v2/users/${this.options.chatId}/stream_messages`,
			body,
		);
		if (typeof response.stream_msg_id === "string") this.streamId = response.stream_msg_id;
		return response;
	}
}

/** The part of `text` one stream carries, cut without splitting a surrogate pair. */
function streamPrefix(text: string): string {
	if (text.length <= MAX_STREAM_CHARS) return text;
	const code = text.charCodeAt(MAX_STREAM_CHARS - 1);
	const cut = code >= 0xd800 && code <= 0xdbff ? MAX_STREAM_CHARS - 1 : MAX_STREAM_CHARS;
	return text.slice(0, cut);
}
