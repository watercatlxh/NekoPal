import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { antigravityOAuth as oauth } from "../src/auth/oauth/antigravity.ts";
import type * as CallbackModule from "../src/auth/oauth/callback-server.ts";
import type { AuthPrompt, OAuthCredential } from "../src/auth/types.ts";

const { startCallback } = vi.hoisted(() => ({
	startCallback:
		vi.fn<
			(
				options: CallbackModule.OAuthCallbackServerOptions<string>,
			) => Promise<CallbackModule.OAuthCallbackServer<string>>
		>(),
}));
vi.mock("../src/auth/oauth/callback-server.ts", async (importOriginal) => ({
	...(await importOriginal<typeof CallbackModule>()),
	startOAuthCallbackServer: startCallback,
}));

const redirectUri = "http://localhost:51121/oauth-callback";
const tokenUrl = "https://oauth2.googleapis.com/token";
const controlUrl = "https://daily-cloudcode-pa.googleapis.com/v1internal";
const userinfoUrl = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const signal = new AbortController().signal;
const tokens = { access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 };
const existingProject = { currentTier: { id: "free-tier" }, cloudaicompanionProject: "test-project" };
const stored: OAuthCredential = {
	type: "oauth",
	access: "test-old",
	refresh: "test-refresh",
	projectId: "test-project",
	expires: 0,
	email: "test@example.invalid",
};

// Record only the fields under test, never a whole auth URL, header set, or token request body.
function serve(...responses: Response[]) {
	const calls: Array<{
		url: string;
		redirect?: RequestInit["redirect"];
		grant: string | null;
		code: string | null;
		redirectUri: string | null;
		verifier: string | null;
		hasTestBearer: boolean;
	}> = [];
	vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const form = init?.body instanceof URLSearchParams ? init.body : undefined;
		calls.push({
			url: String(input),
			redirect: init?.redirect,
			grant: form?.get("grant_type") ?? null,
			code: form?.get("code") ?? null,
			redirectUri: form?.get("redirect_uri") ?? null,
			verifier: form?.get("code_verifier") ?? null,
			hasTestBearer: new Headers(init?.headers).get("authorization") === "Bearer test-access",
		});
		const response = responses.shift();
		if (!response) throw new Error("Unexpected mock request");
		return response;
	});
	return calls;
}

function serveLogin() {
	return serve(
		Response.json(tokens),
		Response.json(existingProject),
		Response.json({}),
		Response.json({ email: stored.email }),
	);
}

function login(paste: (state: string, prompt: AuthPrompt) => string | Promise<string>, onUrl?: (url: URL) => void) {
	let state = "";
	return oauth.login({
		signal,
		notify(event) {
			if (event.type !== "auth_url") return;
			const url = new URL(event.url);
			state = url.searchParams.get("state") ?? "";
			expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
			expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
			expect(event.instructions).toContain("Google has suspended accounts");
			onUrl?.(url);
		},
		prompt: async (prompt) => paste(state, prompt),
	});
}

