import { googleAntigravityApi } from "../api/google-antigravity.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadAntigravityOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_MODELS } from "./google.models.ts";
import { googleModelDiscovery } from "./google-model-discovery.ts";

/** Google Antigravity uses an OAuth project grant with Cloud Code Assist. */
export function googleProvider(): Provider<"google-generative-ai"> {
	const provider = createProvider<"google-generative-ai">({
		id: "google",
		name: "Google Antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		auth: {
			oauth: lazyOAuth({
				name: "Google Antigravity (Gemini, Claude, GPT-OSS)",
				isSubscription: true,
				loginLabel: "Sign in with Google (Antigravity)",
				load: loadAntigravityOAuth,
			}),
		},
		models: Object.values(GOOGLE_MODELS),
		api: googleAntigravityApi(),
	});
	return { ...provider, ...googleModelDiscovery() };
}
