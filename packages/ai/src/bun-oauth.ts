import { anthropicOAuth } from "./auth/oauth/anthropic.ts";
import { antigravityOAuth } from "./auth/oauth/antigravity.ts";
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";
import { openaiChatGPTOAuth } from "./auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
import { xaiOAuth } from "./auth/oauth/xai.ts";

/** Register OAuth flows statically embedded in the standalone Bun binary. */
export function registerBunOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: () => anthropicOAuth,
		openaiCodex: () => openaiCodexOAuth,
		openaiChatGPT: () => openaiChatGPTOAuth,
		xai: () => xaiOAuth,
		antigravity: () => antigravityOAuth,
	});
}
