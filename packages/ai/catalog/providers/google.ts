import { type ChatModel, defineProvider } from "../define.ts";

// Cloud Code Assist protocol baseline; an individual account may have access to fewer models.
const opus = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const sonnet = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const pro = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.375 };
const baseline: readonly [string, string, boolean, boolean, number, number, ChatModel["cost"]][] = [
	["claude-opus-4-5-thinking", "Claude Opus 4.5 Thinking", true, true, 200000, 64000, opus],
	["claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking", true, true, 200000, 128000, opus],
	["claude-sonnet-4-5", "Claude Sonnet 4.5", false, true, 200000, 64000, sonnet],
	["claude-sonnet-4-5-thinking", "Claude Sonnet 4.5 Thinking", true, true, 200000, 64000, sonnet],
	["claude-sonnet-4-6", "Claude Sonnet 4.6", true, true, 200000, 64000, sonnet],
	[
		"gemini-3-flash",
		"Gemini 3 Flash",
		true,
		true,
		1048576,
		65535,
		{ input: 0.5, output: 3, cacheRead: 0.5, cacheWrite: 0 },
	],
	["gemini-3.1-pro-high", "Gemini 3.1 Pro High", true, true, 1048576, 65535, pro],
	["gemini-3.1-pro-low", "Gemini 3.1 Pro Low", true, true, 1048576, 65535, pro],
	[
		"gpt-oss-120b-medium",
		"GPT-OSS 120B Medium",
		false,
		false,
		131072,
		32768,
		{ input: 0.09, output: 0.36, cacheRead: 0, cacheWrite: 0 },
	],
];

export default defineProvider({
	id: "google",
	models: () =>
		baseline.map(([id, name, reasoning, images, contextWindow, maxTokens, cost]) => ({
			id,
			name: `${name} (Antigravity)`,
			provider: "google",
			api: "google-generative-ai",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
			reasoning,
			input: images ? ["text", "image"] : ["text"],
			contextWindow,
			maxTokens,
			cost,
		})),
});
