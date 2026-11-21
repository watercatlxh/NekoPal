import { defineProvider, mergeThinking, modelsDevModels } from "../define.ts";
import { googleThinkingLevels } from "../families/google.ts";

// Image-only and TTS SKUs 404 on generateContent; the chat API takes images itself.
const EXCLUDED_MODEL_IDS = new Set([
	"gemini-2.5-flash-image",
	"gemini-2.5-flash-image-preview",
	"gemini-3-pro-image",
	"gemini-3.1-flash-image",
]);

export default defineProvider({
	id: "google",
	models: (ctx) =>
		modelsDevModels(ctx, "google", {
			api: "google-generative-ai",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			include: (source) => !EXCLUDED_MODEL_IDS.has(source.id),
			map: (model, source) => {
				const levels = googleThinkingLevels(model.id, source.reasoningOptions ?? []);
				if (levels !== undefined) mergeThinking(model, levels);
				return model;
			},
		}),
});
