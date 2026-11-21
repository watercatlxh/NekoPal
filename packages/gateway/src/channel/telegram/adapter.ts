import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveConfigValueOrThrow } from "@earendil-works/pi-coding-agent";
import { t } from "../../i18n/index.ts";
import type { LogErrorFn, LogFn } from "../../log.ts";
import { splitMarkdown } from "../split.ts";
import type { Adapter, Caps, ChannelAction, Inbound, Keyboard, Lang, SentHandle } from "../types.ts";
import { ToolCallRejected } from "../types.ts";
import { TelegramApi, type TelegramCallbackQuery, TelegramError, type TelegramMessage } from "./api.ts";
import { toMarkdownV2 } from "./mdv2.ts";
import { keyboardToMarkup, RICH_LIMIT, toRich } from "./rich.ts";
import { stripMdv2 } from "./strip.ts";

/** Source budget shared by Markdown sends and single-message previews. */
const SOURCE_CHARS = 3500;
/** Beyond this many chunks the reply is sent as one document instead. */
const MAX_CHUNKS = 8;
/** Telegram's hard limit for one message. */
const MESSAGE_LIMIT = 4096;
const PHOTO_EXTENSIONS: Record<string, true> = {
	".png": true,
	".jpg": true,
	".jpeg": true,
	".webp": true,
	".gif": true,
};
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

