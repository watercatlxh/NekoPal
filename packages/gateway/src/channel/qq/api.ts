import type { TokenProvider } from "./token.ts";

const DEFAULT_BASE_URL = "https://api.sgroup.qq.com";
const REQUEST_TIMEOUT_MS = 20_000;

/** A failed QQ API call, with the HTTP status and the platform error code. */
export class QqError extends Error {
	readonly status: number;
	readonly code: number | undefined;
	readonly retryAfter: number | undefined;

	constructor(status: number, message: string, code?: number, retryAfter?: number) {
		super(message);
		this.name = "QqError";
		this.status = status;
		this.code = code;
		this.retryAfter = retryAfter;
	}
}

export interface QqApiOptions {
	token: TokenProvider;
	baseUrl?: string;
	/** Replaced in tests. */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

interface ErrorBody {
	code?: number;
	message?: string;
}

/** JSON calls against the QQ bot API, authenticated with `Authorization: QQBot <token>`. */
export class QqApi {
	private readonly tokens: TokenProvider;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: QqApiOptions) {
		this.tokens = options.token;
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	}

	/** A valid access token, for the gateway's identify and resume frames. */
	token(): Promise<string> {
		return this.tokens.get();
	}

	/** Call `method path` and parse the JSON response; throws `QqError` on a non-2xx status. */
	async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
		const token = await this.tokens.get();
		const headers: Record<string, string> = { authorization: `QQBot ${token}` };
		if (body !== undefined) headers["content-type"] = "application/json";

		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		const text = await response.text();
		if (!response.ok) throw errorFrom(response, text);
		if (text.trim() === "") return {} as T;
		return JSON.parse(text) as T;
	}

	/** Download an attachment URL with the bot token. */
	async download(url: string): Promise<{ data: Buffer; contentType: string | undefined }> {
		const token = await this.tokens.get();
		const response = await this.fetchImpl(url, {
			headers: { authorization: `QQBot ${token}` },
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) throw new QqError(response.status, `download failed: ${response.statusText}`);
		return {
			data: Buffer.from(await response.arrayBuffer()),
			contentType: response.headers.get("content-type") ?? undefined,
		};
	}
}

function errorFrom(response: Response, text: string): QqError {
	let code: number | undefined;
	let message = text.slice(0, 200);
	try {
		const parsed = JSON.parse(text) as ErrorBody;
		if (typeof parsed.code === "number") code = parsed.code;
		if (typeof parsed.message === "string" && parsed.message !== "") message = parsed.message;
	} catch {
		// Not JSON: keep the raw body as the message.
	}
	return new QqError(response.status, message, code, retryAfterSeconds(response));
}

function retryAfterSeconds(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (header === null) return undefined;
	const parsed = Number.parseFloat(header);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
