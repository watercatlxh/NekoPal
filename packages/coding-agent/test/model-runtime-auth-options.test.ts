import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuthType,
	type CredentialStore,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { allowNetwork } from "./test-network-env.ts";

function authOptions(runtime: ModelRuntime, type?: AuthType) {
	return runtime
		.getProviders()
		.flatMap((provider) => [
			...(!type || type === "oauth"
				? provider.auth.oauth
					? [{ type: "oauth" as const, provider, method: provider.auth.oauth }]
					: []
				: []),
			...(!type || type === "api_key"
				? provider.auth.apiKey
					? [{ type: "api_key" as const, provider, method: provider.auth.apiKey }]
					: []
				: []),
		]);
}

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("ModelRuntime auth options", () => {
	it("accepts a pi-ai CredentialStore", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "stored-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-key");
	});

	it("scopes provider availability reads and records refresh failures", async () => {
		const base = new InMemoryCredentialStore();
		const reads: string[] = [];
		let failReads = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				reads.push(providerId);
				if (failReads) throw new Error(`read failed for ${providerId}`);
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		reads.length = 0;
		await runtime.getAvailable("anthropic");
		expect(new Set(reads)).toEqual(new Set(["anthropic"]));

		failReads = true;
		await expect(runtime.getAvailable("anthropic")).rejects.toThrow("Credential store read failed for anthropic");
		expect(runtime.getError()).toContain("Availability refresh: Credential store read failed for anthropic");

		failReads = false;
		await runtime.getAvailable();
		expect(runtime.getError()).toBeUndefined();
	});

	it("projects provider-owned methods, names, and status", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const options = authOptions(runtime);

		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "oauth",
					provider: expect.objectContaining({ id: "anthropic", name: "Anthropic" }),
				}),
				expect.objectContaining({
					type: "oauth",
					provider: expect.objectContaining({ id: "openai", name: "OpenAI" }),
				}),
				expect.objectContaining({
					type: "oauth",
					provider: expect.objectContaining({ id: "xai", name: "xAI" }),
				}),
			]),
		);
		expect(authOptions(runtime, "api_key").every((option) => option.type === "api_key")).toBe(true);
		expect(authOptions(runtime, "oauth").every((option) => option.type === "oauth")).toBe(true);
		expect(options.some((option) => option.provider.id === "openai-codex" && option.type === "api_key")).toBe(false);
	});

	it("attaches the provider's active auth status to every method option", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "access",
					refresh: "refresh",
					expires: Date.now() + 60_000,
				},
			}),
			modelsPath: null,
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "anthropic");
		expect(options).toHaveLength(2);
		expect(await runtime.checkAuth("anthropic")).toMatchObject({ type: "oauth" });
	});

	it("distinguishes subscription OAuth from generic OAuth sign-in", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "oauth",
					access: "anthropic-access",
					refresh: "anthropic-refresh",
					expires: Date.now() + 60 * 60_000,
				},
				openai: {
					type: "oauth",
					access: "openai-access",
					refresh: "",
					expires: Number.MAX_SAFE_INTEGER,
				},
			}),
			modelsPath: null,
		});

		expect(runtime.isUsingOAuth("anthropic")).toBe(true);
		expect(runtime.isUsingSubscription("anthropic")).toBe(true);
		expect(runtime.isUsingOAuth("openai")).toBe(true);
		expect(runtime.isUsingSubscription("openai")).toBe(true);
		expect(runtime.isUsingOAuth("xai")).toBe(false);
	});

	it("constructs an API key method for an extension API-key provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-api-key", {
			name: "Extension API Key",
			baseUrl: "https://example.test/v1",
			apiKey: "$EXTENSION_TEST_API_KEY",
			api: "openai-completions",
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-api-key");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "api_key",
			provider: { id: "extension-api-key", name: "Extension API Key" },
			method: { name: "API key" },
		});
		expect(options[0]?.method.login).toBeTypeOf("function");
	});

	it("resolves configured auth from request-scoped environment overrides", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("request-env-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "$REQUEST_SCOPED_API_KEY",
			headers: { "x-request-value": "$REQUEST_SCOPED_HEADER" },
			api: "openai-completions",
			models: [testModel("request-env-model")],
		});

		const auth = await runtime.getAuth("request-env-provider", {
			env: { REQUEST_SCOPED_API_KEY: "request-key", REQUEST_SCOPED_HEADER: "request-header" },
		});

		expect(auth?.auth).toEqual({ apiKey: "request-key", headers: { "x-request-value": "request-header" } });
	});

	it("lets an explicit Authorization header override authHeader case-insensitively", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("auth-header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [testModel("auth-header-model")],
		});
		const model = runtime.getModel("auth-header-provider", "auth-header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] }, { headers: { authorization: "Explicit token" } });

		expect(capturedHeaders).toEqual({ authorization: "Explicit token" });
	});

	it("transforms fully assembled headers once without forwarding the transform", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		let transforms = 0;
		runtime.registerProvider("header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			headers: { "x-provider": "provider" },
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				expect(options).not.toHaveProperty("transformHeaders");
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [{ ...testModel("header-model"), headers: { "x-model": "model" } }],
		});
		const model = runtime.getModel("header-provider", "header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				headers: { "x-explicit": "explicit" },
				transformHeaders: async (headers) => {
					transforms++;
					expect(headers).toEqual({
						Authorization: "Bearer generated-key",
						"x-provider": "provider",
						"x-model": "model",
						"x-explicit": "explicit",
					});
					return { ...headers, "x-transformed": "yes" };
				},
			},
		);

		expect(transforms).toBe(1);
		expect(capturedHeaders).toEqual({
			Authorization: "Bearer generated-key",
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-transformed": "yes",
		});
	});

	it("does not cancel an extension OAuth refresh with the request", async () => {
		const credentials = AuthStorage.inMemory({
			"extension-oauth": {
				type: "oauth",
				access: "expired",
				refresh: "refresh",
				expires: 0,
			},
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		let refreshSignal: AbortSignal | undefined;
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential, signal) => {
					refreshSignal = signal;
					return { ...credential, expires: Date.now() + 60_000 };
				},
				getApiKey: (credential) => credential.access,
			},
			models: [testModel("extension-model")],
		});
		const controller = new AbortController();

		await runtime.getAuth("extension-oauth", { signal: controller.signal });
		expect(refreshSignal).toBeInstanceOf(AbortSignal);
		const reason = new Error("cancelled");
		controller.abort(reason);
		// A started refresh may already have rotated the refresh token and must be persisted.
		expect(refreshSignal?.aborted).toBe(false);
	});

	it("does not fabricate an API key method for an extension OAuth-only provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				isSubscription: true,
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-oauth");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "oauth",
			provider: { id: "extension-oauth", name: "Extension OAuth" },
			method: { name: "Extension subscription", isSubscription: true },
		});
	});
});

