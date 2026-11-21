/**
 * Google Antigravity OAuth flow (Gemini, Claude, GPT-OSS through Cloud Code Assist).
 *
 * Ported from omp's `google-antigravity`: the consumer client credentials Antigravity itself
 * ships, `daily-cloudcode-pa` for project discovery, and the `loadCodeAssist`/`onboardUser`
 * free-tier provisioning after the exchange. The project id is kept on the credential so
 * request building can pass it as the body's `project` field.
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);

// The public installed-application client Antigravity's own CLI uses (`agy`), not Gemini CLI's.
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
	"https://www.googleapis.com/auth/aicode",
].join(" ");
const EXPIRY_SKEW_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

const CLOUD_CODE_ASSIST_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
const ONBOARD_USER_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`;
const OPERATIONS_URL = `${CLOUD_CODE_ASSIST_ENDPOINT}/v1internal`;
const FREE_TIER_ID = "free-tier";
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1_000;

/** The Antigravity client identity the control plane expects on these calls. */
function antigravityHeaders(): Record<string, string> {
	const platform = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	return {
		"User-Agent": `antigravity/hub/2.26.0 (aidev_client; os_type=${platform}; arch=${arch}; cl=1005016104)`,
		"Accept-Encoding": "gzip",
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Never forward credential-bearing requests or include untrusted response text in errors. */
async function requestJson(
	label: string,
	url: string,
	init: RequestInit,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		...init,
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	}).catch(() => {
		throw new Error(signal.aborted ? "Login cancelled" : `${label} request failed`);
	});
	if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status})`);
	const data: unknown = await response.json().catch(() => undefined);
	if (!isObject(data)) throw new Error(`${label} returned invalid JSON`);
	return data;
}

async function requestToken(label: string, params: Record<string, string>, signal: AbortSignal) {
	const data = await requestJson(
		label,
		TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ ...params, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
		},
		signal,
	);
	if (
		!nonBlank(data.access_token) ||
		typeof data.expires_in !== "number" ||
		data.expires_in <= 0 ||
		!Number.isFinite(data.expires_in * 1000) ||
		(data.refresh_token !== undefined && !nonBlank(data.refresh_token))
	) {
		throw new Error(`${label} returned invalid token data`);
	}
	return {
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + data.expires_in * 1000 - EXPIRY_SKEW_MS,
	};
}

function hasFreeTier(tiers: unknown, key: string): boolean {
	if (tiers === undefined || tiers === null) return false;
	if (!Array.isArray(tiers) || !tiers.every(isObject)) throw new Error("loadCodeAssist returned invalid tiers");
	return tiers.some((tier) => tier[key] === FREE_TIER_ID);
}

function readProject(data: Record<string, unknown>): string | undefined {
	const project = data.cloudaicompanionProject;
	if (project === undefined || project === null) return undefined;
	if (!nonBlank(project)) throw new Error("loadCodeAssist returned an invalid project");
	return project;
}

/** Resolve the Cloud Code Assist project: onboarding the free tier when the account has none. */
async function discoverProject(accessToken: string, signal: AbortSignal): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		...antigravityHeaders(),
	};
	const metadata = { ideType: "ANTIGRAVITY" };
	const post = (label: string, url: string, body: Record<string, unknown>) =>
		requestJson(label, url, { method: "POST", headers, body: JSON.stringify(body) }, signal);
	const load = (project?: string) =>
		post("loadCodeAssist", LOAD_CODE_ASSIST_URL, {
			...(project ? { cloudaicompanionProject: project } : {}),
			metadata,
		});

	const initial = await load();
	const initialProject = readProject(initial);
	if (!hasFreeTier(initial.allowedTiers, "id") && hasFreeTier(initial.ineligibleTiers, "tierId")) {
		throw new Error("Antigravity free tier unavailable for this account");
	}
	if (initial.currentTier === undefined || initial.currentTier === null) {
		// Provision the free tier and poll the long-running operation.
		const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
		let operation = await post("onboardUser", ONBOARD_USER_URL, { tierId: FREE_TIER_ID, metadata });
		const name = operation.name;
		while (operation.done !== true) {
			if (operation.error) throw new Error("Antigravity onboarding failed");
			if (typeof name !== "string" || !/^operations\/(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/.test(name)) {
				throw new Error("onboardUser returned an invalid operation name");
			}
			if (Date.now() > deadline) throw new Error("onboardUser timed out");
			await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_INTERVAL_MS));
			if (signal.aborted) throw new Error("login cancelled");
			operation = await requestJson("operation poll", `${OPERATIONS_URL}/${name}`, { headers }, signal);
		}
		if (operation.error) throw new Error("Antigravity onboarding failed");
	}
	const refreshed = await load(initialProject);
	const projectId = readProject(refreshed) ?? initialProject;
	if (!projectId) throw new Error("loadCodeAssist did not return a cloudaicompanionProject");
	return projectId;
}

/** Ask the userinfo endpoint for the account's email, so status lines can name the account. */
async function accountEmail(accessToken: string, signal: AbortSignal): Promise<string | undefined> {
	try {
		const data = await requestJson(
			"account lookup",
			USERINFO_URL,
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			signal,
		);
		return nonBlank(data.email) ? data.email : undefined;
	} catch {
		if (signal.aborted) throw new Error("Login cancelled");
		return undefined;
	}
}

/** Only an explicitly pasted bare code can omit state. Do not downgrade malformed redirects to bare codes. */
function parseAuthorizationInput(input: string, expectedState: string): string {
	const value = input.trim();
	const isUrl = /^[a-z][a-z\d+.-]*:/i.test(value);
	let code: string | null;
	let state: string | null;
	if (isUrl || /[?=&]/.test(value)) {
		let params: URLSearchParams;
		if (isUrl) {
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				throw new Error("Invalid OAuth redirect URL");
			}
			if (url.origin + url.pathname !== REDIRECT_URI || url.username || url.password || url.hash) {
				throw new Error("Invalid OAuth redirect URL");
			}
			params = url.searchParams;
		} else {
			params = new URLSearchParams(value);
		}
		if (params.has("error")) throw new Error("Google authorization failed");
		if (params.getAll("state").length !== 1 || params.getAll("code").length > 1) {
			throw new Error("Invalid OAuth code or state");
		}
		code = params.get("code");
		state = params.get("state");
	} else if (value.includes("#")) {
		const separator = value.indexOf("#");
		code = value.slice(0, separator);
		state = value.slice(separator + 1);
	} else {
		if (!value || /\s/.test(value) || value.startsWith("/")) throw new Error("Invalid authorization code");
		return value;
	}
	if (state !== expectedState) throw new Error("OAuth state mismatch");
	if (!nonBlank(code)) throw new Error("Missing authorization code");
	return code;
}

async function loginAntigravity(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	if (interaction.signal.aborted) throw new Error("Login cancelled");
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const callback = await startOAuthCallbackServer({
		providerName: "Google Antigravity",
		host: CALLBACK_HOST,
		port: CALLBACK_PORT,
		path: CALLBACK_PATH,
		redirectHost: "localhost",
		state,
		complete: async (code) => code,
		signal: interaction.signal,
	}).catch(() => undefined);
	const redirectUri = callback?.redirectUri ?? REDIRECT_URI;

	try {
		const params = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			access_type: "offline",
			prompt: "consent",
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${params.toString()}`,
			instructions:
				"⚠ Google has suspended accounts that signed in to Antigravity from third-party tools. If this Google account matters to you, stop here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete the sign-in in your browser, or paste the authorization code here:",
			placeholder: redirectUri,
		}).catch(() => {
			throw new Error(interaction.signal.aborted ? "Login cancelled" : "Google authorization did not complete");
		});
		const code = result.type === "callback" ? result.value : parseAuthorizationInput(result.input, state);

		interaction.notify({ type: "progress", message: "Exchanging the authorization code..." });
		const tokens = await requestToken(
			"token exchange",
			{ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri },
			interaction.signal,
		);
		if (!tokens.refresh) throw new Error("No refresh token received; revoke access and sign in again");
		interaction.notify({ type: "progress", message: "Provisioning the Antigravity free tier..." });
		const projectId = await discoverProject(tokens.access, interaction.signal);
		const email = await accountEmail(tokens.access, interaction.signal);
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		return {
			type: "oauth",
			refresh: tokens.refresh,
			access: tokens.access,
			expires: tokens.expires,
			projectId,
			...(email ? { email } : {}),
		};
	} finally {
		callback?.close();
	}
}

async function refreshAntigravity(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const data = await requestToken(
		"token refresh",
		{ grant_type: "refresh_token", refresh_token: credential.refresh },
		signal,
	);
	return {
		...credential,
		access: data.access,
		refresh: data.refresh ?? credential.refresh,
		expires: data.expires,
	};
}

export const antigravityOAuth: OAuthAuth = {
	name: "Google Antigravity (Gemini, Claude, GPT-OSS)",
	isSubscription: true,
	loginLabel: "Sign in with Google (Antigravity)",

	login: loginAntigravity,
	refresh: (credential, signal) => refreshAntigravity(credential, signal),
	toAuth: async (credential) => {
		if (!nonBlank(credential.projectId)) throw new Error("Missing Antigravity project; sign in again");
		if (!nonBlank(credential.access)) throw new Error("Missing Antigravity access token; sign in again");
		return { apiKey: JSON.stringify({ token: credential.access, projectId: credential.projectId }) };
	},
};
