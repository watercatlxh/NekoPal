export type Lang = "en" | "zh";

/** One attachment the user sent with a message. */
export interface Attachment {
	kind: "image" | "file";
	mimeType: string;
	fileName: string;
	data: Buffer;
	/** Speech-to-text of a voice message, when the platform provides it. */
	transcript?: string;
}

/** What a channel can do, so the reply layer knows which rendering path to take. */
export interface Caps {
	/** Whether a sent message can be edited in place. */
	edit: boolean;
	/** Whether the channel renders token-by-token stream updates. */
	stream: boolean;
	/** Maximum characters in one rendered message. */
	maxChars: number;
}

export type ChannelName = "telegram" | "qq";

/** A message received from a user. */
export interface Inbound {
	channel: ChannelName;
	/** Chat to reply to: the Telegram chat id or the QQ user openid. */
	chatId: string;
	/** Sender identity the allowlist checks. */
	userId: string;
	/** Platform message id, used for QQ passive replies. */
	messageId: string;
	text: string;
	attachments: Attachment[];
	/** Platform-reported language code, when the platform sends one. */
	languageCode?: string;
}

/** Handle of a message already sent, so it can be edited later. */
export interface SentHandle {
	id: string;
}

/**
 * A reply rendered progressively by the platform itself, such as QQ's `stream_messages`.
 *
 * `update` replaces the visible text; `finish` sends the final text and returns the message handle
 * when the stream delivered it, or undefined when the stream degraded and the caller must send the
 * reply normally.
 */
export interface ChannelStream {
	update(text: string): Promise<void>;
	finish(text: string): Promise<SentHandle | undefined>;
	abort(): void;
}

export interface Adapter {
	readonly name: ChannelName;
	readonly caps: Caps;
	/**
	 * Start receiving. `onInbound` is called for every message; this promise resolves once the
	 * receive loop is running and never rejects: connection problems are retried internally.
	 */
	start(onInbound: (message: Inbound) => void): Promise<void>;
	/** Render, split and send `markdown`, falling back to plain text when rendering fails. */
	sendMarkdown(chatId: string, markdown: string, replyTo?: string): Promise<SentHandle[]>;
	/** Replace the text of a sent message. Throws when `caps.edit` is false. */
	editText(chatId: string, handle: SentHandle, plain: string): Promise<void>;
	/** Remove a sent message, used to swap a placeholder for the final reply. */
	deleteMessage(chatId: string, handle: SentHandle): Promise<void>;
	/** Send local files, as images where the platform supports them. */
	sendFiles(chatId: string, paths: string[], replyTo?: string): Promise<void>;
	/** Open a platform-rendered stream for one reply, or undefined when the channel cannot stream. */
	openStream(chatId: string, replyTo?: string): ChannelStream | undefined;
	/**
	 * Announce that a reply is being worked on, for platforms that show a typing indicator. A channel
	 * without one does nothing.
	 */
	notifyWorking(chatId: string, replyTo?: string): Promise<void>;
	stop(): Promise<void>;
}
