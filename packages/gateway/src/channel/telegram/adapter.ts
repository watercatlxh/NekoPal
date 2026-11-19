import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveConfigValueOrThrow } from "@earendil-works/pi-coding-agent";
import type { Adapter, Caps, Inbound, SentHandle } from "../types.ts";
import type { Lang } from "../types.ts";
import { splitMarkdown } from "../split.ts";
import { t } from "../../i18n/index.ts";
import type { LogFn, LogErrorFn } from "../../log.ts";
import { TelegramApi, TelegramError, type TelegramMessage } from "./api.ts";
import { toMarkdownV2 } from "./mdv2.ts";
import { stripMdv2 } from "./strip.ts";

/** Source characters per message, leaving room for the escapes MarkdownV2 adds. */
const SOURCE_CHARS = 3500;
/** Beyond this many chunks the reply is sent as one document instead. */
const MAX_CHUNKS = 8;
/** Telegram's hard limit for one message. */
const MESSAGE_LIMIT = 4096;
const PHOTO_EXTENSIONS: Record<string, true> = { ".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true };
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export interface TelegramAdapterOptions {
	settingsManager: SettingsManager;
	log: LogFn;
	logError: LogErrorFn;
	/** Called after each processed update, so the offset survives a restart. */
	onOffset?(offset: number): void;
	offset?: number;
}

const PARSE_ERROR = /can't parse entities|can't find end|unsupported start tag|(entit.*parse|parse.*entit)/i;

function isParseError(error: unknown): boolean {
	return error instanceof TelegramError && PARSE_ERROR.test(error.description);
}

/** The Bot API adapter: long-polling updates, MarkdownV2 replies, photo and document uploads. */
class TelegramAdapter implements Adapter {
	readonly name = "telegram" as const;
	readonly caps: Caps = { edit: true, stream: true, maxChars: MESSAGE_LIMIT };

	private readonly options: TelegramAdapterOptions;
	private readonly api: TelegramApi;
	private readonly lang: Lang;
	private offset: number;
	private running = false;
	private controller: AbortController | undefined;

	constructor(options: TelegramAdapterOptions, api: TelegramApi, lang: Lang) {
		this.options = options;
		this.api = api;
		this.lang = lang;
		this.offset = options.offset ?? 0;
	}

	async start(onInbound: (message: Inbound) => void): Promise<void> {
		this.running = true;
		this.controller = new AbortController();
		void this.loop(onInbound);
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

	private async handleUpdate(update: { message?: TelegramMessage }, onInbound: (message: Inbound) => void): Promise<void> {
		const message = update.message;
		if (!message || message.chat.type !== "private" || !message.from) return;
		const text = message.text ?? message.caption ?? "";
		const attachments: Inbound["attachments"] = [];

		const photo = message.photo?.[message.photo.length - 1];
		if (photo) {
			const image = await this.fetchAttachment(photo.file_id, photo.file_size, "image/jpeg", "photo.jpg");
			if (image) attachments.push(image);
		}
		const document = message.document;
		if (document) {
			const file = await this.fetchAttachment(
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
				audio.file_id,
				audio.file_size,
				audio.mime_type ?? "application/octet-stream",
				isVoice ? "voice.ogg" : ((audio as { file_name?: string }).file_name ?? "audio"),
			);
			if (file) attachments.push(file);
		}

		onInbound({
			channel: "telegram",
			chatId: String(message.chat.id),
			userId: String(message.from.id),
			messageId: String(message.message_id),
			text,
			attachments,
			languageCode: message.from.language_code,
		});
	}

	private async fetchAttachment(
		fileId: string,
		size: number | undefined,
		mimeType: string,
		fileName: string,
	): Promise<Inbound["attachments"][number] | undefined> {
		if (size !== undefined && size > MAX_DOWNLOAD_BYTES) {
			await this.sendMarkdown(String(fileId), t(this.lang, "file.tooLarge", { name: fileName, size: size }));
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

	private async sendChunk(chatId: string, chunk: string, replyTo: string | undefined): Promise<TelegramMessage> {
		const body: Record<string, unknown> = { chat_id: chatId, parse_mode: "MarkdownV2", text: toMarkdownV2(chunk) };
		if (replyTo) body.reply_parameters = { message_id: Number(replyTo) };
		try {
			return await this.withRetry(() => this.api.sendMessage(body));
		} catch (error) {
			if (!isParseError(error)) throw error;
		}

		// The renderer produced something Telegram rejects: send the stripped text without a parse mode.
		const plain = stripMdv2(toMarkdownV2(chunk));
		const fallback = plain.length > MESSAGE_LIMIT ? stripMdv2(chunk).slice(0, MESSAGE_LIMIT) : plain;
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

	async deleteMessage(chatId: string, handle: SentHandle): Promise<void> {
		try {
			await this.api.call("deleteMessage", { chat_id: chatId, message_id: Number(handle.id) });
		} catch (error) {
			// A message already gone is the state we wanted.
			if (error instanceof TelegramError && /message to delete not found/i.test(error.description)) return;
			throw error;
		}
	}

	async sendFiles(chatId: string, paths: string[], replyTo?: string): Promise<void> {
		for (const path of paths) {
			if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`No such file: ${path}`);
			const size = statSync(path).size;
			const name = basename(path);
			if (size > MAX_UPLOAD_BYTES) {
				await this.sendMarkdown(chatId, t(this.lang, "file.tooLarge", { name, size }));
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
	return new TelegramAdapter(options, new TelegramApi(token), options.settingsManager.getNekoPal().defaultLang ?? "en");
}
