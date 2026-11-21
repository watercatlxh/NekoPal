/**
 * The `models.json` file: where a provider that is not in the built-in catalog is declared.
 *
 * The file is the persisted half of a custom provider; the runtime half is `ModelRuntime.refresh()`,
 * which reloads this file and recomposes every provider. Writes are atomic and keep one backup, so a
 * half-written file can never replace a working one.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The API shapes a custom provider can speak. */
export const API_KINDS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

export type ApiKind = (typeof API_KINDS)[number];

/** One model inside a custom provider, as `models.json` declares it. */
export interface CustomModel {
	readonly id: string;
	readonly name: string;
	readonly reasoning: boolean;
	readonly input: readonly ("text" | "image")[];
	readonly contextWindow: number;
	readonly maxTokens: number;
}

/** One custom provider, as `models.json` declares it. */
export interface CustomProvider {
	readonly name: string;
	readonly baseUrl: string;
	readonly api: ApiKind;
	/** A literal key, `$ENV` interpolation, or `!command` output. */
	readonly apiKey: string;
	readonly models: readonly CustomModel[];
}

/** What `models.json` holds, as far as this module cares. */
interface ModelsFile {
	providers: Record<string, unknown>;
}

/** Defaults for a discovered model, before anyone tunes them. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/** `models.json` under the data directory. */
export function modelsJsonPath(agentDir: string): string {
	return join(agentDir, "models.json");
}

/** The file as an object; an empty skeleton when it does not exist or is unreadable. */
function readFile(path: string): ModelsFile {
	if (!existsSync(path)) return { providers: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return { providers: {} };
		const providers = (parsed as { providers?: unknown }).providers;
		if (typeof providers !== "object" || providers === null) return { providers: {} };
		return { providers: providers as Record<string, unknown> };
	} catch {
		return { providers: {} };
	}
}

/** The providers already declared, by id. */
export function listCustomProviders(agentDir: string): string[] {
	return Object.keys(readFile(modelsJsonPath(agentDir)).providers);
}

/** Whether a provider id is already taken, by the file or by the built-in catalog. */
export function providerTaken(agentDir: string, id: string, builtins: readonly string[]): boolean {
	return builtins.includes(id) || id in readFile(modelsJsonPath(agentDir)).providers;
}

/** The entry `models.json` gets for a provider. */
function entry(provider: CustomProvider): Record<string, unknown> {
	const models = provider.models.map((model) => ({
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	}));
	return {
		name: provider.name,
		baseUrl: provider.baseUrl,
		api: provider.api,
		apiKey: provider.apiKey,
		authHeader: true,
		...(provider.api === "openai-responses"
			? { compat: { supportsStore: true, supportsReasoningEffort: true } }
			: {}),
		models,
	};
}

/**
 * Add or replace a provider, atomically.
 *
 * The old file is copied to `models.json.bak` first and the new one is written beside it and
 * renamed into place, so a crash mid-write leaves the previous file intact.
 */
export function upsertProvider(agentDir: string, provider: CustomProvider): void {
	const path = modelsJsonPath(agentDir);
	const file = readFile(path);
	file.providers[provider.name] = entry(provider);
	writeAtomic(path, file);
}

/** Remove a provider; false when it was not declared. */
export function removeProvider(agentDir: string, id: string): boolean {
	const path = modelsJsonPath(agentDir);
	const file = readFile(path);
	if (!(id in file.providers)) return false;
	delete file.providers[id];
	writeAtomic(path, file);
	return true;
}

function writeAtomic(path: string, file: ModelsFile): void {
	if (existsSync(path)) copyFileSync(path, `${path}.bak`);
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ providers: file.providers }, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

/** A discovered model id as a `models.json` model, with conservative defaults. */
export function modelFromId(id: string): CustomModel {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}
