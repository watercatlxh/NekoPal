import type { GenerateContentResponse } from "@google/genai";
import type { SimpleStreamOptions, StreamFunction } from "../types.ts";
import { headersToRecord } from "../utils/headers.ts";
import { iterateSseMessages } from "../utils/sse.ts";
import { buildGoogleRequest, type GoogleOptions, googleSimpleOptions } from "./google-request.ts";
import { streamGoogleResponse } from "./google-stream.ts";

const STREAM_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";

function parseGrant(apiKey?: string): { token: string; projectId: string } {
	const invalidGrant = "Missing or invalid Antigravity OAuth grant. Sign in again to authorize a project.";
	let grant: unknown;
	try {
		grant = JSON.parse(apiKey ?? "");
	} catch {
		// JSON.parse diagnostics can include the credential itself.
		throw new Error(invalidGrant);
	}
	if (
		!grant ||
		typeof grant !== "object" ||
		!("token" in grant) ||
		typeof grant.token !== "string" ||
		!/^[A-Za-z0-9._~+/-]+=*$/.test(grant.token) ||
		!("projectId" in grant) ||
		typeof grant.projectId !== "string" ||
		!grant.projectId.trim()
	) {
		throw new Error(invalidGrant);
	}
	return { token: grant.token, projectId: grant.projectId.trim() };
}

async function* responseChunks(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<GenerateContentResponse> {
	for await (const { event, data } of iterateSseMessages(body, signal)) {
		signal?.throwIfAborted();
		if (event === "error") throw new Error("Cloud Code Assist reported an error while streaming");
		if (!data || event === "ping") continue;
		if (data === "[DONE]") return;
		let frame: unknown;
		try {
			frame = JSON.parse(data);
		} catch {
			throw new Error("Invalid JSON in Cloud Code Assist stream");
		}
		if (frame && typeof frame === "object" && "error" in frame) {
			throw new Error("Cloud Code Assist reported an error while streaming");
		}
		if (
			!frame ||
			typeof frame !== "object" ||
			!("response" in frame) ||
			!frame.response ||
			typeof frame.response !== "object" ||
			Array.isArray(frame.response)
		) {
			throw new Error("Missing response in Cloud Code Assist stream");
		}
		if ("error" in frame.response) throw new Error("Cloud Code Assist reported an error while streaming");
		yield frame.response as GenerateContentResponse;
	}
}

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (model, context, options) =>
	streamGoogleResponse(model, options, async () => {
		const { token, projectId } = parseGrant(options?.apiKey);
		const { contents, systemInstruction, generationConfig, ...toolSettings } = buildGoogleRequest(
			model,
			context,
			options,
			model.id.startsWith("claude-"),
		);
		const payload = {
			project: projectId,
			model: model.id,
			requestType: "agent",
			request: {
				contents,
				...(systemInstruction && { systemInstruction: { parts: [{ text: systemInstruction }] } }),
				...(Object.keys(generationConfig).length > 0 && { generationConfig }),
				...toolSettings,
				...(options?.sessionId && { sessionId: options.sessionId }),
			},
		};
		const nextPayload = await options?.onPayload?.(payload, model);
		options?.signal?.throwIfAborted();
		// The OAuth grant is scoped to this service, never to model.baseUrl or a redirected origin.
		const response = await (options?.fetch ?? globalThis.fetch)(STREAM_URL, {
			method: "POST",
			redirect: "error",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
			body: JSON.stringify(nextPayload === undefined ? payload : nextPayload),
			signal: options?.signal,
		});
		try {
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			if (!response.ok) throw new Error(`Cloud Code Assist request failed (HTTP ${response.status})`);
			if (!response.body) throw new Error("Cloud Code Assist returned no response body");
			return responseChunks(response.body, options?.signal);
		} catch (error) {
			void response.body?.cancel().catch(() => {});
			throw error;
		}
	});

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (model, context, options) =>
	stream(model, context, googleSimpleOptions(model, context, options));
