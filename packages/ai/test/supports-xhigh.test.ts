import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

describe("getSupportedThinkingLevels", () => {
	it("includes max but not xhigh for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Anthropic Opus 4.8 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes xhigh and max for Anthropic Opus 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes Claude Opus 5.5 with its always-on effort levels and official pricing", () => {
		const model = getModel("anthropic", "claude-opus-5-5");
		expect(model).toMatchObject({
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: {
				forceAdaptiveThinking: true,
				supportsMidConvoEffort: true,
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("includes Claude Sonnet 5.5 with managed effort levels and official pricing", () => {
		const model = getModel("anthropic", "claude-sonnet-5-5");
		expect(model).toMatchObject({
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			compat: {
				forceAdaptiveThinking: true,
				supportsMidConvoEffort: true,
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
				supportsTemperature: false,
			},
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("includes max but not xhigh for Anthropic Sonnet 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Anthropic Sonnet 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-sonnet-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes xhigh and max but not off for Anthropic Claude Fable 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-fable-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("off");
	});

	it("does not include xhigh or max for Claude Sonnet 4.5", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).not.toContain("max");
	});

	it.each([
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-6-astra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-6.1-sol",
		"gpt-6.1-terra",
		"gpt-6.2-astra",
		"gpt-6.2-sol",
	] as const)("includes xhigh for openai-codex %s models", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra"] as const)(
		"includes xhigh and max for OpenAI %s models",
		(modelId) => {
			const model = getModel("openai", modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		},
	);

	// OpenAI and Codex reject reasoning.effort "none" for GPT-6.1 Sol and GPT-6.2.
	it.each(["gpt-6.1-sol", "gpt-6.2-astra", "gpt-6.2-sol"] as const)("does not support off for %s", (modelId) => {
		const expected = {
			openai: ["low", "medium", "high", "xhigh", "max"],
			"openai-codex": ["minimal", "low", "medium", "high", "xhigh", "max"],
		} as const;
		for (const [provider, levels] of Object.entries(expected)) {
			const model = getModel(provider as keyof typeof expected, modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(levels);
			expect(model!.thinkingLevelMap?.off).toBeNull();
		}
	});

	// GPT-6.1 Terra accepts reasoning.effort "none" but, like GPT-6.1 Sol, rejects "minimal".
	it("supports off but not minimal for GPT-6.1 Terra", () => {
		for (const provider of ["openai", "openai-codex"] as const) {
			const model = getModel(provider, "gpt-6.1-terra");
			expect(model).toBeDefined();
			expect(model!.thinkingLevelMap?.off).toBe("none");
			expect(model!.thinkingLevelMap?.minimal).toBe(provider === "openai-codex" ? "low" : null);
		}
	});

	it.each([
		["gpt-6-sol", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, 272000],
		["gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, 272000],
		// Codex serves GPT-6.1 Sol with a 500K default context window (#10840)
		["gpt-6.1-sol", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, 500000],
		["gpt-6.1-terra", { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 }, 500000],
		["gpt-6.2-astra", { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 }, 272000],
		["gpt-6.2-sol", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, 500000],
	] as const)("includes official metadata for OpenAI and Codex %s", (modelId, cost, codexContextWindow) => {
		for (const provider of ["openai", "openai-codex"] as const) {
			const model = getModel(provider, modelId);
			expect(model).toMatchObject({
				input: ["text", "image"],
				cost: {
					...cost,
					tiers: [
						{
							inputTokensAbove: 272000,
							input: cost.input * 2,
							output: cost.output * 1.5,
							cacheRead: cost.cacheRead * 2,
							cacheWrite: cost.cacheWrite * 2,
						},
					],
				},
				contextWindow: provider === "openai-codex" ? codexContextWindow : 272000,
				maxTokens: 128000,
				compat: {
					supportsAdditionalTools: true,
					supportsMidConvoSystemMessages: true,
					supportsOpenAIGrammarTools: true,
					supportsToolSearch: true,
				},
			});
		}
	});

	it("includes only medium/high/xhigh for OpenAI GPT-5.5 Pro", () => {
		const model = getModel("openai", "gpt-5.5-pro");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["medium", "high", "xhigh"]);
	});

	it("includes xhigh but not off or max for xAI Grok 4.6", () => {
		const model = getModel("xai", "grok-4.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high", "xhigh"]);
	});
});
