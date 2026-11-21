/**
 * The `models.json` file: where a provider that is not in the built-in catalog is declared.
 *
 * The file is the persisted half of a custom provider; the runtime half is `ModelRuntime.refresh()`,
 * which reloads this file and recomposes every provider. Writes are atomic and keep one backup, so a
 * half-written file can never replace a working one.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
	[key: string]: unknown;
	providers: Record<string, unknown>;
}

/** Defaults for a discovered model, before anyone tunes them. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/** `models.json` under the data directory. */
export function modelsJsonPath(agentDir: string): string {
	return join(agentDir, "models.json");
}

/** Only a missing file is an empty catalog; refuse to replace any unreadable existing data. */
function readFile(path: string): { file: ModelsFile; exists: boolean } {
	try {
		lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { file: { providers: Object.create(null) }, exists: false };
		throw new Error("Could not read models.json");
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
		const providers: unknown = "providers" in parsed && Object.hasOwn(parsed, "providers") ? parsed.providers : {};
		if (typeof providers !== "object" || providers === null || Array.isArray(providers)) throw new Error();
		return { file: { ...parsed, providers: Object.assign(Object.create(null), providers) }, exists: true };
	} catch {
		throw new Error("Could not read models.json");
	}
}

/** The providers already declared, by id. */
export function listCustomProviders(agentDir: string): string[] {
	return Object.keys(readFile(modelsJsonPath(agentDir)).file.providers);
}

/** Whether a provider id is already taken, by the file or by the built-in catalog. */
export function providerTaken(agentDir: string, id: string, builtins: readonly string[]): boolean {
	return builtins.includes(id) || Object.hasOwn(readFile(modelsJsonPath(agentDir)).file.providers, id);
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

/** Add a provider without replacing any existing id, using one synchronous read-modify-write. */
export function upsertProvider(agentDir: string, provider: CustomProvider, reserved: readonly string[] = []): void {
	const path = modelsJsonPath(agentDir);
	const { file, exists } = readFile(path);
	if (reserved.includes(provider.name) || Object.hasOwn(file.providers, provider.name))
		throw new Error("Provider exists");
	file.providers[provider.name] = entry(provider);
	writeAtomic(path, file, exists);
}

/** Remove a provider; false when it was not declared. */
export function removeProvider(agentDir: string, id: string): boolean {
	const path = modelsJsonPath(agentDir);
	const { file, exists } = readFile(path);
	if (!Object.hasOwn(file.providers, id)) return false;
	delete file.providers[id];
	writeAtomic(path, file, exists);
	return true;
}

function writeAtomic(path: string, file: ModelsFile, exists: boolean): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
		if (exists) {
			const backup = `${temp}.bak`;
			try {
				copyFileSync(path, backup);
				chmodSync(backup, 0o600);
				renameSync(backup, `${path}.bak`);
			} finally {
				rmSync(backup, { force: true });
			}
		}
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
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
