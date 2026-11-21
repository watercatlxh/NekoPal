import type { OAuthAuth } from "../types.ts";

/**
 * Loads an OAuth flow module through a variable specifier so bundlers cannot
 * follow the import into Node-only flow code (`node:http` callback servers,
 * `node:crypto` PKCE). The `.ts`/`.js` rewrite keeps the trick working from
 * both source and built output. The specifier is resolved against this
 * module's URL, not left relative: a bundler inlining this file (Chord's
 * worker base) keeps the variable import, which would otherwise resolve
 * against the bundle's location.
 */
const importOAuthModule = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(new URL(runtimeSpecifier, import.meta.url).href);
};

type OAuthFlowLoaders = {
	anthropic: () => OAuthAuth | Promise<OAuthAuth>;
	openaiCodex: () => OAuthAuth | Promise<OAuthAuth>;
	openaiChatGPT: () => OAuthAuth | Promise<OAuthAuth>;
	xai: () => OAuthAuth | Promise<OAuthAuth>;
	antigravity: () => OAuthAuth | Promise<OAuthAuth>;
};

let bundledLoaders: OAuthFlowLoaders | undefined;

/** Registers statically bundled OAuth flows for standalone Bun binaries. */
export function registerBundledOAuthFlowLoaders(loaders: OAuthFlowLoaders): void {
	bundledLoaders = loaders;
}

export const loadAnthropicOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.anthropic();
	return ((await importOAuthModule("./anthropic.ts")) as { anthropicOAuth: OAuthAuth }).anthropicOAuth;
};

export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.openaiCodex();
	return ((await importOAuthModule("./openai-codex.ts")) as { openaiCodexOAuth: OAuthAuth }).openaiCodexOAuth;
};

export const loadOpenAIChatGPTOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.openaiChatGPT();
	return ((await importOAuthModule("./openai-chatgpt.ts")) as { openaiChatGPTOAuth: OAuthAuth }).openaiChatGPTOAuth;
};

export const loadXaiOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.xai();
	return ((await importOAuthModule("./xai.ts")) as { xaiOAuth: OAuthAuth }).xaiOAuth;
};

export const loadAntigravityOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.antigravity();
	return ((await importOAuthModule("./antigravity.ts")) as { antigravityOAuth: OAuthAuth }).antigravityOAuth;
};
