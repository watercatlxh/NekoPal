import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAntigravityOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_MODELS } from "./google.models.ts";

/**
 * Google Antigravity: Gemini, Claude and GPT-OSS through Cloud Code Assist, on the Antigravity
 * OAuth grant. Requests reuse the Generative Language wire against the Antigravity endpoint.
 */
export function googleProvider(): Provider<"google-generative-ai"> {
	return createProvider({
		id: "google",
		name: "Google Antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		auth: {
			// Ambient keys keep the provider usable without a login, as resolve() still
			// reports them; the panel only ever offers the OAuth login.
			apiKey: envApiKeyAuth("Google API key", ["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
			oauth: lazyOAuth({
				name: "Google Antigravity (Gemini, Claude, GPT-OSS)",
				isSubscription: true,
				loginLabel: "Sign in with Google (Antigravity)",
				load: loadAntigravityOAuth,
			}),
		},
		models: Object.values(GOOGLE_MODELS),
		api: googleGenerativeAIApi(),
	});
}