function formatSize(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface TelegramAdapterOptions {
	settingsManager: SettingsManager;
	log: LogFn;
	logError: LogErrorFn;
	/** The command list shown by Telegram's `/` menu; registered once at startup. */
	commands?: ReadonlyArray<{ command: string; description: string }>;
	/** Called after each processed update, so the offset survives a restart. */
	onOffset?(offset: number): void;
	offset?: number;
}

const PARSE_ERROR = /can't parse entities|can't find end|unsupported start tag|(entit.*parse|parse.*entit)/i;
const NOT_EDITABLE = /message to edit not found|message can(?:not|'t) be edited|message_id_invalid/i;
const TOO_LONG = /(?:message|text) is too long|(?:message|text)_too_long/i;

function isParseError(error: unknown): boolean {
	return error instanceof TelegramError && error.code === 400 && PARSE_ERROR.test(error.description);
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	let end = limit - 1; // Reserve one code unit for the ellipsis.
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${text.slice(0, end)}…`;
}

/** Telegram counts the visible UTF-16 text, not tags or entity spellings. */
function toolFields(name: string, details: string): { name: string; details: string } {
	const body = truncate(details || "…", 1500);
	return { name: truncate(name, MESSAGE_LIMIT - "🔧 \n".length - body.length), details: body };
}

/** The Bot API adapter: long-polling updates, MarkdownV2 replies, photo and document uploads. */
class TelegramAdapter implements Adapter {
	readonly name = "telegram" as const;
	readonly caps: Caps = { edit: true, stream: true, rich: true, maxChars: MESSAGE_LIMIT };

	private readonly options: TelegramAdapterOptions;
	private readonly api: TelegramApi;
	private readonly lang: Lang;
	private offset: number;
	private running = false;
	private controller: AbortController | undefined;
	private onAction: ((action: ChannelAction) => void) | undefined;

	constructor(options: TelegramAdapterOptions, api: TelegramApi, lang: Lang) {
		this.options = options;
		this.api = api;
		this.lang = lang;
		this.offset = options.offset ?? 0;
	}

	async start(onInbound: (message: Inbound) => void, onAction?: (action: ChannelAction) => void): Promise<void> {
		this.running = true;
		this.controller = new AbortController();
		this.onAction = onAction;
		await this.registerCommands();
		void this.loop(onInbound);
	}

	/** Publish the command menu; a failure only costs the menu, not the channel. */
	private async registerCommands(): Promise<void> {
		const commands = this.options.commands;
		if (!commands || commands.length === 0) return;
		try {
			await this.api.call("setMyCommands", { commands });
		} catch (error) {
			this.options.logError("telegram: could not register the command menu", error);
		}
	}

	async stop(): Promise<void> {
		this.running = false;
		this.controller?.abort();
	}

	private async loop(onInbound: (message: Inbound) => void): Promise<void> {
		while (this.running) {
			try {
				const updates = await this.api.getUpdates(this.offset);
				for (const update of updates) {
					await this.handleUpdate(update, onInbound);
					this.offset = update.update_id + 1;
					this.options.onOffset?.(this.offset);
				}
			} catch (error) {
				if (!this.running) return;
				this.options.logError("telegram getUpdates failed; retrying in 2s", error);
				await new Promise((resolve) => setTimeout(resolve, 2_000));
			}
		}
	}

	private async handleUpdate(
		update: { message?: TelegramMessage; callback_query?: TelegramCallbackQuery },
		onInbound: (message: Inbound) => void,
	): Promise<void> {
		const query = update.callback_query;
		if (query) {
			await this.handleCallback(query);
			return;
		}
		const message = update.message;
		if (!message || message.chat.type !== "private" || !message.from) return;
		const text = message.text ?? message.caption ?? "";
		const chatId = String(message.chat.id);
		const attachments: Inbound["attachments"] = [];

		const photo = message.photo?.[message.photo.length - 1];
		if (photo) {
			const image = await this.fetchAttachment(chatId, photo.file_id, photo.file_size, "image/jpeg", "photo.jpg");
			if (image) attachments.push(image);
		}
		const document = message.document;
		if (document) {
			const file = await this.fetchAttachment(
				chatId,
				document.file_id,
				document.file_size,
				document.mime_type ?? "application/octet-stream",
				document.file_name ?? "document",
			);
			if (file) attachments.push(file);
		}
		for (const audio of [message.voice, message.audio]) {
			if (!audio) continue;
			const isVoice = audio === message.voice;
			const file = await this.fetchAttachment(
				chatId,
				audio.file_id,
				audio.file_size,
				audio.mime_type ?? "application/octet-stream",
				isVoice ? "voice.ogg" : ((audio as { file_name?: string }).file_name ?? "audio"),
			);
			if (file) attachments.push(file);
		}

		onInbound({
			channel: "telegram",
			chatId,
			userId: String(message.from.id),
			messageId: String(message.message_id),
			text,
			attachments,
			languageCode: message.from.language_code,
		});
	}

	private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
		// Acknowledge first: the client spins until this call lands, and the routing below may take
		// longer than the callback's own timeout.
		await this.answerAction(query.id);
		const message = query.message;
		if (!message || !query.data) return;
		this.onAction?.({
			channel: "telegram",
			chatId: String(message.chat.id),
			userId: String(query.from.id),
			messageId: String(message.message_id),
			data: query.data,
		});
	}

	private async fetchAttachment(
		chatId: string,
		fileId: string,
		size: number | undefined,
		mimeType: string,
		fileName: string,
	): Promise<Inbound["attachments"][number] | undefined> {
		if (size !== undefined && size > MAX_DOWNLOAD_BYTES) {
			await this.sendMarkdown(chatId, t(this.lang, "file.tooLarge", { name: fileName, size: formatSize(size) }));
			return undefined;
		}
		try {
			const file = await this.api.getFile(fileId);
			if (!file.file_path) return undefined;
			const data = await this.api.download(file.file_path);
			return {
				kind: mimeType.startsWith("image/") ? "image" : "file",
				mimeType,
				fileName,
				data,
			};
		} catch (error) {
			this.options.logError(`could not download ${fileName}`, error);
			return undefined;
		}
	}

	async sendMarkdown(chatId: string, markdown: string, replyTo?: string): Promise<SentHandle[]> {
		const { chunks, asDocument } = splitMarkdown(markdown, { maxChars: SOURCE_CHARS, maxChunks: MAX_CHUNKS });
		if (asDocument) {
			const caption = markdown.replace(/\s+/g, " ").slice(0, 200);
			const form = new FormData();
			form.set("chat_id", chatId);
			form.set("caption", caption);
			form.set(
				"document",
				new Blob([new Uint8Array(Buffer.from(markdown, "utf-8"))], { type: "text/markdown" }),
				"reply.md",
			);
			const sent = await this.api.sendDocument({}, form);
			return [{ id: String(sent.message_id) }];
		}

		const handles: SentHandle[] = [];
		for (const [index, chunk] of chunks.entries()) {
			const sent = await this.sendChunk(chatId, chunk, index === 0 ? replyTo : undefined);
			handles.push({ id: String(sent.message_id) });
		}
		return handles;
	}

	private async deliverToolCall<T>(
		name: string,
		details: string,
		post: (text: Record<string, string>) => Promise<T>,
	): Promise<T> {
		const fields = toolFields(name, details);
		const html = `🔧 <b>${escapeHtml(fields.name)}</b>\n<blockquote expandable>${escapeHtml(fields.details)}</blockquote>`;
		try {
			return await this.withRetry(() => post({ text: html, parse_mode: "HTML" }));
		} catch (error) {
			if (!isParseError(error)) throw error;
		}
		return this.withRetry(() => post({ text: `🔧 ${fields.name}\n${fields.details}` }));
	}

	async sendToolCall(chatId: string, name: string, details: string, replyTo?: string): Promise<SentHandle> {
		try {
			const sent = await this.deliverToolCall(name, details, (text) =>
				this.api.sendMessage({
					chat_id: chatId,
					...text,
					...(replyTo
						? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } }
						: {}),
				}),
			);
			return { id: String(sent.message_id) };
		} catch (error) {
			if (error instanceof TelegramError && [400, 401, 403, 404].includes(error.code)) {
				throw new ToolCallRejected(error.description, { cause: error });
			}
			throw error;
		}
	}

	async editToolCall(chatId: string, handle: SentHandle, name: string, details: string): Promise<boolean> {
		try {
			await this.deliverToolCall(name, details, (text) =>
				this.api.call("editMessageText", {
					chat_id: chatId,
					message_id: Number(handle.id),
					...text,
				}),
			);
			return true;
		} catch (error) {
			if (error instanceof TelegramError && error.code === 400) {
				if (/message is not modified/i.test(error.description)) return true;
				if (NOT_EDITABLE.test(error.description)) return false;
			}
			throw error;
		}
	}

	/**
	 * Send one message as rich Markdown, so lists, tables and `<details>` render as Telegram's own
	 * constructs. Falls back to MarkdownV2, then to stripped text, when Telegram rejects the payload.
	 */
	async sendRich(chatId: string, markdown: string, replyTo?: string, keyboard?: Keyboard): Promise<SentHandle> {
		if (keyboard !== undefined) {
			const sent = await this.withRetry(() =>
				this.api.sendMessage({
					chat_id: chatId,
					text: markdown,
					reply_markup: keyboardToMarkup(keyboard) ?? { inline_keyboard: [] },
					...(replyTo
						? { reply_parameters: { message_id: Number(replyTo), allow_sending_without_reply: true } }
						: {}),
				}),
			);
			return { id: String(sent.message_id) };
		}
		const body: Record<string, unknown> = { chat_id: chatId, rich_message: { markdown: toRich(markdown) } };
		if (replyTo) body.reply_parameters = { message_id: Number(replyTo) };
		try {
			const sent = await this.withRetry(() => this.api.call<TelegramMessage>("sendRichMessage", body));
			return { id: String(sent.message_id) };
		} catch (error) {
			if (!(error instanceof TelegramError) || error.code !== 400) throw error;
			this.options.logError("telegram: rich send rejected, falling back", error);
		}
		const [handle] = await this.sendMarkdown(chatId, markdown, replyTo);
		return handle ?? { id: "" };
	}

	/** Replace a message with rich Markdown. False when it does not fit one message. */
	async editRich(chatId: string, handle: SentHandle, markdown: string, keyboard?: Keyboard): Promise<boolean> {
		if (keyboard !== undefined) {
			try {
				await this.withRetry(() =>
					this.api.call("editMessageText", {
						chat_id: chatId,
						message_id: Number(handle.id),
						text: markdown,
						reply_markup: keyboardToMarkup(keyboard) ?? { inline_keyboard: [] },
					}),
				);
				return true;
			} catch (error) {
				if (error instanceof TelegramError) {
					if (/message is not modified/i.test(error.description)) return true;
					if (error.code === 400 && NOT_EDITABLE.test(error.description)) return false;
				}
				throw error;
			}
		}
		const source = toRich(markdown);
		if (source.length > RICH_LIMIT) return false;
		const body: Record<string, unknown> = {
			chat_id: chatId,
			message_id: Number(handle.id),
			rich_message: { markdown: source },
		};
		try {
			await this.withRetry(() => this.api.call("editMessageText", body));
			return true;
		} catch (error) {
			if (!(error instanceof TelegramError) || error.code !== 400) throw error;
			if (/message is not modified/i.test(error.description)) return true;
			if (NOT_EDITABLE.test(error.description) || TOO_LONG.test(error.description)) return false;
			// Retry unsupported constructs through the standard Markdown path.
			this.options.logError("telegram: rich edit rejected, falling back", error);
		}
		return this.editMarkdown(chatId, handle, markdown);
	}

	/** Swap only the buttons under a message, leaving its text alone. */
	async editMarkup(chatId: string, handle: SentHandle, keyboard: Keyboard): Promise<void> {
		const markup = keyboardToMarkup(keyboard) ?? { inline_keyboard: [] };
		try {
			await this.api.call("editMessageReplyMarkup", {
				chat_id: chatId,
				message_id: Number(handle.id),
				reply_markup: markup,
			});
		} catch (error) {
			if (error instanceof TelegramError && /message is not modified/i.test(error.description)) return;
			throw error;
		}
	}

	/** Acknowledge a button press, so the client stops its spinner. */
	async answerAction(actionId: string, text?: string): Promise<void> {
		try {
			await this.api.call("answerCallbackQuery", { callback_query_id: actionId, ...(text ? { text } : {}) });
		} catch (error) {
			this.options.logError("telegram: could not answer the callback query", error);
		}
	}

	private async sendChunk(chatId: string, chunk: string, replyTo: string | undefined): Promise<TelegramMessage> {
		const rendered = toMarkdownV2(chunk);
		const body: Record<string, unknown> = { chat_id: chatId, parse_mode: "MarkdownV2", text: rendered };
		if (replyTo) body.reply_parameters = { message_id: Number(replyTo) };
		try {
			return await this.withRetry(() => this.api.sendMessage(body));
		} catch (error) {
			// Rendering (e.g. a table as bullets) can expand even a single source chunk.
			if (
				!isParseError(error) &&
				!(error instanceof TelegramError && error.code === 400 && TOO_LONG.test(error.description))
			) {
				throw error;
			}
		}

		// The renderer produced something Telegram rejects: send the stripped text without a parse mode.
		const plain = stripMdv2(rendered);
		const fallback = plain.length > MESSAGE_LIMIT ? chunk : plain;
		const body2: Record<string, unknown> = { chat_id: chatId, text: fallback };
		if (replyTo) body2.reply_parameters = { message_id: Number(replyTo) };
		return this.withRetry(() => this.api.sendMessage(body2));
	}

	/** One retry after a 429, waiting no longer than 30s. */
	private async withRetry<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (!(error instanceof TelegramError) || error.code !== 429) throw error;
			await new Promise((resolve) => setTimeout(resolve, Math.min((error.retryAfter ?? 1) * 1000, 30_000)));
			return run();
		}
	}

	async editText(chatId: string, handle: SentHandle, plain: string): Promise<void> {
		try {
			await this.api.call("editMessageText", {
				chat_id: chatId,
				message_id: Number(handle.id),
				text: plain.length > MESSAGE_LIMIT ? plain.slice(-MESSAGE_LIMIT) : plain,
			});
		} catch (error) {
			if (error instanceof TelegramError && /message is not modified/i.test(error.description)) return;
			throw error;
		}
	}

	/** Edit one message from original Markdown. Only a definite refusal permits a replacement send. */
	async editMarkdown(chatId: string, handle: SentHandle, markdown: string): Promise<boolean> {
		const rendered = toMarkdownV2(markdown);
		// Telegram applies the limit after parsing entities, not to the backslash-escaped payload.
		try {
			await this.withRetry(() =>
				this.api.call("editMessageText", {
					chat_id: chatId,
					message_id: Number(handle.id),
					parse_mode: "MarkdownV2",
					text: rendered,
				}),
			);
			return true;
		} catch (error) {
			if (!(error instanceof TelegramError) || error.code !== 400) throw error;
			if (/message is not modified/i.test(error.description)) return true;
			if (NOT_EDITABLE.test(error.description) || TOO_LONG.test(error.description)) return false;
			if (!isParseError(error)) throw error;
		}
		// The renderer produced something Telegram rejects: edit in the stripped text without a parse mode.
		try {
			await this.withRetry(() =>
				this.api.call("editMessageText", {
					chat_id: chatId,
					message_id: Number(handle.id),
					text: stripMdv2(rendered),
				}),
			);
		} catch (error) {
			if (!(error instanceof TelegramError) || error.code !== 400) throw error;
			if (/message is not modified/i.test(error.description)) return true;
			if (NOT_EDITABLE.test(error.description) || TOO_LONG.test(error.description)) return false;
			throw error;
		}
		return true;
	}

	async deleteMessage(chatId: string, handle: SentHandle): Promise<void> {
		try {
			await this.api.call("deleteMessage", { chat_id: chatId, message_id: Number(handle.id) });
		} catch (error) {
			// A message already gone is the state we wanted.
			if (error instanceof TelegramError && /message to delete not found/i.test(error.description)) return;
			throw error;
		}
	}

	/** Telegram's typing indicator, refreshed by the caller's progress timer. */
	async notifyWorking(chatId: string): Promise<void> {
		try {
			await this.api.call("sendChatAction", { chat_id: chatId, action: "typing" });
		} catch (error) {
			this.options.logError("telegram: could not send the typing action", error);
		}
	}

	/**
	 * Telegram has no platform-rendered stream: the reply layer edits a placeholder instead, so this
	 * returns undefined and the placeholder path runs.
	 */
	openStream(): undefined {
		return undefined;
	}

	async sendFiles(chatId: string, paths: string[], replyTo?: string): Promise<void> {
		for (const path of paths) {
			if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`No such file: ${path}`);
			const size = statSync(path).size;
			const name = basename(path);
			if (size > MAX_UPLOAD_BYTES) {
				await this.sendMarkdown(chatId, t(this.lang, "file.tooLarge", { name, size: formatSize(size) }));
				continue;
			}
			const form = new FormData();
			form.set("chat_id", chatId);
			if (replyTo) form.set("reply_parameters", JSON.stringify({ message_id: Number(replyTo) }));
			const data = new Blob([new Uint8Array(readFileSync(path))]);
			const isPhoto = PHOTO_EXTENSIONS[extname(path).toLowerCase()] === true;
			form.set(isPhoto ? "photo" : "document", data, name);
			if (isPhoto) await this.api.sendPhoto({}, form);
			else await this.api.sendDocument({}, form);
		}
	}
}

/** Build the Telegram adapter from `[nekopal.channels.telegram]`. */
export function createTelegramAdapter(options: TelegramAdapterOptions): Adapter {
	const settings = options.settingsManager.getNekoPal().channels?.telegram;
	const raw = settings?.botToken ?? "$TELEGRAM_BOT_TOKEN";
	let token: string;
	try {
		token = resolveConfigValueOrThrow(raw, "telegram botToken");
	} catch (error) {
		options.logError("telegram botToken resolved to empty (check TELEGRAM_BOT_TOKEN)", error);
		throw error;
	}
	return new TelegramAdapter(
		options,
		new TelegramApi(token),
		options.settingsManager.getNekoPal().defaultLang ?? "en",
	);
}
