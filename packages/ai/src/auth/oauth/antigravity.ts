/**
 * Google Antigravity OAuth flow (Gemini, Claude, GPT-OSS through Cloud Code Assist).
 *
 * Ported from omp's `google-antigravity`: the consumer client credentials Antigravity itself
 * ships, `daily-cloudcode-pa` for project discovery, and the `loadCodeAssist`/`onboardUser`
 * free-tier provisioning after the exchange. The project id is kept on the credential so
 * request building can pass it as the body's `project` field.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
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
const CALLBACK_HOST = getProviderEnvValue("NEKOPAL_OAUTH_CALLBACK_HOST") || "127.0.0.1";
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

async function postJson(
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	signal: AbortSignal,
): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
	return await response.json();
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

async function exchangeCode(
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`token exchange failed (${response.status}): ${await response.text()}`);
	const data = (await response.json()) as TokenResponse;
	if (!data.refresh_token) throw new Error("No refresh token received; revoke access and sign in again");
	return data;
}

interface LoadCodeAssistResponse {
	currentTier?: { id?: string } | null;
	cloudaicompanionProject?: string;
	allowedTiers?: Array<{ id?: string }>;
	ineligibleTiers?: Array<{ tierId?: string; reasonMessage?: string; validationUrl?: string }>;
}

/** Resolve the Cloud Code Assist project: onboarding the free tier when the account has none. */
async function discoverProject(accessToken: string, signal: AbortSignal): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		...antigravityHeaders(),
	};
	const metadata = { ideType: "ANTIGRAVITY" };
	const load = (project?: string) =>
		postJson(
			LOAD_CODE_ASSIST_URL,
			headers,
			{ ...(project ? { cloudaicompanionProject: project } : {}), metadata },
			signal,
		) as Promise<LoadCodeAssistResponse>;

	const initial = await load();
	const ineligible = initial.ineligibleTiers?.find((tier) => tier.tierId === FREE_TIER_ID);
	if (!initial.allowedTiers?.some((tier) => tier.id === FREE_TIER_ID) && ineligible?.reasonMessage) {
		throw new Error(
			`Antigravity free tier unavailable: ${ineligible.reasonMessage}${ineligible.validationUrl ? `\n${ineligible.validationUrl}` : ""}`,
		);
	}
	if (initial.currentTier === undefined || initial.currentTier === null) {
		// Provision the free tier and poll the long-running operation.
		const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
		const operation = (await postJson(ONBOARD_USER_URL, headers, { tierId: FREE_TIER_ID, metadata }, signal)) as {
			name?: string;
			done?: boolean;
			error?: { message?: string };
		};
		while (operation.done !== true) {
			if (Date.now() > deadline) throw new Error("onboardUser timed out");
			await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_INTERVAL_MS));
			if (signal.aborted) throw new Error("login cancelled");
			const polled = await fetch(`${OPERATIONS_URL}/${operation.name ?? ""}`, {
				headers,
				signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
			});
			if (!polled.ok) throw new Error(`operation poll failed (${polled.status})`);
			const body = (await polled.json()) as typeof operation;
			operation.done = body.done;
			operation.error = body.error;
		}
		if (operation.error) throw new Error(`onboardUser failed: ${operation.error.message}`);
	}
	const refreshed = await load(initial.cloudaicompanionProject);
	const projectId = refreshed.cloudaicompanionProject ?? initial.cloudaicompanionProject;
	if (!projectId) throw new Error("loadCodeAssist did not return a cloudaicompanionProject");
	return projectId;
}

/** Ask the userinfo endpoint for the account's email, so status lines can name the account. */
async function accountEmail(accessToken: string, signal: AbortSignal): Promise<string | undefined> {
	try {
		const response = await fetch(USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as { email?: string };
		return data.email;
	} catch {
		return undefined;
	}
}

/**
 * Read `code` and `state` out of whatever the user pasted: a full redirect URL, a query string,
 * a `code#state` pair, or a bare code. Ports omp's Anthropic parser's acceptance table.
 */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a URL: fall through to the pair and bare forms.
	}
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code: code.trim(), state: state.trim() };
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

async function loginAntigravity(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const callback = await startOAuthCallbackServer({
		providerName: "Google Antigravity",
		host: CALLBACK_HOST,
		port: CALLBACK_PORT,
		path: CALLBACK_PATH,
		redirectHost: "localhost",
		state: verifier,
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
			state: verifier,
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
		});
		let code: string | undefined;
		if (result.type === "callback") {
			code = result.value;
		} else {
			// Google redirects with `?code=…&state=…`; a bare code or `code#state` also works.
			const parsed = parseAuthorizationInput(result.input);
			if (parsed.state !== undefined && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
		}
		if (!code) throw new Error("Missing authorization code");

		interaction.notify({ type: "progress", message: "Exchanging the authorization code..." });
		const tokens = await exchangeCode(code, verifier, redirectUri, interaction.signal);
		interaction.notify({ type: "progress", message: "Provisioning the Antigravity free tier..." });
		const projectId = await discoverProject(tokens.access_token, interaction.signal);
		const email = await accountEmail(tokens.access_token, interaction.signal);
		return {
			type: "oauth",
			refresh: tokens.refresh_token ?? "",
			access: tokens.access_token,
			expires: Date.now() + tokens.expires_in * 1000 - EXPIRY_SKEW_MS,
			projectId,
			...(email ? { email } : {}),
		};
	} finally {
		callback?.close();
	}
}

async function refreshAntigravity(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: credential.refresh,
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`token refresh failed (${response.status}): ${await response.text()}`);
	const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
	return {
		type: "oauth",
		refresh: data.refresh_token ?? credential.refresh,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - EXPIRY_SKEW_MS,
		projectId: credential.projectId,
		...(credential.email ? { email: credential.email } : {}),
	};
}

export const antigravityOAuth: OAuthAuth = {
	name: "Google Antigravity (Gemini, Claude, GPT-OSS)",
	isSubscription: true,
	loginLabel: "Sign in with Google (Antigravity)",

	login: loginAntigravity,
	refresh: (credential, signal) => refreshAntigravity(credential, signal),
	toAuth: async (credential) => ({ apiKey: credential.access }),
};
