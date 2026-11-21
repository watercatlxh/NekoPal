import { type GenerateContentParameters, GoogleGenAI, type HttpOptions } from "@google/genai";
import type { FetchFunction, Model, ProviderHeaders, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { buildGoogleRequest, type GoogleOptions, googleSimpleOptions } from "./google-request.ts";
import { retryGoogleRequest } from "./google-shared.ts";
import { streamGoogleResponse } from "./google-stream.ts";

export type { GoogleOptions } from "./google-request.ts";

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (model, context, options) =>
	streamGoogleResponse(model, options, async () => {
		const apiKey = options?.apiKey;
		if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		const client = createClient(model, apiKey, options?.headers, options?.identity, options?.fetch);
		const { contents, generationConfig, systemInstruction, ...toolSettings } = buildGoogleRequest(
			model,
			context,
			options,
		);
		let params: GenerateContentParameters = {
			model: model.id,
			contents,
			config: {
				...generationConfig,
				...(systemInstruction && { systemInstruction }),
				...toolSettings,
				// Don't let the SDK automatically continue a length-limited response.
				automaticContinuation: false,
				...(options?.signal && { abortSignal: options.signal }),
			},
		};
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) params = nextParams as GenerateContentParameters;
		return retryGoogleRequest(() => client.models.generateContentStream(params), options);
	});

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (model, context, options) => {
	if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	return stream(model, context, googleSimpleOptions(model, context, options));
};

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	fetch?: FetchFunction,
): GoogleGenAI {
	// Always pass fetch: without one, @google/genai adds a per-request dispatcher that disables
	// undici's header and body timeouts, bypassing the idle timeouts of the global dispatcher.
	const httpOptions: HttpOptions = { fetch: fetch ?? globalThis.fetch };
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	const headers = providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, optionsHeaders);
	if (headers) {
		httpOptions.headers = headers;
	}

	return new GoogleGenAI({ apiKey, httpOptions });
}
