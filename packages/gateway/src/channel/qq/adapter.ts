import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveConfigValue } from "@earendil-works/pi-coding-agent";
import { t } from "../../i18n/index.ts";
import { splitMarkdown } from "../split.ts";
import type { Adapter, Attachment, Caps, ChannelStream, Inbound, Lang, SentHandle } from "../types.ts";
import { QqApi, QqError } from "./api.ts";
import { PassiveBudget, ProactiveBudget, type ProactiveCounts, type ProactiveStorage } from "./budget.ts";
import { QqGateway, type QqLog, type QqLogError, type QqMessageEvent } from "./gateway.ts";
import { QqStream, type StreamBudget } from "./stream.ts";
import { stripMarkdown } from "./strip.ts";
import { TokenProvider } from "./token.ts";

/** Longest text QQ accepts in one message. */
const MAX_CHARS = 3_000;
/**
 * Chunk cap for one reply. QQ has no document message, so a long reply cannot be handed over as a
 * file; the reply budget ends the send long before this cap is reached in practice.
 */
const MAX_CHUNKS = 1_000;
/** Direct upload limit of the file endpoint; larger files need the multipart flow, which we skip. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Inbound attachments above this are skipped rather than buffered. */
const MAX_INBOUND_BYTES = 20 * 1024 * 1024;
/** How long to wait before retrying a rate-limited or failed send. */
const RETRY_DELAY_MS = 2_000;

const IMAGE_EXTENSIONS: Record<string, true> = {
	".png": true,
	".jpg": true,
	".jpeg": true,
	".webp": true,
	".gif": true,
};

/** Daily proactive counters the adapter persists; `StateStore` satisfies this shape. */
export interface QqQuotaStore {
	readonly qq: ProactiveCounts;
	mutate(change: (state: { qq: ProactiveCounts }) => void): void;
}

export interface QqAdapterOptions {
	settingsManager: SettingsManager;
	log: QqLog;
	logError: QqLogError;
	/** Persists the daily proactive counters; without it they live for the process lifetime. */
	state?: QqQuotaStore;
	/** Language of the adapter's own notices; defaults to `nekopal.defaultLang`. */
	langFor?: (chatId: string) => Lang;
	/** Replaced in tests. */
	fetchImpl?: typeof fetch;
	socketFactory?: (url: string) => WebSocket;
}

/** The QQ C2C channel: one WebSocket receive loop plus the markdown send pipeline. */
export function createQqAdapter(options: QqAdapterOptions): Adapter {
	return new QqAdapter(options);
}

/** Exported so the daemon can read the proactive quota for `/settings`. */
export class QqAdapter implements Adapter {
	readonly name = "qq" as const;
	readonly caps: Caps;

	private readonly options: QqAdapterOptions;
	private readonly passive = new PassiveBudget();
	private readonly proactive: ProactiveBudget;
	private readonly langFor: (chatId: string) => Lang;
	private readonly streaming: boolean;
	private gateway: QqGateway | undefined;
	private api: QqApi | undefined;
	private inboundTail: Promise<void> = Promise.resolve();

	constructor(options: QqAdapterOptions) {
		this.options = options;
		const qq = options.settingsManager.getNekoPal().channels?.qq;
		// No in-place edits: QQ renders a reply either as a stream or as one final message.
		this.streaming = qq?.stream ?? true;
		this.caps = { edit: false, stream: this.streaming, maxChars: MAX_CHARS };
		const defaultLang = options.settingsManager.getNekoPal().defaultLang ?? "en";
		this.langFor = options.langFor ?? (() => defaultLang);
		this.proactive = new ProactiveBudget({
			perMinute: qq?.proactivePerMinute ?? 18,
			perDay: qq?.proactivePerDay ?? 1000,
			storage: options.state ? storeAdapter(options.state) : undefined,
		});
	}

	async start(onInbound: (message: Inbound) => void): Promise<void> {
		const qq = this.options.settingsManager.getNekoPal().channels?.qq;
		const appId = qq?.appId ?? "";
		const appSecret = resolveConfigValue(qq?.appSecret ?? "") ?? "";
		if (appId === "" || appSecret === "") {
			this.options.log(
				"error",
				"nekopal: qq appId/appSecret resolved to empty (check appId and QQ_BOT_SECRET); the qq channel will not start",
			);
			return;
		}
		if ((qq?.allowedOpenIds ?? []).length === 0) {
			this.options.log("warn", "qq allowlist is empty; every message will be ignored");
		}

		const token = new TokenProvider({ appId, appSecret, fetchImpl: this.options.fetchImpl });
		const api = new QqApi({ token, fetchImpl: this.options.fetchImpl });
		this.api = api;

		const gateway = new QqGateway({
			api,
			log: this.options.log,
			logError: this.options.logError,
			socketFactory: this.options.socketFactory,
		});
		this.gateway = gateway;
		gateway.start((message) => this.enqueueInbound(message, onInbound));
	}

