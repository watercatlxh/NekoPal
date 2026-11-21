import type { ThinkingConfig } from "@google/genai";
import { clampThinkingLevel } from "../models.ts";
import type { Model, SimpleStreamOptions, StreamOptions, ThinkingBudgets, TranscriptContext } from "../types.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import {
	convertMessages,
	convertTools,
	type GoogleApiThinkingLevel,
	getDisabledGoogleThinkingConfig,
	type ResolvedGoogleThinkingLevel,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleApiThinkingLevel;
	};
}

export function googleSimpleOptions(
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): GoogleOptions {
	const base = { ...buildBaseOptions(model, context, options), toolChoice: options?.toolChoice };
	const level = clampThinkingLevel(model, options?.reasoning ?? "off");
	if (!options?.reasoning || level === "off") return { ...base, thinking: { enabled: false } };
	const resolved = resolveGoogleThinkingLevel(model, level);
	return {
		...base,
		thinking: usesGoogleThinkingLevel(model)
			? { enabled: true, level: toGoogleThinkingLevel(resolved) }
			: { enabled: true, budgetTokens: getGoogleBudget(model, resolved, options.thinkingBudgets) },
	};
}

export function buildGoogleRequest(
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options: GoogleOptions = {},
	useLegacyToolParameters = false,
) {
	options.signal?.throwIfAborted();
	const normalized = collapseSystemMessages(context);
	const contents = convertMessages(model, normalized);
	const initialSystemMessage = getInitialSystemMessage(normalized.messages);
	const currentTools = getCurrentTools(normalized.messages);
	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	const functionCallingMode =
		currentTools.length > 0
			? resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode)
			: undefined;
	const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	let thinkingConfig: ThinkingConfig | undefined;
	if (options.thinking?.enabled && model.reasoning) {
		thinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}
	return {
		contents,
		systemInstruction: sanitizeSurrogates(systemInstruction),
		generationConfig: {
			...(options.temperature !== undefined && { temperature: options.temperature }),
			...(options.maxTokens !== undefined && { maxOutputTokens: options.maxTokens }),
			...(thinkingConfig && { thinkingConfig }),
		},
		...(currentTools.length > 0 && {
			tools: convertTools(currentTools, useLegacyToolParameters, supportsStrictMode),
		}),
		...(functionCallingMode !== undefined && {
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[level] !== undefined) {
		return customBudgets[level]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash-lite")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	return -1;
}
