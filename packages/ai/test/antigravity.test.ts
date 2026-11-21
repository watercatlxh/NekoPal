import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { GOOGLE_MODELS } from "../src/providers/google.models.ts";
import { googleProvider } from "../src/providers/google.ts";
import type { FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Inference is independent of account roster discovery. Never follow a model-supplied host for OAuth.
const model: Model<"google-generative-ai"> = {
	...Object.values(GOOGLE_MODELS)[0]!,
	id: "gemini-3-flash",
	reasoning: true,
	thinkingLevelMap: {},
	baseUrl: "https://other.example.invalid/v1",
};
const apiKey = JSON.stringify({ token: "test-token", projectId: "test-project" });
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
	systemPrompt: "Answer briefly.",
	tools: [{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) }],
});
const finish = { candidates: [{ finishReason: "STOP" }] };

function sse(response: unknown): string {
	return `data: ${JSON.stringify({ response })}\n\n`;
}

describe("Antigravity inference", () => {
	it("sends a bearer-authenticated Cloud Code Assist envelope and streams unwrapped Google chunks", async () => {
		const first = { responseId: "r1", candidates: [{ content: { parts: [{ text: "hi 好" }] } }] };
		const last = { ...finish, usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 } };
		// Split inside both CRLF and UTF-8, and across two data fields in the same event.
		const bytes = new TextEncoder().encode(
			`: ping\r\n\r\ndata: {\r\ndata: "response":${JSON.stringify(first)}}\r\n\r\n${sse(last)}`,
		);
		const fetch = vi.fn<FetchFunction>(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.subarray(i, i + 1));
							controller.close();
						},
					}),
					{ headers: { "x-request-id": "123" } },
				),
		);
		const signal = new AbortController().signal;
		const chunks: unknown[] = [];
		const onResponse = vi.fn();
		const message = await googleProvider()
			.streamSimple(model, context, {
				apiKey,
				fetch,
				signal,
				reasoning: "medium",
				sessionId: "s1",
				temperature: 0,
				maxTokens: 100,
				toolChoice: "auto",
				headers: { "x-goog-api-key": "never-forward", Authorization: "not-the-grant" },
				onProviderStreamEvent: (chunk) => {
					chunks.push(chunk);
				},
				onResponse,
			})
			.result();

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(init).toMatchObject({ method: "POST", redirect: "error" });
		expect(init?.signal).toBe(signal);
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-token");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.has("x-goog-api-key")).toBe(false);
		expect(String(init?.body)).not.toContain("test-token");
		expect(JSON.parse(String(init?.body))).toEqual({
			project: "test-project",
			model: model.id,
			requestType: "agent",
			request: {
				sessionId: "s1",
				contents: [{ role: "user", parts: [{ text: "hello" }] }],
				systemInstruction: { parts: [{ text: "Answer briefly." }] },
				generationConfig: {
					temperature: 0,
					maxOutputTokens: 100,
					thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
				},
				toolConfig: { functionCallingConfig: { mode: "AUTO" } },
				tools: [
					{
						functionDeclarations: [
							{ name: "echo", description: "Echo text", parametersJsonSchema: expect.any(Object) },
						],
					},
				],
			},
		});
		expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: { "x-request-id": "123" } }, model);
		expect(chunks).toEqual([first, last]);
		expect(message).toMatchObject({
			responseId: "r1",
			content: [{ type: "text", text: "hi 好" }],
			rawStopReason: "STOP",
			stopReason: "stop",
			usage: { input: 4, output: 1, totalTokens: 5 },
		});
	});

	it("uses Claude's parameters field and preserves tool calls, thinking signatures and finish reasons", async () => {
		const parts = [
			{ thought: true, text: "plan", thoughtSignature: "c2ln" },
			{ functionCall: { name: "echo", id: "call1", args: { text: "hello" } } },
		];
		const fetch = vi.fn<FetchFunction>(
			async () => new Response(sse({ candidates: [{ content: { parts }, finishReason: "STOP" }] })),
		);
		const events: string[] = [];
		const stream = googleProvider().stream({ ...model, id: "claude-sonnet-4-5" }, context, {
			apiKey,
			fetch,
			thinking: { enabled: true, budgetTokens: 1200 },
		});
		for await (const event of stream) events.push(event.type);
		expect(events).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		const { request } = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
		expect(request.tools[0].functionDeclarations[0]).toEqual({
			name: "echo",
			description: "Echo text",
			parameters: expect.any(Object),
		});
		expect(request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1200 });
		expect(await stream.result()).toMatchObject({
			content: [
				{ type: "thinking", thinking: "plan", thinkingSignature: "c2ln" },
				{ type: "toolCall", id: "call1", name: "echo", arguments: { text: "hello" } },
			],
			stopReason: "toolUse",
			rawStopReason: "STOP",
		});
	});

	it.each([undefined, "test-token", JSON.stringify({ token: "test-token", projectId: " " })])(
		"rejects malformed or projectless credentials before fetch",
		async (invalid) => {
			const fetch = vi.fn<FetchFunction>();
			const message = await googleProvider().stream(model, context, { apiKey: invalid, fetch }).result();
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toMatch(/sign in/i);
			expect(message.errorMessage).not.toContain("test-token");
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each([
		[403, "denied test-token", /403/],
		[200, "", /finish reason/i],
		[200, sse({ candidates: [{ content: { parts: [{ text: "partial" }] } }] }), /finish reason/i],
		[200, 'data: {"error":{"message":"test-token"}}\n\n', /error/i],
		[200, "event: error\ndata: test-token\n\n", /error/i],
		[200, "data: not JSON\n\n", /json/i],
	] as const)("reports HTTP or stream failure without retrying (case %#)", async (status, body, expected) => {
		const fetch = vi.fn<FetchFunction>(async () => new Response(body, { status }));
		const message = await googleProvider().stream(model, context, { apiKey, fetch, maxRetries: 3 }).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(expected);
		expect(message.errorMessage).not.toContain("test-token");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("cancels a pending SSE read without waiting for the server to close", async () => {
		const abort = new AbortController();
		const cancel = vi.fn();
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(sse({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })),
				);
			},
			cancel,
		});
		const stream = googleProvider().stream(model, context, {
			apiKey,
			fetch: async () => new Response(body),
			signal: abort.signal,
		});
		for await (const event of stream) if (event.type === "text_delta") abort.abort();
		expect((await stream.result()).stopReason).toBe("aborted");
		expect(cancel).toHaveBeenCalledOnce();
	});
});