	async sendMarkdown(chatId: string, markdown: string, replyTo?: string): Promise<SentHandle[]> {
		if (markdown.trim() === "") return [];
		const sourceId = replyTo === "" ? undefined : replyTo;
		const { chunks, asDocument } = splitMarkdown(markdown, { maxChars: MAX_CHARS, maxChunks: MAX_CHUNKS });
		if (asDocument) {
			// Only a multi-megabyte reply gets here, and QQ has no document message to fall back on.
			this.options.log("warn", `qq: reply to ${chatId} is too long to send (${markdown.length} chars)`);
			await this.sendNotice(chatId, t(this.langFor(chatId), "qq.limit"));
			return [];
		}

		const handles: SentHandle[] = [];
		for (const chunk of chunks) {
			const sent = await this.sendChunk(chatId, chunk, sourceId);
			if (sent === undefined) break;
			handles.push(sent);
		}
		return handles;
	}

	/** A `stream_messages` reply, when `nekopal.channels.qq.stream` is on and a reply slot is free. */
	openStream(chatId: string, replyTo?: string): ChannelStream | undefined {
		const api = this.api;
		if (api === undefined || !this.streaming) return undefined;
		const sourceId = replyTo === "" ? undefined : replyTo;
		const budget: StreamBudget = {
			take: () => {
				const targeting = this.takeSlot(chatId, sourceId);
				if (targeting === undefined) return undefined;
				const { msg_id, msg_seq } = targeting as { msg_id?: string; msg_seq?: number };
				return { msgId: msg_id, msgSeq: msg_seq };
			},
		};
		return QqStream.open({
			api,
			chatId,
			budget,
			sendRest: (markdown) => this.sendMarkdown(chatId, markdown, sourceId).then(() => undefined),
			logError: (message, error) => this.options.logError(message, error),
		});
	}

	async editText(_chatId: string, _handle: SentHandle, _plain: string): Promise<void> {
		throw new Error("qq: edit unsupported");
	}

	async deleteMessage(_chatId: string, _handle: SentHandle): Promise<void> {
		// The QQ bot API has no delete endpoint; a sent message stays in the chat.
	}

	async sendFiles(chatId: string, paths: string[], replyTo?: string): Promise<void> {
		const sourceId = replyTo === "" ? undefined : replyTo;
		for (const path of paths) {
			await this.sendFile(chatId, path, sourceId);
		}
	}

	async stop(): Promise<void> {
		await this.gateway?.stop();
		this.gateway = undefined;
	}

	/** The `/settings` line for this user's proactive quota. */
	quotaLine(openid: string, lang: Lang): string {
		const counts = this.proactive.snapshot(openid, Date.now());
		return t(lang, "settings.qqQuota", {
			minute: counts.minute,
			minuteLimit: counts.minuteLimit,
			day: counts.day,
			dayLimit: counts.dayLimit,
		});
	}

	/** Serialize inbound handling so downloads cannot reorder the messages they belong to. */
	private enqueueInbound(message: QqMessageEvent, onInbound: (message: Inbound) => void): void {
		// Open the passive reply window on arrival, not after the attachments finish downloading.
		this.passive.register(message.id, Date.now());
		this.inboundTail = this.inboundTail
			.then(() => this.handleInbound(message, onInbound))
			.catch((error: unknown) => this.options.logError("qq: could not handle an inbound message", error));
	}

	private async handleInbound(message: QqMessageEvent, onInbound: (message: Inbound) => void): Promise<void> {
		const attachments = await this.downloadAttachments(message);
		let text = message.content;
		if (message.transcript !== undefined && message.transcript !== "") {
			// Voice messages carry their speech-to-text beside the audio; keep it even when the audio
			// itself failed to download.
			const voice = attachments.find((attachment) => attachment.mimeType.startsWith("audio/")) ?? attachments[0];
			if (voice) voice.transcript = message.transcript;
			else text = `${text}\n[voice transcript: ${message.transcript}]`.trim();
		}

		onInbound({
			channel: "qq",
			chatId: message.openid,
			userId: message.openid,
			messageId: message.id,
			text,
			attachments,
		});
	}

	private async downloadAttachments(message: QqMessageEvent): Promise<Attachment[]> {
		const api = this.api;
		if (!api) return [];
		const attachments: Attachment[] = [];
		for (const ref of message.attachments) {
			if (ref.size !== undefined && ref.size > MAX_INBOUND_BYTES) {
				this.options.log("warn", `qq: skipping an attachment larger than 20MB (${ref.size} bytes)`);
				continue;
			}
			try {
				const { data, contentType } = await api.download(ref.url);
				if (data.byteLength > MAX_INBOUND_BYTES) {
					this.options.log("warn", `qq: skipping an attachment larger than 20MB (${data.byteLength} bytes)`);
					continue;
				}
				const mimeType = (ref.contentType ?? contentType ?? "application/octet-stream").trim();
				attachments.push({
					kind: mimeType.startsWith("image/") ? "image" : "file",
					mimeType,
					fileName: ref.filename ?? "attachment",
					data,
				});
			} catch (error) {
				this.options.logError(`qq: could not download ${ref.url}`, error);
			}
		}
		return attachments;
	}

