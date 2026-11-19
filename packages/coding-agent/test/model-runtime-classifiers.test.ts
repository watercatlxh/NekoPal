import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const context = {
	state: { text: "Looks good" },
	questions: {
		approved: {
			type: "bool" as const,
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

const image = { type: "image" as const, data: "cG5n", mimeType: "image/png" };

describe("ModelRuntime classifiers", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createRuntime(modelsJson?: object): Promise<ModelRuntime> {
		let modelsPath: string | null = null;
		if (modelsJson) {
			const dir = mkdtempSync(join(tmpdir(), "pi-classifiers-"));
			tempDirs.push(dir);
			modelsPath = join(dir, "models.json");
			writeFileSync(modelsPath, JSON.stringify(modelsJson));
		}
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});
	}

	/** Classifies one image and returns the request the service received. */
	async function captureImageRequest(runtime: ModelRuntime, provider: string, id: string) {
		await runtime.setRuntimeApiKey(provider, "secret");
		const model = runtime.getModelOfType("classifier", provider, id)!;
		const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
		const result = await runtime.classify(
			model,
			{ ...context, images: [image] },
			{
				fetch: async (input, init) => {
					requests.push({
						url: String(input),
						body: JSON.parse(String(init?.body)) as Record<string, unknown>,
						headers: new Headers(init?.headers),
					});
					return Response.json({ answers: [{ name: "approved", type: "predicate", probability: 0.8 }] });
				},
			},
		);
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		return requests[0]!;
	}

	it("lists classifiers separately and classifies with runtime-resolved auth", async () => {
		const runtime = await createRuntime();
		const classifier = runtime.getModelOfType("classifier", "openai", "gpt-6-luna")!;
		expect(classifier.type).toBe("classifier");
		expect(runtime.getModels("openai").every((model) => model.type === "chat")).toBe(true);

		const unconfigured = await runtime.classify(classifier, context);
		expect(unconfigured.stopReason).toBe("error");
		expect(unconfigured.errorMessage).toContain("not configured");

		await runtime.setRuntimeApiKey("openai", "sk-openai");
		expect(await runtime.getAvailableOfType("classifier", "openai")).toEqual([classifier]);
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-openai");
			return Response.json({ answers: [{ name: "approved", type: "predicate", probability: 0.8 }] });
		});
		const result = await runtime.classify(classifier, context, { fetch });
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
	});

	it("sends images as input_image parts alongside the JSON state", async () => {
		const runtime = await createRuntime();

		const request = await captureImageRequest(runtime, "openai", "gpt-6-luna");

		expect(request.url).toBe("https://api.openai.com/v1/decisions");
		expect(request.body.input).toEqual([
			{
				role: "user",
				content: [
					{ type: "input_text", text: JSON.stringify(context.state) },
					{ type: "input_image", image_url: "data:image/png;base64,cG5n" },
				],
			},
		]);
		expect(request.headers.get("authorization")).toBe("Bearer secret");
	});

	it("applies a models.json baseUrl to classifier models", async () => {
		const runtime = await createRuntime({
			providers: { openai: { baseUrl: "https://proxy.example.com/v1" } },
		});

		const request = await captureImageRequest(runtime, "openai", "gpt-6-luna");

		expect(request.url).toBe("https://proxy.example.com/v1/decisions");
		expect(request.body.model).toBe("gpt-6-luna");
	});
});
