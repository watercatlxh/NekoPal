import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";

/**
 * Registers OAuth flow loaders with literal dynamic imports, for Node bundles
 * that split at dynamic imports (esbuild `splitting`, Chord's worker base):
 * each flow lands in a chunk loaded on its first use, inside the bundle.
 * Without it, pi-ai imports the flows through a variable specifier that
 * bundlers cannot follow, so a bundle loads them from pi-ai's own files.
 * Browser bundles must not import this module (the flows are Node-only).
 */
export function registerLazyOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: async () => (await import("./auth/oauth/anthropic.ts")).anthropicOAuth,
		openaiCodex: async () => (await import("./auth/oauth/openai-codex.ts")).openaiCodexOAuth,
		openaiChatGPT: async () => (await import("./auth/oauth/openai-chatgpt.ts")).openaiChatGPTOAuth,
		xai: async () => (await import("./auth/oauth/xai.ts")).xaiOAuth,
		antigravity: async () => (await import("./auth/oauth/antigravity.ts")).antigravityOAuth,
	});
}
