import type { Credential } from "../auth/types.ts";
import type { Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { GOOGLE_MODELS } from "./google.models.ts";

const HOST = "https://daily-cloudcode-pa.googleapis.com";
const FRESH_MS = 5 * 60_000;
type GoogleModel = Model<"google-generative-ai">;
const baseline = new Map<string, GoogleModel>(Object.values(GOOGLE_MODELS).map((model) => [model.id, model]));

/** Account membership comes from Cloud Code Assist, never from the metadata catalog. */
export function googleModelDiscovery(): Pick<
	Provider<"google-generative-ai">,
	"getModels" | "getAllModels" | "filterModels" | "refreshModels"
> {
	let roster: GoogleModel[] = [];
	let account: string | undefined;
	let project: string | undefined;
	let checkedAt = 0;
	function sameGrant(credential: Credential | undefined): boolean {
		return (
			credential?.type === "oauth" &&
			(credential.refresh || credential.access) === account &&
			credential.projectId === project
		);
	}
	return {
		getModels: () => roster,
		getAllModels: () => roster,
		filterModels: (models, credential) => (sameGrant(credential) ? models : []),
		async refreshModels(context) {
			const { credential } = context;
			// No credential or account roster is written to the model cache. A switch/logout
			// retires the previous grant's list even during an offline refresh.
			if (!sameGrant(credential)) {
				if (
					!(await context.publish({
						update: () => {
							roster = [];
							account = undefined;
							project = undefined;
							checkedAt = 0;
						},
					}))
				)
					return;
			}
			if (!context.allowNetwork || credential?.type !== "oauth") return;
			if (!context.force && checkedAt && Date.now() - checkedAt < FRESH_MS) return;
			const projectId = credential.projectId;
			if (typeof projectId !== "string" || !projectId.trim())
				throw new Error("Missing Google project; sign in again");
			const signal = AbortSignal.any([context.signal, AbortSignal.timeout(8000)]);
			try {
				const response = await fetch(`${HOST}/v1internal:fetchAvailableModels`, {
					method: "POST",
					redirect: "error",
					signal,
					headers: { Authorization: `Bearer ${credential.access}`, "Content-Type": "application/json" },
					body: JSON.stringify({ project: projectId }),
				});
				if (!response.ok) throw new Error(`Google model discovery failed (${response.status})`);
				const models = parseRoster(await response.json());
				await context.publish({
					update: () => {
						roster = models;
						account = credential.refresh || credential.access;
						project = projectId;
						checkedAt = Date.now();
					},
				});
			} catch {
				context.signal.throwIfAborted();
				await context.publish({
					update: () => {
						roster = [];
						checkedAt = 0;
					},
				});
				throw new Error("Could not load the Google account model list");
			}
		},
	};
}

function parseRoster(body: unknown): GoogleModel[] {
	if (
		typeof body !== "object" ||
		body === null ||
		!("models" in body) ||
		!body.models ||
		typeof body.models !== "object" ||
		Array.isArray(body.models)
	)
		throw new Error("Invalid Google model list");
	const imageOnly = new Set(
		"imageGenerationModelIds" in body && Array.isArray(body.imageGenerationModelIds)
			? body.imageGenerationModelIds
			: [],
	);
	const result: GoogleModel[] = [];
	for (const [id, row] of Object.entries(body.models) as [string, unknown][]) {
		if (!id || imageOnly.has(id) || typeof row !== "object" || row === null || Array.isArray(row)) continue;
		if (("disabled" in row && row.disabled === true) || ("isInternal" in row && row.isInternal === true)) continue;
		const known = baseline.get(id);
		result.push({
			...known,
			api: "google-generative-ai",
			provider: "google",
			baseUrl: HOST,
			id,
			name:
				"displayName" in row && typeof row.displayName === "string" && row.displayName
					? row.displayName
					: (known?.name ?? id),
			reasoning:
				"supportsThinking" in row && typeof row.supportsThinking === "boolean"
					? row.supportsThinking
					: (known?.reasoning ?? false),
			input:
				"supportsImages" in row && typeof row.supportsImages === "boolean"
					? row.supportsImages
						? ["text", "image"]
						: ["text"]
					: (known?.input ?? ["text"]),
			contextWindow: positiveLimit("maxTokens" in row ? row.maxTokens : undefined, known?.contextWindow ?? 128_000),
			maxTokens: positiveLimit("maxOutputTokens" in row ? row.maxOutputTokens : undefined, known?.maxTokens ?? 8192),
			cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	return result.sort((a, b) => a.id.localeCompare(b.id));
}

function positiveLimit(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