describe("Antigravity OAuth", () => {
	beforeEach(() => {
		startCallback.mockReset().mockRejectedValue(new Error("No loopback listener in this test"));
	});
	afterEach(() => vi.unstubAllGlobals());

	it.each([
		["redirect", `${redirectUri}?code=4%2Ftest-code&state=STATE`],
		["query", "state=STATE&code=4%2Ftest-code"],
		["prefixed query", "?code=4%2Ftest-code&state=STATE"],
		["pair", "4/test-code#STATE"],
		["bare code", " 4/test-code "],
	])("exchanges a %s using PKCE and preserves the discovered project", async (_form, template) => {
		const calls = serveLogin();
		let state = "";
		let challenge = "";
		const credential = await login(
			(s) => template.replace("STATE", s),
			(url) => {
				state = url.searchParams.get("state") ?? "";
				challenge = url.searchParams.get("code_challenge") ?? "";
				expect(url.searchParams.get("code_challenge_method")).toBe("S256");
			},
		);
		expect(calls.map((call) => call.url)).toEqual([
			tokenUrl,
			`${controlUrl}:loadCodeAssist`,
			`${controlUrl}:loadCodeAssist`,
			userinfoUrl,
		]);
		expect(calls.every((call) => call.redirect === "error")).toBe(true);
		expect(calls.slice(1).every((call) => call.hasTestBearer)).toBe(true);
		const exchange = calls[0]!;
		expect(exchange.grant).toBe("authorization_code");
		expect(exchange.code).toBe("4/test-code");
		expect(exchange.redirectUri).toBe(redirectUri);
		expect(state.length > 0 && state !== exchange.verifier).toBe(true);
		expect(
			createHash("sha256")
				.update(exchange.verifier ?? "")
				.digest("base64url") === challenge,
		).toBe(true);
		expect(startCallback.mock.calls[0]?.[0].state === state).toBe(true);
		expect(credential.projectId).toBe(stored.projectId);
		expect(credential.email).toBe(stored.email);
		expect(credential.refresh).toBe(tokens.refresh_token);
		expect(JSON.parse((await oauth.toAuth(credential)).apiKey!)).toEqual({
			token: tokens.access_token,
			projectId: "test-project",
		});
	});

	it.each([
		`${redirectUri}?code=test-code`,
		"code=test-code",
		"?code=test-code&state=",
		"?code=test-code&state=wrong",
		"test-code#wrong",
		"?state=STATE&code=",
		"?state=STATE&state=wrong&code=test-code",
		"?code=one&code=two&state=STATE",
		"https://example.invalid/?code=test-code&state=STATE",
		"?error=denied&error_description=private-fixture&state=STATE",
		"",
	])("rejects invalid manual input before exchange (case %#)", async (template) => {
		const calls = serve();
		await expect(login((state) => template.replace("STATE", state))).rejects.toThrow(/OAuth|authorization/i);
		expect(calls.length).toBe(0);
	});

	it("dismisses the manual prompt and closes the listener on a browser callback", async () => {
		const calls = serveLogin();
		const close = vi.fn();
		startCallback.mockImplementationOnce(async (options) => ({
			redirectUri,
			wait: () => options.complete("test-browser-code"),
			cancel: () => {},
			close,
		}));
		let manualSignal: AbortSignal | undefined;
		await login((_state, prompt) => {
			manualSignal = prompt.signal;
			return new Promise<string>(() => {});
		});
		expect(calls[0]?.code).toBe("test-browser-code");
		expect(startCallback.mock.calls[0]?.[0].host).toBe("127.0.0.1");
		expect(manualSignal?.aborted).toBe(true);
		expect(close).toHaveBeenCalledOnce();
	});

	it("onboards a new account and uses its project even if email lookup fails", async () => {
		const calls = serve(
			Response.json(tokens),
			Response.json({}),
			Response.json({ done: true }),
			Response.json(existingProject),
			new Response(null, { status: 403 }),
		);
		const credential = await login(() => "test-code");
		expect(calls.map((call) => call.url)).toEqual([
			tokenUrl,
			`${controlUrl}:loadCodeAssist`,
			`${controlUrl}:onboardUser`,
			`${controlUrl}:loadCodeAssist`,
			userinfoUrl,
		]);
		expect(credential.projectId).toBe("test-project");
		expect(credential.email).toBeUndefined();
	});

	it.each([undefined, "rotated-test-refresh"])(
		"refreshes without losing project or email (case %#)",
		async (rotated) => {
			const calls = serve(Response.json({ ...tokens, refresh_token: rotated }));
			const next = await oauth.refresh(stored, signal);
			expect(calls.map((call) => call.url)).toEqual([tokenUrl]);
			expect(calls[0]?.grant).toBe("refresh_token");
			expect(next.refresh).toBe(rotated ?? stored.refresh);
			expect(next.expires).toBeGreaterThan(Date.now());
			expect(next.email).toBe(stored.email);
			expect(JSON.parse((await oauth.toAuth(next)).apiKey!)).toEqual({
				token: tokens.access_token,
				projectId: stored.projectId,
			});
		},
	);

	it.each([undefined, null, "", "  ", 42])("requires a nonblank stored project (case %#)", async (projectId) => {
		await expect(oauth.toAuth({ ...stored, projectId })).rejects.toThrow(/project.*sign in again/i);
	});

	it.each([
		[new Response("private-fixture", { status: 403 }), "token exchange failed (HTTP 403)"],
		[new Response("private-fixture"), "token exchange returned invalid JSON"],
		[Response.json({ ...tokens, access_token: [] }), "token exchange returned invalid token data"],
		[Response.json({ ...tokens, expires_in: -1 }), "token exchange returned invalid token data"],
		[
			Response.json({ ...tokens, refresh_token: undefined }),
			"No refresh token received; revoke access and sign in again",
		],
	] as const)("rejects invalid token responses without printing the body (case %#)", async (response, message) => {
		const calls = serve(response);
		await expect(login(() => "test-code")).rejects.toThrow(new Error(message));
		expect(calls.length).toBe(1);
	});

	it("does not forward provider messages or validation links on ineligibility", async () => {
		const calls = serve(
			Response.json(tokens),
			Response.json({
				ineligibleTiers: [
					{
						tierId: "free-tier",
						reasonMessage: "private-fixture",
						validationUrl: "https://example.invalid/private-fixture",
					},
				],
			}),
		);
		await expect(login(() => "test-code")).rejects.toThrow(
			new Error("Antigravity free tier unavailable for this account"),
		);
		expect(calls.length).toBe(2);
	});

	it("does not follow a provider-supplied operation URL", async () => {
		const calls = serve(
			Response.json(tokens),
			Response.json({}),
			Response.json({ name: "https://example.invalid/private-fixture" }),
		);
		await expect(login(() => "test-code")).rejects.toThrow(
			new Error("onboardUser returned an invalid operation name"),
		);
		expect(calls.length).toBe(3);
	});

	it("rejects malformed project data before constructing a credential", async () => {
		serve(Response.json(tokens), Response.json({ ...existingProject, cloudaicompanionProject: {} }));
		await expect(login(() => "test-code")).rejects.toThrow(new Error("loadCodeAssist returned an invalid project"));
	});
});
