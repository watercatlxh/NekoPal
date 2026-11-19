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
	stop(): Promise<void>;
}
