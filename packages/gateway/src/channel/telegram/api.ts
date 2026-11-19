/** A failed Telegram Bot API call. */
export class TelegramError extends Error {
	readonly code: number;
	readonly description: string;
	readonly retryAfter: number | undefined;

	constructor(code: number, description: string, retryAfter?: number) {
		super(description);
		this.name = "TelegramError";
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
	}
}

interface ApiResponse<T> {
	ok: boolean;
	result?: T;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
}

export interface TelegramMessage {
	message_id: number;
	chat: { id: number; type: string };
	from?: { id: number; language_code?: string };
	date: number;
	text?: string;
	caption?: string;
	photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
	document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
	voice?: { file_id: string; mime_type?: string; file_size?: number };
	audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface TelegramFile {
	file_id: string;
	file_path?: string;
	file_size?: number;
}

/** The Bot API client: one JSON POST per call, errors as `TelegramError`. */
export class TelegramApi {
	private readonly token: string;
	private readonly base: string;

	constructor(token: string, base = "https://api.telegram.org") {
		this.token = token;
		this.base = base;
	}

	private url(method: string): string {
		return `${this.base}/bot${this.token}/${method}`;
	}

	async call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
		const response = await fetch(this.url(method), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const payload = (await response.json()) as ApiResponse<T>;
		if (!payload.ok) {
			throw new TelegramError(
				payload.error_code ?? response.status,
				payload.description ?? "unknown error",
				payload.parameters?.retry_after,
			);
		}
		return payload.result as T;
	}

	/** Long-poll `getUpdates`; the fetch outlives the server-side wait. */
	getUpdates(offset: number, timeoutSeconds = 50): Promise<TelegramUpdate[]> {
		return this.call<TelegramUpdate[]>(
			"getUpdates",
			{ offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
			(timeoutSeconds + 20) * 1000,
		);
	}

	getFile(fileId: string): Promise<TelegramFile> {
		return this.call<TelegramFile>("getFile", { file_id: fileId });
	}

	/** Download a file the Bot API reported, without the token in the error path. */
	async download(filePath: string): Promise<Buffer> {
		const response = await fetch(`${this.base}/file/bot${this.token}/${filePath}`, {
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) throw new TelegramError(response.status, `file download failed: ${response.statusText}`);
		return Buffer.from(await response.arrayBuffer());
	}

	async sendMessage(body: Record<string, unknown>): Promise<TelegramMessage> {
		return this.call<TelegramMessage>("sendMessage", body, 60_000);
	}

	async sendPhoto(_body: Record<string, unknown>, form: FormData): Promise<TelegramMessage> {
		return this.upload<TelegramMessage>("sendPhoto", form, 120_000);
	}

	async sendDocument(_body: Record<string, unknown>, form: FormData): Promise<TelegramMessage> {
		return this.upload<TelegramMessage>("sendDocument", form, 120_000);
	}

	private async upload<T>(method: string, form: FormData, timeoutMs: number): Promise<T> {
		const response = await fetch(this.url(method), {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(timeoutMs),
		});
		const payload = (await response.json()) as ApiResponse<T>;
		if (!payload.ok) {
			throw new TelegramError(
				payload.error_code ?? response.status,
				payload.description ?? "unknown error",
				payload.parameters?.retry_after,
			);
		}
		return payload.result as T;
	}
}