	/**
	 * Send one chunk, taking a passive slot when the source message still has one and a proactive
	 * slot otherwise. Returns undefined when the reply budget is spent and the caller should stop.
	 */
	private async sendChunk(chatId: string, content: string, replyTo?: string): Promise<SentHandle | undefined> {
		const api = this.api;
		if (!api) throw new Error("qq: adapter is not started");

		const targeting = this.takeSlot(chatId, replyTo);
		if (targeting === undefined) {
			await this.sendNotice(chatId, t(this.langFor(chatId), "qq.limit"));
			return undefined;
		}

		const payload: Record<string, unknown> = { msg_type: 2, markdown: { content }, ...targeting };
		try {
			const response = await this.post(api, chatId, payload);
			return { id: response.id ?? replyTo ?? "" };
		} catch (error) {
			if (isRetryable(error)) {
				await sleep(RETRY_DELAY_MS);
				try {
					const response = await this.post(api, chatId, payload);
					return { id: response.id ?? replyTo ?? "" };
				} catch (retryError) {
					this.options.logError("qq send failed after a retry", retryError);
					return undefined;
				}
			}
			if (!(error instanceof QqError)) {
				this.options.logError("qq send failed", error);
				return undefined;
			}

			// A rejected markdown payload (a URL in plain text, a user who refuses proactive
			// messages) is often accepted as plain text, so try that once before giving up. The
			// rejected attempt did not reach the chat, so it keeps the same reply slot.
			try {
				const response = await this.post(api, chatId, {
					msg_type: 0,
					content: stripMarkdown(content),
					...targeting,
				});
				return { id: response.id ?? replyTo ?? "" };
			} catch (plainError) {
				this.options.logError(`qq send failed: ${error.status} ${error.message}`, plainError);
				return undefined;
			}
		}
	}

	/**
	 * Claim the fields that address one message: `msg_id`/`msg_seq` from the source message's
	 * passive window, else a proactive send. Undefined when both budgets are spent.
	 */
	private takeSlot(chatId: string, replyTo?: string): Record<string, unknown> | undefined {
		const now = Date.now();
		// Only a message this adapter received has a passive window; an unknown id would be a
		// `msg_id` QQ rejects.
		if (replyTo !== undefined && this.passive.remaining(replyTo, now) > 0) {
			const msgSeq = this.passive.takePassive(replyTo, now);
			if (msgSeq !== undefined) return { msg_id: replyTo, msg_seq: msgSeq };
		}
		return this.proactive.takeProactive(chatId, now) ? {} : undefined;
	}

	/** A plain notice such as the reply-limit warning; it bypasses the budget so it always lands. */
	private async sendNotice(chatId: string, text: string): Promise<void> {
		const api = this.api;
		if (!api) return;
		try {
			await this.post(api, chatId, { msg_type: 0, content: stripMarkdown(text) });
		} catch (error) {
			this.options.logError("qq: could not send a notice", error);
		}
	}

	private async sendFile(chatId: string, path: string, replyTo?: string): Promise<void> {
		const api = this.api;
		if (!api) throw new Error("qq: adapter is not started");

		const size = statSync(path).size;
		const name = basename(path);
		if (size > MAX_UPLOAD_BYTES) {
			await this.sendNotice(chatId, t(this.langFor(chatId), "file.tooLarge", { name, size: formatSize(size) }));
			return;
		}

		const fileType = IMAGE_EXTENSIONS[extname(path).toLowerCase()] === true ? 1 : 4;
		const upload: Record<string, unknown> = {
			file_type: fileType,
			file_data: readFileSync(path).toString("base64"),
			srv_send_msg: false,
		};
		if (fileType === 4) upload.file_name = name;

		const uploaded = await api.call<{ file_info?: string }>("POST", `/v2/users/${chatId}/files`, upload);
		if (typeof uploaded.file_info !== "string" || uploaded.file_info === "") {
			throw new Error(`qq: upload of ${name} returned no file_info`);
		}

		const targeting = this.takeSlot(chatId, replyTo);
		if (targeting === undefined) {
			await this.sendNotice(chatId, t(this.langFor(chatId), "qq.limit"));
			return;
		}

		await api.call("POST", `/v2/users/${chatId}/messages`, {
			msg_type: 7,
			media: { file_info: uploaded.file_info },
			...targeting,
		});
	}

	private post(api: QqApi, chatId: string, payload: Record<string, unknown>): Promise<{ id?: string }> {
		return api.call<{ id?: string }>("POST", `/v2/users/${chatId}/messages`, payload);
	}
}

/** Bridge `StateStore` to the budget's storage contract. */
function storeAdapter(state: QqQuotaStore): ProactiveStorage {
	return {
		load: () => state.qq,
		save: (counts) =>
			state.mutate((target) => {
				target.qq = counts;
			}),
	};
}

/** 429 and 5xx are transient; other statuses mean the payload itself was rejected. */
function isRetryable(error: unknown): boolean {
	return error instanceof QqError && (error.status === 429 || error.status >= 500);
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function formatSize(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
