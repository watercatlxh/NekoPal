import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredential } from "../src/auth/types.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import { googleModelDiscovery } from "../src/providers/google-model-discovery.ts";

const credential: OAuthCredential = {
	type: "oauth",
	refresh: "test-refresh",
	access: "test-token",
	projectId: "test-project",
	expires: 9e12,
};
const context: RefreshModelsContext = {
	credential,
	allowNetwork: true,
	signal: new AbortController().signal,
	async publish({ update }) {
		update?.();
		return true;
	},
};
afterEach(() => vi.unstubAllGlobals());

describe("Antigravity account roster", () => {
	it("selects only models the account reports, including new IDs and excluding disabled/internal/image-only rows", async () => {
		const discovery = googleModelDiscovery();
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				models: {
					"gemini-3-flash": {},
					"new-chat": { displayName: "New", maxOutputTokens: 16384 },
					disabled: { disabled: true },
					internal: { isInternal: true },
					image: {},
				},
				imageGenerationModelIds: ["image"],
			}),
		);
		vi.stubGlobal("fetch", request);
		expect(discovery.getModels()).toEqual([]);
		await discovery.refreshModels!({ ...context, allowNetwork: false });
		expect(request).not.toHaveBeenCalled();
		await discovery.refreshModels!(context);
		expect(discovery.getModels().map((model) => model.id)).toEqual(["gemini-3-flash", "new-chat"]);
		expect(discovery.getModels()[1].maxTokens).toBe(16384);
		expect(request).toHaveBeenCalledWith(
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			expect.objectContaining({
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: '{"project":"test-project"}',
				redirect: "error",
			}),
		);
		await discovery.refreshModels!(context);
		expect(request).toHaveBeenCalledTimes(1);
		await discovery.refreshModels!({
			...context,
			credential: { ...credential, refresh: "other-account" },
			allowNetwork: false,
		});
		expect(discovery.getModels()).toEqual([]);
	});
	it("does not substitute bundled models or retry a refused account", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("fake sensitive body", { status: 403 }));
		vi.stubGlobal("fetch", request);
		const discovery = googleModelDiscovery();
		await expect(discovery.refreshModels!(context)).rejects.toThrow("Could not load the Google account model list");
		expect(request).toHaveBeenCalledTimes(1);
		expect(discovery.getAllModels!()).toEqual([]);
	});
});