describe("ModelRuntime builtinOAuthOnly", () => {
	const ids = ["anthropic", "google", "openai", "openai-codex", "xai"] as const;
	const oauth = {
		type: "oauth" as const,
		access: "stored-access",
		refresh: "refresh",
		expires: Number.MAX_SAFE_INTEGER,
	};
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function writeModels(providers: Record<string, unknown>): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-builtin-oauth-"));
		dirs.push(dir);
		const path = join(dir, "models.json");
		writeFileSync(path, JSON.stringify({ providers }));
		return path;
	}

	it.each(["environment", "stored"])("does not accept %s keys for any builtin", async (source) => {
		const credentials = new InMemoryCredentialStore();
		if (source === "stored") {
			for (const id of ids) await credentials.modify(id, async () => ({ type: "api_key", key: "old-key" }));
		} else {
			for (const name of [
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_AUTH_TOKEN",
				"OPENAI_API_KEY",
				"XAI_API_KEY",
				"GEMINI_API_KEY",
				"GOOGLE_API_KEY",
			]) {
				vi.stubEnv(name, "env-key");
			}
		}
		const fetch = vi.fn((): never => {
			throw new Error("unexpected network access");
		});
		vi.stubGlobal("fetch", fetch);
		allowNetwork();
		const runtime = await ModelRuntime.create({
			builtinOAuthOnly: true,
			credentials,
			modelsPath: null,
			allowModelNetwork: true,
		});
		const interaction = { prompt: vi.fn(async () => "another-key"), notify: vi.fn() };
		for (const id of ids) {
			expect(runtime.getProvider(id)?.auth.oauth?.login).toBeTypeOf("function");
			expect(runtime.getProvider(id)?.auth.apiKey).toBeUndefined();
			expect(await runtime.getAuth(id, { apiKey: "explicit-key" })).toBeUndefined();
			expect(await runtime.checkAuth(id)).toBeUndefined();
			expect(runtime.getProviderAuthStatus(id)).toEqual({ configured: false });
			expect(runtime.hasConfiguredAuth(id)).toBe(false);
			expect(await runtime.getAvailable(id)).toEqual([]);
			await expect(runtime.login(id, "api_key", interaction)).rejects.toThrow();
			await expect(runtime.setRuntimeApiKey(id, "runtime-key")).rejects.toThrow();
			expect(await credentials.read(id)).toEqual(
				source === "stored" ? { type: "api_key", key: "old-key" } : undefined,
			);
		}
		expect(interaction.prompt).not.toHaveBeenCalled();
		expect(await runtime.getAvailable()).toEqual([]);
		expect(runtime.getAvailableSnapshot()).toEqual([]);
		expect(await runtime.getAllAvailable()).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps each builtin's OAuth usable and resolves it instead of request keys", async () => {
		allowNetwork();
		const credentials = new InMemoryCredentialStore();
		for (const id of ids) await credentials.modify(id, async () => ({ ...oauth, projectId: "test-project" }));
		const runtime = await ModelRuntime.create({ builtinOAuthOnly: true, credentials, modelsPath: null });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ models: { "gemini-3-flash": { displayName: "Gemini 3 Flash" } } })),
		);
		const refresh = await runtime.refresh({ providers: ["google"], allowNetwork: true });
		expect(refresh.errors.size).toBe(0);
		for (const id of ids) {
			expect(runtime.getProviderAuthStatus(id)).toEqual({ configured: true, source: "stored" });
			expect(await runtime.checkAuth(id)).toMatchObject({ type: "oauth" });
			expect(runtime.hasConfiguredAuth(id)).toBe(true);
			const models = await runtime.getAvailable(id);
			expect(models.length).toBeGreaterThan(0);
			if (id === "google") expect(models.map((model) => model.id)).toEqual(["gemini-3-flash"]);
			const auth = await runtime.getAuth(id, { apiKey: "ignored" });
			expect(auth?.source).toBe("OAuth");
			if (id === "google") {
				expect(JSON.parse(auth!.auth.apiKey!)).toEqual({ token: oauth.access, projectId: "test-project" });
			} else {
				expect(auth?.auth.apiKey).toBe(oauth.access);
			}
			const stale = { ...models[0]!, headers: { Authorization: "bad" } };
			expect(await runtime.getAuth(stale, { apiKey: "ignored" })).toEqual(auth);
		}
	});

	it("still publishes local OAuth status when initial account discovery times out", async () => {
		allowNetwork();
		vi.stubGlobal("fetch", (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const signal = init?.signal;
			signal?.throwIfAborted();
			const { promise, reject } = Promise.withResolvers<Response>();
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		});
		const runtime = await ModelRuntime.create({
			builtinOAuthOnly: true,
			credentials: AuthStorage.inMemory({ google: { ...oauth, projectId: "test-project" }, xai: oauth }),
			modelsPath: null,
			allowModelNetwork: true,
			modelRefreshTimeoutMs: 20,
		});
		expect(runtime.hasConfiguredAuth("google")).toBe(true);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "xai")).toBe(true);
	});

	it("ignores builtin overlays before and after refresh, without provisionally advertising an old key", async () => {
		const credentials = AuthStorage.inMemory({ xai: { type: "api_key", key: "old-key" } });
		const id = getBuiltinModels("xai")[0]!.id;
		const runtime = await ModelRuntime.create({
			builtinOAuthOnly: true,
			credentials,
			modelsPath: writeModels({
				xai: {
					apiKey: "config-key",
					baseUrl: "https://overlay.test",
					headers: { Authorization: "bad", "x-provider": "bad" },
					modelOverrides: { [id]: { headers: { "x-model": "bad" } } },
				},
			}),
			modelsStore: new InMemoryModelsStore(),
		});
		const original = runtime.getProvider("xai")!;
		const model = runtime.getModel("xai", id)!;
		const replacement = vi.fn((): never => {
			throw new Error("replacement transport invoked");
		});
		expect(() =>
			runtime.registerVirtualModel({ id: "not-in-account", provider: "xai", name: "Virtual", route: replacement }),
		).toThrow(/separate provider ID/);
		runtime.registerProvider("xai", {
			api: "openai-responses",
			apiKey: "extension-key",
			baseUrl: "https://extension.test",
			models: [{ ...testModel(id), headers: { "x-extension": "bad" } }],
			streamSimple: replacement,
		});
		expect(runtime.getProvider("xai")).toBe(original);
		expect(runtime.hasConfiguredAuth("xai")).toBe(false);
		expect(runtime.getProviderAuthStatus("xai")).toEqual({ configured: false });
		expect(await runtime.getAuth(model)).toBeUndefined();
		expect(() => runtime.getCompatibilityRequestConfig(model)).toThrow(/OAuth/);
		runtime.registerNativeProvider({
			...original,
			baseUrl: "https://native.test",
			auth: {
				oauth: { ...original.auth.oauth!, toAuth: replacement },
				apiKey: { name: "Replacement", resolve: replacement },
			},
			streamSimple: replacement,
		});
		expect(runtime.hasConfiguredAuth("xai")).toBe(false);
		await credentials.modify("xai", async () => oauth);
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getProvider("xai")).toBe(original);
		expect(runtime.getProviderAuthStatus("xai")).toEqual({ configured: true, source: "stored" });
		const requests: Request[] = [];
		const result = await runtime.completeSimple(
			{ ...model, api: "wrong-transport", baseUrl: "https://stale.test", headers: { "x-stale": "bad" } },
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "override",
				headers: { Authorization: "Bearer override", "x-request": "bad" },
				transformHeaders: replacement,
				fetch: async (input, init) => {
					requests.push(new Request(input, init));
					return new Response("denied", { status: 403 });
				},
			},
		);
		expect(result.stopReason).toBe("error");
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe("https://api.x.ai/v1/responses");
		expect(requests[0]!.headers.get("authorization")).toBe(`Bearer ${oauth.access}`);
		for (const name of ["x-request", "x-stale", "x-extension", "x-provider", "x-model"]) {
			expect(requests[0]!.headers.has(name)).toBe(false);
		}
		expect(replacement).not.toHaveBeenCalled();
	});

	it("leaves the SDK's builtin API key methods intact in a separate default runtime", async () => {
		const credentials = AuthStorage.inMemory({ openai: { type: "api_key", key: "sdk-key" } });
		const strict = await ModelRuntime.create({ builtinOAuthOnly: true, credentials, modelsPath: null });
		const sdk = await ModelRuntime.create({ credentials, modelsPath: null });
		expect(await strict.getAuth("openai")).toBeUndefined();
		expect(sdk.getProvider("openai")?.auth.apiKey).toBeDefined();
		expect((await sdk.getAuth("openai"))?.auth.apiKey).toBe("sdk-key");
	});

	it("lets a separate models.json provider resolve its configured key and complete a request", async () => {
		const runtime = await ModelRuntime.create({
			builtinOAuthOnly: true,
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: writeModels({
				myapi: {
					api: "openai-responses",
					apiKey: "custom-key",
					baseUrl: "https://custom.test/v1",
					headers: { "x-custom": "works" },
					models: [testModel("custom-model")],
				},
			}),
		});
		const [model] = await runtime.getAvailable("myapi");
		expect((await runtime.getAuth(model!))?.auth.apiKey).toBe("custom-key");
		const requests: Request[] = [];
		const result = await runtime.completeSimple(
			model!,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				fetch: async (input, init) => {
					requests.push(new Request(input, init));
					return new Response(
						'data: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n',
						{
							headers: { "content-type": "text/event-stream" },
						},
					);
				},
			},
		);
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0]!.url).toBe("https://custom.test/v1/responses");
		expect(requests[0]!.headers.get("authorization")).toBe("Bearer custom-key");
		expect(requests[0]!.headers.get("x-custom")).toBe("works");
	});
});
