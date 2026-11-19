/** QQ token endpoint. */
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

/** Lifetime the endpoint uses when it omits `expires_in`. */
const DEFAULT_TTL_SECONDS = 7200;

/** Refresh this early in the token's lifetime, so a request never races its expiry. */
const REFRESH_RATIO = 0.8;

const REQUEST_TIMEOUT_MS = 15_000;

export interface TokenProviderOptions {
	appId: string;
	appSecret: string;
	/** Replaced in tests. */
	fetchImpl?: typeof fetch;
	/** Clock, in milliseconds. */
	now?: () => number;
}

interface TokenResponse {
	access_token?: string;
	expires_in?: number | string;
}

/**
 * Caches the QQ app access token.
 *
 * The token is fetched once and refreshed at 80% of its lifetime; concurrent callers share a
 * single in-flight refresh instead of each hitting the endpoint.
 */
export class TokenProvider {
	private readonly appId: string;
	private readonly appSecret: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private token: string | undefined;
	private expiresAt = 0;
	private pending: Promise<string> | undefined;

	constructor(options: TokenProviderOptions) {
		this.appId = options.appId;
		this.appSecret = options.appSecret;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? Date.now;
	}

	/** A valid token, fetching or refreshing it when needed. */
	async get(): Promise<string> {
		if (this.token !== undefined && this.now() < this.expiresAt) return this.token;
		if (this.pending) return this.pending;
		const refresh = this.refresh();
		this.pending = refresh;
		try {
			return await refresh;
		} finally {
			if (this.pending === refresh) this.pending = undefined;
		}
	}

	private async refresh(): Promise<string> {
		const response = await this.fetchImpl(TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`qq token: ${response.status} ${text.slice(0, 200)}`);
		}

		let parsed: TokenResponse;
		try {
			parsed = JSON.parse(text) as TokenResponse;
		} catch {
			throw new Error(`qq token: response is not JSON: ${text.slice(0, 200)}`);
		}
		const token = parsed.access_token;
		if (typeof token !== "string" || token === "") {
			throw new Error("qq token: response has no access_token");
		}

		const ttl = ttlSeconds(parsed.expires_in);
		this.token = token;
		this.expiresAt = this.now() + ttl * 1000 * REFRESH_RATIO;
		return token;
	}
}

/** `expires_in` arrives as a number or a numeric string; fall back to the documented lifetime. */
function ttlSeconds(value: number | string | undefined): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}
