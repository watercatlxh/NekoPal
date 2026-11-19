import { beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	finishReason: "MALFORMED_FUNCTION_CALL",
	includeFunctionCall: false,
	streamChunks: undefined as Array<Record<string, unknown>> | undefined,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		constructor(config: Record<string, unknown>) {
			googleGenAiMock.constructorCalls.push(config);
		}

		models = {
			generateContentStream: async function* () {
				if (googleGenAiMock.streamChunks) {
					yield* googleGenAiMock.streamChunks;
					return;
				}
				yield {
					responseId: "google-response-id",
					candidates: [
						{
							finishReason: googleGenAiMock.finishReason,
							...(googleGenAiMock.includeFunctionCall && {
								content: {
									parts: [
										{
											functionCall: {
												id: "call-1",
												name: "echo",
												args: { value: "truncated" },
											},
										},
									],
								},
							}),
						},
					],
					usageMetadata: {
						promptTokenCount: 1,
						candidatesTokenCount: 0,
						totalTokenCount: 1,
					},
				};
			},
		};
	}

	return {
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			SAFETY: "SAFETY",
			IMAGE_SAFETY: "IMAGE_SAFETY",
			IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT",
			IMAGE_RECITATION: "IMAGE_RECITATION",
			IMAGE_OTHER: "IMAGE_OTHER",
			RECITATION: "RECITATION",
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
			OTHER: "OTHER",
			LANGUAGE: "LANGUAGE",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
			NO_IMAGE: "NO_IMAGE",
		},
		FunctionCallingConfigMode: {
			AUTO: "AUTO",
			NONE: "NONE",
			ANY: "ANY",
			VALIDATED: "VALIDATED",
		},
		GoogleGenAI,
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { normalizeContext } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";
import { formatUserAgent } from "../src/utils/identity.ts";

function makeModel(id = "gemini-2.5-flash"): Model<"google-generative-ai"> {
	return {
		id,
		name: id,
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	};
}

beforeEach(() => {
	googleGenAiMock.streamChunks = undefined;
});

const USER_AGENT = formatUserAgent();

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

async function captureGoogleHeaders(headers?: Record<string, string>): Promise<Record<string, string>> {
	googleGenAiMock.constructorCalls.length = 0;
	googleGenAiMock.finishReason = "STOP";
	googleGenAiMock.includeFunctionCall = false;
	await streamGoogleGenerativeAi(makeModel(), context, {
		apiKey: "test-api-key",
		headers,
	}).result();

	expect(googleGenAiMock.constructorCalls).toHaveLength(1);
	const httpOptions = googleGenAiMock.constructorCalls[0].httpOptions as { headers?: Record<string, string> };
	return httpOptions.headers ?? {};
}

describe("Google raw stop reasons", () => {
	it("preserves raw Gemini finish reasons for Google Generative AI errors", async () => {
		googleGenAiMock.finishReason = "MALFORMED_FUNCTION_CALL";
		googleGenAiMock.includeFunctionCall = false;

		const stream = streamGoogleGenerativeAi(makeModel(), context, {
			apiKey: "test-api-key",
		});

		const message = await stream.result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("MALFORMED_FUNCTION_CALL");
		expect(message.errorMessage).toBe("Provider stopped with: MALFORMED_FUNCTION_CALL");
	});

	const createStream = () =>
		streamGoogleGenerativeAi(makeModel(), context, {
			apiKey: "test-api-key",
		});

	it("preserves MAX_TOKENS with a tool call as length", async () => {
		googleGenAiMock.finishReason = "MAX_TOKENS";
		googleGenAiMock.includeFunctionCall = true;

		const message = await createStream().result();

		expect(message.stopReason).toBe("length");
		expect(message.rawStopReason).toBe("MAX_TOKENS");
		expect(message.content.some((block) => block.type === "toolCall")).toBe(true);
	});

	it("maps STOP with a tool call to toolUse", async () => {
		googleGenAiMock.finishReason = "STOP";
		googleGenAiMock.includeFunctionCall = true;

		const message = await createStream().result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.rawStopReason).toBe("STOP");
		expect(message.content.some((block) => block.type === "toolCall")).toBe(true);
	});
});

describe("Google provider stream events", () => {
	const googleModel = makeModel();

	it("forwards each SDK chunk in order before normalizing it", async () => {
		googleGenAiMock.streamChunks = [
			{
				responseId: "resp_google",
				candidates: [{ content: { parts: [{ text: "hello" }] } }],
			},
			{
				candidates: [{ finishReason: "STOP" }],
				usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
			},
		];
		const received: unknown[] = [];
		const eventModels: Model<Api>[] = [];
		const result = await streamGoogleGenerativeAi(googleModel, context, {
			apiKey: "test-api-key",
			onProviderStreamEvent: async (chunk, eventModel) => {
				await Promise.resolve();
				received.push(chunk);
				eventModels.push(eventModel);
			},
		}).result();

		expect(received).toEqual(googleGenAiMock.streamChunks);
		expect(received[0]).toBe(googleGenAiMock.streamChunks[0]);
		expect(received[1]).toBe(googleGenAiMock.streamChunks[1]);
		expect(eventModels).toEqual([googleModel, googleModel]);
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBe("resp_google");
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});
});

describe("Google Generative AI user agent", () => {
	it("uses pi's User-Agent by default", async () => {
		expect((await captureGoogleHeaders())["User-Agent"]).toBe(USER_AGENT);
	});

	it("lets explicit headers override the default User-Agent", async () => {
		expect((await captureGoogleHeaders({ "User-Agent": "custom-agent" }))["User-Agent"]).toBe("custom-agent");
	});
});
