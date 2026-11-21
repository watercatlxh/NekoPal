/**
 * Model discovery for a custom provider: `GET {baseUrl}/models`, the listing every OpenAI-compatible
 * endpoint serves.
 *
 * A provider that answers it gets its model list filled in automatically; one that does not still
 * gets written, with an empty list, so the user can add models by hand.
 */

import { resolveConfigValue } from "@earendil-works/pi-coding-agent";

/** What a discovery attempt produced. */
export interface Discovery {
	readonly models: readonly string[];
	/** Why the list is empty, when it is. */
	readonly error?: string;
}

const DISCOVERY_TIMEOUT_MS = 15_000;

/** The ids in a `/models` body, in the three shapes these endpoints use. */
function idsFrom(body: unknown): string[] {
	if (Array.isArray(body)) return idsFromItems(body);
	if (typeof body !== "object" || body === null) return [];
	const record = body as { data?: unknown; models?: unknown };
	if (Array.isArray(record.data)) return idsFromItems(record.data);
	if (Array.isArray(record.models)) return idsFromItems(record.models);
	return [];
}

/** Ids of `[{ id }]`, tolerating bare strings. */
function idsFromItems(items: readonly unknown[]): string[] {
	const ids: string[] = [];
	for (const item of items) {
		if (typeof item === "string" && item !== "") ids.push(item);
		else if (typeof item === "object" && item !== null) {
			const id = (item as { id?: unknown }).id;
			if (typeof id === "string" && id !== "") ids.push(id);
		}
	}
	return ids;
}

/** Trim a base URL so `+ "/models"` cannot double the slash. */
function trimBase(baseUrl: string): string {
	return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * Ask a provider for its model list.
 *
 * `apiKey` may be a `$ENV` reference or a `!command`, the same forms `models.json` accepts; it is
 * resolved here so the probe authenticates exactly as the provider will at request time.
 */
export async function discoverModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<Discovery> {
	const key = resolveConfigValue(apiKey);
	if (key === undefined || key === "") return { models: [], error: "api key did not resolve" };
	const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetch(`${trimBase(baseUrl)}/models`, {
			headers: { authorization: `Bearer ${key}`, accept: "application/json" },
			signal: combined,
		});
	} catch (error) {
		return { models: [], error: error instanceof Error ? error.message : String(error) };
	}
	if (!response.ok) return { models: [], error: `HTTP ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { models: [], error: "response was not JSON" };
	}
	const models = idsFrom(body);
	if (models.length === 0) return { models: [], error: "no models in the response" };
	return { models };
}
