// Every built-in provider catalog. Add new providers here.

import type { ProviderDefinition } from "../define.ts";
import anthropic from "./anthropic.ts";
import google from "./google.ts";
import openai from "./openai.ts";
import openaiCodex from "./openai-codex.ts";
import xai from "./xai.ts";

export const PROVIDERS: readonly ProviderDefinition[] = [anthropic, openaiCodex, openai, google, xai];
