# @earendil-works/pi-ai

Unified LLM API with provider collections, automatic auth resolution, token and cost tracking, and simple context persistence and hand-off to other models mid-session.

**Note**: The chat catalog only includes models that support tool calling (function calling), as this is essential for agentic workflows. Image and classifier catalogs use their operation-specific capabilities.

## Table of Contents

- [Supported Providers](#supported-providers)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Providers and Models](#providers-and-models)
  - [Provider Factories](#provider-factories)
  - [All Built-in Providers](#all-built-in-providers)
  - [Querying Models](#querying-models)
  - [Static Catalog Reads](#static-catalog-reads)
  - [Dynamic Providers](#dynamic-providers)
- [Auth](#auth)
  - [How Auth Resolves](#how-auth-resolves)
  - [Transforming Request Headers](#transforming-request-headers)
  - [Client Identity](#client-identity)
  - [Credential Store](#credential-store)
  - [Environment Variables](#environment-variables)
- [Tools](#tools)
  - [Defining Tools](#defining-tools)
  - [Constrained Sampling for Tools](#constrained-sampling-for-tools)
  - [Handling Tool Calls](#handling-tool-calls)
  - [Streaming Tool Calls with Partial JSON](#streaming-tool-calls-with-partial-json)
  - [Validating Tool Arguments](#validating-tool-arguments)
  - [Complete Event Reference](#complete-event-reference)
- [Image Input](#image-input)
- [Image Generation](#image-generation)
- [Classification](#classification)
  - [OpenAI Decisions](#openai-decisions)
  - [Custom classifiers](#custom-classifiers)
- [Thinking/Reasoning](#thinkingreasoning)
  - [Unified Interface](#unified-interface-streamsimplecompletesimple)
  - [Provider-Specific Options](#provider-specific-options-streamcomplete)
  - [Streaming Thinking Content](#streaming-thinking-content)
- [Stop Reasons](#stop-reasons)
- [Telemetry](#telemetry)
- [Error Handling](#error-handling)
  - [Aborting Requests](#aborting-requests)
  - [Continuing After Abort](#continuing-after-abort)
  - [Debugging Provider Payloads](#debugging-provider-payloads)
  - [Observing Provider Stream Events](#observing-provider-stream-events)
- [Custom Providers](#custom-providers)
  - [createProvider()](#createprovider)
  - [models.json endpoints](#modelsjson-endpoints)
  - [Calling API Implementations Directly](#calling-api-implementations-directly)
  - [OpenAI Compatibility Settings](#openai-compatibility-settings)
- [Faux Provider for Tests](#faux-provider-for-tests)
- [Cross-Provider Handoffs](#cross-provider-handoffs)
- [System Messages](#system-messages)
- [Context Serialization](#context-serialization)
- [Browser Usage](#browser-usage)
- [Bundling and Tree Shaking](#bundling-and-tree-shaking)
- [OAuth Providers](#oauth-providers)
  - [Programmatic OAuth](#programmatic-oauth)
- [Migrating from the Old Global API](#migrating-from-the-old-global-api)
- [Development](#development)
- [License](#license)

## Supported Providers

NekoPal keeps four OAuth providers and the faux provider its tests use:

- **Anthropic**
- **OpenAI** (including the Decisions classifier API)
- **OpenAI Codex** (ChatGPT Plus/Pro subscription, requires OAuth, see below)
- **xAI**
- **faux** (tests only)

**Any OpenAI-compatible API** still works through `models.json`: register a provider with
`api: "openai-completions"`, `"openai-responses"`, `"anthropic-messages"` or
`"google-generative-ai"` and a `baseUrl`, and point it at Ollama, vLLM, LM Studio or a private
gateway. The protocol implementations are kept; only the built-in catalogs for the other providers
are gone.

## Installation

```bash
npm install @earendil-works/pi-ai
```

Tool parameters are JSON Schema. The examples build them with `@earendil-works/pi-schema`, which also types the arguments (`npm install @earendil-works/pi-schema`); TypeBox schemas and plain JSON Schema objects work as well.

## Quick Start

You build a `Models` collection of providers and stream through it. The quickest start registers every built-in provider; apps that care about bundle size register individual providers instead (see [Provider Factories](#provider-factories) and [Bundling and Tree Shaking](#bundling-and-tree-shaking)).

```typescript
import { type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { obj, opt, str } from '@earendil-works/pi-schema';

// A Models collection with every built-in provider registered
const models = builtinModels();

// Sync lookup against the collection
const model = models.getModel('openai', 'gpt-4o-mini')!;

// Define tools with JSON Schema; pi-schema's builders also type the arguments
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: obj({
    timezone: opt(str({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// Build a conversation context (easily serializable and transferable between models)
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

// Option 1: Streaming with all event types.
// Auth resolves through the provider (OPENAI_API_KEY from the environment here).
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // Partial tool arguments are being streamed
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

// Get the final message after streaming, add it to the context
const finalMessage = await s.result();
context.messages.push(finalMessage);

// Handle tool calls if any
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // Add tool result to context (supports text and images)
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// Continue if there were tool calls
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// Option 2: Get complete response without streaming
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

`usage.cost.totalFromProvider` is `true` when `usage.cost.total` is the billed cost reported by the provider and `false` when it is estimated from the model's catalog rates. A missing value, as in sessions recorded before this field existed, also means `false`.

Snippets in the rest of this README assume a `models` collection set up like this (with the relevant providers registered).

`usage.cost.total` is the best available total cost. When an adapter reports a billed cost for a request, `total` is that value and `totalFromProvider` is `true`; otherwise it is estimated from the model's catalog rates. The `input`, `output`, `cacheRead`, and `cacheWrite` cost components remain catalog estimates and may not sum to a provider-reported total.

## Providers and Models

A **provider** is the runtime unit: it owns its model catalog, its auth (API key resolution, OAuth flows), and its stream behavior. A `Models` collection holds providers and routes every request to the provider that owns the model.

Providers internally share **API implementations** (the wire protocols): Anthropic models use `anthropic-messages`, OpenAI and xAI use `openai-responses`, and OpenAI Codex uses `openai-codex-responses`. `openai-completions` and `google-generative-ai` stay registered for `models.json` endpoints, which dispatch per model. OpenAI's Decisions classifier runs on `openai-decisions`.

### Provider Factories

For apps that only need specific providers, there is one factory per built-in provider, each a subpath import that pulls only that provider's catalog:

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
```

Provider factories import their model catalog and a lazy API wrapper. They do not import other providers. With bundler code splitting, SDK implementations (`@anthropic-ai/sdk`, `openai`, `@google/genai`) stay in lazy chunks loaded on the first request to a model of that API.

### All Built-in Providers

For apps that want everything (as in Quick Start):

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // a Models collection with every built-in provider registered
```

This imports all catalogs and every built-in provider factory. It is the heavy, explicit entrypoint. `builtinModels()` accepts the same options as `createModels()` (`credentials`, `authContext`); `builtinProviders()` returns the provider array if you want to register them on your own collection.

### Querying Models

Reads are synchronous and return the last-known lists:

```typescript
const providers = models.getProviders();           // registered Provider objects
const provider = models.getProvider('anthropic');  // one provider

const all = models.getModels();                    // every chat model across providers
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

The unqualified reads `getModels()`/`getModel()`/`getAvailable()` return chat models (`Model<Api>`) usable with `stream()`. The `*OfType` reads return one model type, and `getAllModels()`/`getAllAvailable()` return every type as `AnyModel`:

```typescript
const jev = models.getModelOfType('classifier', 'openai', 'gpt-6-luna'); // ClassifierModel<'openai-decisions'>
const availableClassifiers = await models.getAvailableOfType('classifier');
const everything = models.getAllModels();                               // AnyModel[]
```

The model's `type` decides which operation accepts it: chat models stream, `type: "image"` models generate images, and `type: "classifier"` models classify structured state. `type` is optional on chat models, so a model without `type` is a chat model. Do not compare `type` directly; narrow mixed lists with `isModelType()` or read the effective type with `getModelType()`:

```typescript
import { isModelType } from '@earendil-works/pi-ai';

for (const model of models.getAllModels()) {
  if (isModelType(model, 'classifier')) {
    // model: ClassifierModel<ClassifierApi>
  }
}
```

IDs are unique within each provider and type; one upstream model may have separate entries for different operations. On a provider, `getModels()` returns chat models and the optional `getAllModels()` returns every type; providers with only chat models can omit it.

Dynamically listed chat models are typed `Model<Api>`. Narrow with the `hasApi()` guard when you need API-specific option typing:

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> — stream options fully typed
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### Static Catalog Reads

For tooling that wants the generated built-in catalog with full literal typing (provider and model IDs auto-complete), independent of any collection:

```typescript
import {
  getAllBuiltinModels,
  getBuiltinClassifierModel,
  getBuiltinClassifierModels,
  getBuiltinImageModel,
  getBuiltinImageModels,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // typed Model<'openai-responses'>
const jev = getBuiltinClassifierModel('openai', 'gpt-6-luna'); // ClassifierModel<'openai-decisions'>
const providers = getBuiltinProviders();                // ["anthropic", "openai", "openai-codex", "xai"]
const anthropicChat = getBuiltinModels('anthropic');    // Model[]
const xaiClassifiers = getBuiltinClassifierModels('xai'); // ClassifierModel[]
const openaiAll = getAllBuiltinModels('openai');        // AnyModel[]
```

`getBuiltinImageModel`, `getBuiltinImageModels`, and `getBuiltinClassifierModels` still exist, but no built-in provider currently ships image or classifier models apart from OpenAI's `gpt-6-luna`.

### Dynamic Providers

Providers may have dynamic model lists (a llama.cpp server, a proxied catalog). Reads stay sync; fetching is an explicit async verb:

```typescript
// getModels() returns the last-known list (empty before the first refresh)
await models.refresh({ providers: ['llamacpp'] }); // refresh one provider
await models.refresh();                            // refresh all providers concurrently, best-effort
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

All four built-in providers are static and are no-ops for `refresh()`; unknown or unconfigured providers are skipped. See [createProvider()](#createprovider) for building a dynamic provider with `fetchModels`.

## Auth

Every provider owns its auth: how API keys resolve (stored credentials, environment variables, ambient sources like AWS profiles or gcloud ADC) and, where supported, OAuth login/refresh flows.

### How Auth Resolves

When you call `models.stream()`, the collection resolves auth through the owning provider and merges it into the request. Explicit per-request values always win:

```typescript
// Resolved through the provider (env var, stored credential, OAuth token):
await models.complete(model, context);

// Explicit key wins over anything the provider would resolve:
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

You can inspect resolution without making a request. Pass a provider ID for provider-scoped auth, or a model to include its static `model.headers`:

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`configured via ${modelAuth.source}`); // e.g. "ANTHROPIC_API_KEY", "OAuth", "stored credential"
  console.log(modelAuth.auth.headers);              // Provider auth headers + model.headers
} else {
  console.log('not configured');
}
```

Both overloads resolve credentials, refresh expired OAuth when necessary, and may return an auth-derived `apiKey`, `headers`, or `baseUrl`. `getAuth()` resolves `undefined` for unconfigured providers and rejects with `ModelsError` when something is actually broken (`"oauth"`: token refresh failed, credential preserved for re-login; `"auth"`: key resolution or credential store failure). Request paths surface the same failures as stream errors.

`getAuth()`, `checkAuth()`, `getAvailable()`, login, and logout accept optional caller cancellation through their existing options or interaction objects and remain unbounded when no signal is supplied. Provider `login`, `ApiKeyAuth.check`, `ApiKeyAuth.resolve`, and `OAuthAuth.refresh` implementations always receive a concrete signal and must honor it for blocking work.

### Transforming Request Headers

`Models.stream()`, `complete()`, `streamSimple()`, and `completeSimple()` accept a Models-only `transformHeaders` option. It runs once after provider auth, `model.headers`, and explicit `options.headers` have been merged, but before provider dispatch:

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

The ordering is:

```text
provider auth headers -> model.headers -> explicit options.headers -> transformHeaders -> Provider.stream*()
```

Header names are merged case-insensitively. Explicit headers override auth/model headers, and the transform has final control; returning `null` for a header suppresses lower-level defaults that support deletion.

`transformHeaders` belongs to `Models`, not `Provider`. A `Models` implementation must consume it and remove it before calling `Provider.stream*()`. Provider implementations continue receiving ordinary `ApiStreamOptions` or `SimpleStreamOptions` and never handle the transform themselves. Use this option instead of calling `getAuth(model)` before `stream*()`, which would resolve request auth twice.

### Client Identity

`identity` controls how requests identify the calling app to providers. Set it on `createModels()` as a default, or per request; a request's fields override the `Models` default field by field:

```typescript
const models = createModels({
  identity: {
    userAgent: 'detailed',
    version: '2.1.0',
  },
});

await models.completeSimple(model, context, { identity: { userAgent: 'short' } });
```

- `userAgent`: `"detailed"` (default) sends `nekopal/<version> (<platform>; <runtime>/<runtime version>; <arch>)`, or `nekopal/<version> (browser)` outside Node.js and Bun; `"short"` sends `nekopal`; and `{ custom: "..." }` sends the given value.
- `version`: the version in the detailed `User-Agent`. Default: the pi-ai version.

`ClientIdentity` carries no attribution fields. Identity headers are defaults below provider, model, and request headers, so configured headers win and a `null` request header removes one. Providers that send a fixed client identity, such as Anthropic OAuth, keep it. `withClientIdentity(models, identity)` returns a wrapper of a `Models` (or `MutableModels`) whose requests use `identity` over the one the `Models` was created with, for libraries that receive a `Models` from their host. `identity` is plain JSON, so it can be persisted with other request options.

### Credential Store

Stored credentials (API keys entered interactively, OAuth tokens) live in a `CredentialStore` — one type-tagged credential per provider. pi-ai ships an in-memory default; apps inject persistent storage:

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() takes the same options:
// const models = builtinModels({ credentials: myFileBackedStore });
```

The contract is small: `read(providerId)`, `list()` for non-secret `{ providerId, type }` metadata, `modify(providerId, fn)` (the only write path — a serialized read-modify-write), and `delete(providerId)`. Each operation accepts optional cancellation options. Enumeration must not resolve secrets or execute configured key commands. OAuth token refresh runs inside `modify`, so concurrent requests and processes cannot double-refresh a rotated token. A stored credential *owns* its provider: environment variables are only consulted when nothing is stored, and a failed refresh never silently falls back to an env key.

API-key credentials use the same discriminator as pi's `auth.json` and can carry provider-scoped env/config values:

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    PI_CACHE_RETENTION: 'long'
  }
} as const;
```

Values in a credential's `env` reach the API adapter as provider configuration, and explicit per-request `env` overrides them.

### Environment Variables

Built-in providers resolve these env vars (Node.js; in browsers pass `apiKey` explicitly):

| Provider | Environment Variable(s) |
|----------|------------------------|
| OpenAI | `OPENAI_API_KEY` |
| OpenAI Codex | OAuth only (`/login openai-codex`) |
| Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
| xAI | `XAI_API_KEY` |

Custom `models.json` providers take their key from the provider entry itself, so any other
`*_API_KEY` name you already export can be referenced there.

Stored credentials remain provider-scoped, so save the key under the provider ID you register.

## Tools

Tools enable LLMs to interact with external systems. A tool's `parameters` is a JSON Schema object: built with `@earendil-works/pi-schema`'s builders (which also type the arguments through its `Static`), with TypeBox, or written by hand. `validateToolCall()` and `validateToolArguments()` validate with pi-schema, coercing loosely typed arguments first (numeric strings, `"true"`, a single value for an array, `null` for an omitted optional property). Schemas are plain JSON, so they serialize with the rest of a context.

### Defining Tools

```typescript
import { type Tool, StringEnum } from '@earendil-works/pi-ai';
import { arr, obj, str } from '@earendil-works/pi-schema';

// Define tool parameters with pi-schema's builders
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: obj({
    location: str({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// Note: StringEnum gives { type: "string", enum: [...] }, which every provider accepts,
// including Google-compatible endpoints, which reject anyOf/const patterns

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: obj({
    title: str({ minLength: 1 }),
    startTime: str({ format: 'date-time' }),
    endTime: str({ format: 'date-time' }),
    attendees: arr(str({ format: 'email' }), { minItems: 1 })
  })
};
```

### Constrained Sampling for Tools

Tools can opt in to provider-side constrained sampling. For JSON-schema tools, `strict: 'prefer'` uses provider-side strict schema enforcement when supported and otherwise falls back to normal tool calling. `strict: 'require'` fails the request when the active provider/model cannot honor it. Set `constrainedSampling: false` to explicitly opt out; it behaves the same as omitting the field.

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: 'Edit a file',
  parameters: obj({ path: str(), content: str() }), // obj() is closed: additionalProperties: false
  constrainedSampling: { type: 'json_schema', strict: 'prefer' }
};
```

Strict JSON-schema constrained sampling is supported for OpenAI (Responses and Chat Completions), Anthropic Messages models whose catalog entry sets `compat.supportsStrictTools`, and Gemini 3 tool calls through the `google-generative-ai` adapter. Google uses `VALIDATED` function-calling mode (or `ANY` when explicitly requested); earlier Gemini versions fall back for `strict: 'prefer'` and reject `strict: 'require'` because they do not enforce required parameters. OpenAI Responses and Chat Completions can also emit grammar-constrained custom tools with OpenAI Lark or regex grammar variants. If multiple OpenAI variants are supplied, Lark is preferred over regex. Grammar constraints are enforced when the active model supports grammar tools; otherwise the tool falls back to normal function/JSON-schema handling. Grammar tool capability is model metadata: the generated catalog sets `compat.supportsOpenAIGrammarTools` for GPT-5+ models on OpenAI and OpenAI Codex, and on custom `models.json` endpoints that pass OpenAI custom tools through. OpenAI rejects `type: "custom"` tools for pre-GPT-5 models, and gateways that normalize tool schemas mangle them, so the flag stays off elsewhere. Custom model definitions can opt in via `compat`. Grammar-capable models reject grammar configurations without a non-empty supported variant. Native grammar tools must have an object parameter schema with exactly one required string property:

```typescript
const patchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a patch',
  parameters: obj({ input: str() }),
  constrainedSampling: {
    type: 'grammar',
    variants: {
      openai_lark: 'start: /.+/s'
    }
  }
};
```

### Handling Tool Calls

Tool results use content blocks and can include both text and images:

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// Check for tool calls in the response
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // Execute your tool with the arguments
    // See "Validating Tool Arguments" section for validation
    const result = await executeWeatherApi(block.arguments);

    // Add tool result with text content
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// Tool results can also include images (for vision-capable models)
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### Streaming Tool Calls with Partial JSON

During streaming, tool call arguments are progressively parsed as they arrive. This enables real-time UI updates before the complete arguments are available:

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments contains partially parsed JSON during streaming
    // This allows for progressive UI updates
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // BE DEFENSIVE: arguments may be incomplete
      // Example: Show file path being written even before content is complete
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // Content might be partial or missing
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // Here toolCall.arguments is complete (but not yet validated)
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**Important notes about partial tool arguments:**
- During `toolcall_delta` events, `arguments` contains the best-effort parse of partial JSON
- Fields may be missing or incomplete - always check for existence before use
- String values may be truncated mid-word
- Arrays may be incomplete
- Nested objects may be partially populated
- At minimum, `arguments` will be an empty object `{}`, never `undefined`
- The `google-generative-ai` adapter does not stream function call arguments. You receive `toolcall_start`, one `toolcall_delta` carrying the full arguments, then `toolcall_end`.

### Validating Tool Arguments

When implementing your own tool execution loop, use `validateToolCall` to validate arguments before passing them to your tools. It coerces loosely typed arguments with pi-schema (`compile(schema, { coerce: true }).parse()`), returns the coerced arguments, and throws an error listing pi-schema's errors (`path: message`) followed by the arguments it received:

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // Validate arguments against the tool's schema (throws on invalid args)
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... add tool result to context
    } catch (error) {
      // Validation failed - return error as tool result so model can retry
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### Complete Event Reference

Successful generation follows `start → updates* → done`. A failure after generation starts follows `start → updates* → error`. Request setup may fail before generation starts, in which case the stream contains only `error`; `done` and update events are invalid before `start`. Direct API `streamSimple()` calls throw synchronously when request auth is missing.

Every non-terminal event's `partial` is the shared live response-so-far helper. It is intentionally not an event-time snapshot: providers may mutate the same message and content blocks as generation advances, including while older events wait in the stream queue. Inspect it when handling an event instead of retaining it as historical state. Text and ordinary thinking blocks are empty when their `*_start` event is emitted and grow only through matching `*_delta` events until the authoritative `*_end`; redacted thinking may be complete at start and emit no deltas. Tool-call arguments at `toolcall_start` are provider-specific; `toolcall_delta` carries subsequent JSON updates.

All streaming events emitted during assistant message generation:

| Event Type | Description | Key Properties |
|------------|-------------|----------------|
| `start` | Stream begins | `partial`: Initial assistant message structure |
| `text_start` | Text block starts | `contentIndex`: Position in content array |
| `text_delta` | Text chunk received | `delta`: New text, `contentIndex`: Position |
| `text_end` | Text block complete | `content`: Full text, `contentIndex`: Position |
| `thinking_start` | Thinking block starts | `contentIndex`: Position in content array |
| `thinking_delta` | Thinking chunk received | `delta`: New text, `contentIndex`: Position |
| `thinking_end` | Thinking block complete | `content`: Full thinking, `contentIndex`: Position |
| `toolcall_start` | Tool call begins | `contentIndex`: Position in content array |
| `toolcall_delta` | Tool arguments streaming | `delta`: JSON chunk, `partial.content[contentIndex].arguments`: Partial parsed args |
| `toolcall_end` | Tool call complete | `toolCall`: Complete, but not schema-validated, tool call with `id`, `name`, `arguments` |
| `done` | Stream complete | `reason`: Stop reason ("stop", "length", "toolUse"), `message`: Final assistant message |
| `error` | Error occurred | `reason`: Error type ("error" or "aborted"), `error`: AssistantMessage with partial content |

Streaming events for different content blocks are not guaranteed to be contiguous. Providers may emit deltas for text, thinking, and tool calls in the same upstream chunk, and pi may surface corresponding events interleaved, for example `text_start`, `text_delta`, `toolcall_start`, `text_delta`, `toolcall_delta`. Consumers must use `contentIndex` to associate each delta/end event with its block and must not assume that a block's `*_start`/`*_delta`/`*_end` sequence is uninterrupted by events for other blocks.

## Image Input

Models with vision capabilities can process images. You can check if a model supports images via the `input` property. If you pass images to a non-vision model, they are silently ignored.

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// Check if model supports images
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// Access the response
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## Image Generation

Image models live in the same `Models` collection and on the same `Provider` as chat models, so one credential per provider covers both. They are typed `ImageModel` with `type: "image"` and are used through `generateImages()`, a one-shot API that waits for the provider response and returns the final `AssistantImages` result. Do not use the chat/stream APIs for them; `stream()` rejects image models.

No built-in provider ships image models and no built-in image API implementation remains. The machinery stays for custom providers that bring their own `images` implementation:

```typescript
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';

const pixels = createProvider({
  id: 'pixels',
  auth: { apiKey: envApiKeyAuth('Pixels API key', ['PIXELS_API_KEY']) },
  models: [{
    type: 'image',
    id: 'flux-pro',
    name: 'FLUX Pro',
    api: 'pixels-images',
    provider: 'pixels',
    baseUrl: 'https://api.pixels.test/v1',
    input: ['text'],
    output: ['image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
  images: {
    'pixels-images': { generateImages: async (model, context, options) => { /* ... */ } },
  },
});
models.setProvider(pixels);

const model = models.getModelOfType('image', 'pixels', 'flux-pro')!;
const result = await models.generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
});

for (const block of result.output) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'image') {
    console.log(block.mimeType);
    console.log(block.data.substring(0, 32));
  }
}
```

`generateImages()` accepts only `ImageModel` values. If an upstream model supports both chat and image generation, the catalog contains separate entries with the same provider and ID: `getModel()` returns its chat operation and `getModelOfType('image', ...)` returns its image operation. Failures never reject; they return an `AssistantImages` with `stopReason: "error"`, including unknown providers, unconfigured auth, and providers without an image implementation.

A provider declares image support with the `images` option of [`createProvider()`](#createprovider): a map from `model.api` to an implementation with `generateImages()`. Image models go into the same `models` list as chat models. `api` becomes optional when `images` is present, so an image-only provider is just a provider without chat models.

Some models also support image input:

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await models.generateImages(model, {
  input: [
    { type: 'text', text: 'Create a variation of this image with a blue background.' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

Check capabilities on the model metadata:

```typescript
console.log(model.input);  // ['text'] or ['text', 'image']
console.log(model.output); // ['image'] or ['image', 'text']
```

### Notes and Limitations

- Image models and chat models share `Models` and `Provider`; list them with `getModelsOfType('image')` and run them with `generateImages()`, never the chat/stream APIs.
- Image-generation models do not participate in tool calling.
- Outputs are returned in `AssistantImages.output` and can include both base64-encoded `ImageContent` blocks and `TextContent` blocks.
- Some models return only images, others return images plus text. Check `model.output`.
- Some models accept image input, others are text-to-image only. Check `model.input`.
- Like the streaming APIs, image generation supports options such as `apiKey`, `signal`, `headers`, `onPayload`, and `onResponse`, and results may include `stopReason`, `responseId`, and `usage`.
- If you want a model to analyze images in a conversation or call tools, use the regular chat APIs with a model that supports image input.

## Classification

Classifier models consume structured JSON state, and optionally images, and answer one or more typed questions. They do not use chat or image-generation APIs. One built-in model exists, OpenAI's GPT-6 Luna on the `openai-decisions` API:

| Provider | Model IDs | Auth |
| --- | --- | --- |
| `openai` | `gpt-6-luna` | `OPENAI_API_KEY` |

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels();
const model = models.getModelOfType('classifier', 'openai', 'gpt-6-luna')!;
const result = await models.classify(model, {
  state: { message: 'The change works perfectly, thanks.' },
  questions: {
    category: {
      type: 'choice',
      instructions: 'Classify the message.',
      criteria: {
        approval: 'The user approves of the result',
        correction: 'The user requests a correction'
      }
    },
    satisfaction: {
      type: 'score',
      instructions: 'Score user satisfaction.',
      criteria: ['dissatisfied', 'neutral', 'satisfied']
    },
    approved: {
      type: 'bool',
      instructions: 'Does the user approve?',
      criteria: { true: 'Approval', false: 'No approval' }
    }
  }
});

console.log(result.answers);
```

Like image generation, `classify()` resolves to a result with `stopReason: "error"` instead of rejecting for provider, authentication, or response errors.

When the service reports token counts, `result.usage` carries them with their cost at the model's catalog price, the same `Usage` shape as chat messages. A request that was answered with malformed answers keeps its usage, because it was billed.

`ClassifierOptions.temperature` divides the answer logits by the given value before they are normalized; values above 1 soften the distribution. APIs that cannot apply it, such as OpenAI Decisions, ignore it.

`ClassifierContext.images` holds image blocks (`{ type: "image", data, mimeType }`) judged together with the state. Only models whose `input` includes `"image"` accept them; `classify()` returns an error result for other models.

### OpenAI Decisions

The `openai-decisions` API calls OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`POST /v1/decisions`). GPT-6 Luna is its only model. The state is sent as JSON text; with images, the input is one user message with the state followed by the images as data URLs (at most 128). `choice` and `score` questions map to the Decisions types of the same name. `bool` questions become `predicate` questions; predicates have no criteria field, so the meanings of true and false are appended to the instructions. If OpenAI refuses to answer a question, the whole result is an error. Usage reports input tokens only, priced at the catalog input rate with OpenAI's long-context multiplier.

The endpoint needs an OpenAI API key; Sign in with ChatGPT credentials are rejected, so the `openai` provider hides `gpt-6-luna` from `getAvailableOfType('classifier')` while it uses OAuth. The API rejects inputs above 922K tokens, but requests that run longer than about five seconds, currently above roughly 600K input tokens, fail with a gateway timeout (504).

### Custom classifiers

Custom providers register classifier models and implementations by API ID:

```typescript
createProvider({
  id: 'classifier-service',
  auth,
  models: [model],
  classifiers: {
    'classifier-api': { classify: async (model, context, options) => result }
  }
});
```

`model` is a `ClassifierModel` with `type: "classifier"`, `api: "classifier-api"`, a `contextWindow`, and the usual provider, cost, and input fields. `ClassifierOptions.temperature` is advisory: an implementation that cannot apply it ignores it.

## Thinking/Reasoning

Many models support thinking/reasoning capabilities where they can show their internal thought process. You can check if a model supports reasoning via the `reasoning` property. If you pass reasoning options to a non-reasoning model, they are silently ignored.

### Unified Interface (streamSimple/completeSimple)

```typescript
// Many models across providers support thinking/reasoning
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// or models.getModel('openai', 'gpt-5-mini');
// or models.getModel('openai-codex', 'gpt-5.6-luna');
// or models.getModel('xai', 'grok-4.7');

// Check if model supports reasoning
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// Use the simplified reasoning option
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// Access thinking and text blocks
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

`xhigh` and `max` are model-specific, opt-in levels. Use `getSupportedThinkingLevels(model)` to determine whether a concrete model exposes either level; models such as GPT-5.6 can expose both.

### Provider-Specific Options (stream/complete)

`models.stream()`/`complete()` accept the owning API's full option set. Use `hasApi()` to narrow a dynamically looked-up model to its API for full option typing:

```typescript
import { hasApi } from '@earendil-works/pi-ai';

// OpenAI Reasoning (o1, o3, gpt-5)
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // OpenAI Responses API only
  });
}

// Anthropic Thinking
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // Optional token limit
  });
}

// Google-compatible endpoints through models.json
const googleModel = models.getModel('my-gemini', 'gemini-3-pro')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 for dynamic, 0 to disable
    }
  });
}
```

### Streaming Thinking Content

When streaming, thinking content is delivered through specific events:

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // Stream thinking content
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## Stop Reasons

Every `AssistantMessage` includes a `stopReason` field that indicates how the generation ended:

- `"pending"` - Only present in partial messages when we do not know what the stop reason will be
- `"stop"` - This is the final message the model will produce this turn
- `"length"` - Output hit the maximum token limit
- `"toolUse"` - Model is calling tools and expects tool results
- `"error"` - An error occurred during generation
- `"aborted"` - Request was cancelled via abort signal

`AssistantMessage` may also include `responseId`, a provider-specific upstream response or message identifier when the underlying API exposes one. Do not assume it is always present across providers.

## Telemetry

Pass an explicit parent span (`TelemetrySpan`, not an adapter) through `telemetry`; omitting it uses the no-op span:

```typescript
import { InMemoryTelemetryContext } from '@earendil-works/pi-telemetry';

const telemetry = new InMemoryTelemetryContext();
await telemetry.startSpan({ name: 'application.turn' }, async (span) => {
  await models.completeSimple(model, context, { telemetry: span });
});
```

`Models.stream()` and `streamSimple()` create `pi.ai.request`; `streamDeferred()` creates one `pi.ai.poll` per poll. Their completion helpers use the same spans. These spans include auth/setup, end at the terminal result, and do not require the caller to consume events. Direct provider/API calls are not instrumented.

`AI_TELEMETRY_SCHEMA`, exported from the root and `@earendil-works/pi-ai/models`, defines the typed Pi-owned vocabulary:

- Start attributes: `provider`, `api`, `model`, and `reasoning` only when `options.reasoning` is a string. Provider-native reasoning objects are ignored.
- End attributes: `stop`, `usage.input`, `usage.output`, `usage.cache_read`, `usage.cache_write`, `cost.total`, and optional `response.id`. `stop: "error"` sets error status with the fixed category `provider_error` and `AssistantMessage.errorMessage` truncated to 500 characters (empty when absent). Cancellation keeps status `ok` with `stop: "aborted"`.
- `pi.ai.first_chunk` marks the first normalized event, including setup errors. Each completed text, thinking, or tool-call block emits `pi.ai.block` with `type`, `index`, and `chars`; only tool calls include `tool`. Character counts use JavaScript string length; tool counts sum argument delta lengths without serializing arguments.

When `options.telemetry.metrics` is available, the same requests record metrics:

| Metric | Unit | Attributes |
| --- | --- | --- |
| `pi.ai.request.duration` | `ms` | `provider`, `model`, `stop` |
| `pi.ai.first_chunk.duration` | `ms` | `provider`, `model` |
| `pi.ai.tokens` | `token` | `provider`, `model`, `kind` (`input`, `output`, `cache_read`, `cache_write`) |
| `pi.ai.cost` | `USD` | `provider`, `model` |

Durations use `performance.now()`. Pending/deferred polls do not add tokens or cost; final completed/error polls do. A parent span without metric capabilities remains valid and simply records no metrics. Adapter-created spans carry the same optional metric and propagation capabilities as their root.

Telemetry does not record prompts, generated text, reasoning content, or arguments in attributes/events. Error status includes up to 500 characters of provider error text, which may contain sensitive data; apply your export policy accordingly. Telemetry observes the existing forwarding path without another stream consumer or per-delta events. Response identifiers and error messages never become metric attributes.

## Error Handling

Request failures after a stream is returned never throw: when a request ends with an error (including aborts and tool call validation errors), the streaming API emits an error event and the final message carries the details. Setup failures may emit `error` without `start`; failures after generation begins emit `start`, any observed updates, then `error`. Direct API `streamSimple()` calls throw synchronously when request auth is missing:

```typescript
// In streaming
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason is either "error" or "aborted"
    // event.error is the AssistantMessage with partial content
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// The final message will have the error details
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content contains any partial content received before the error
  // message.usage contains partial token counts and costs
}
```

When using a provider collection, auth failures (OAuth refresh failed, unknown provider) surface as a stream error with `stopReason: "error"`. Direct API `streamSimple()` calls instead throw synchronously when their required auth is absent.

### Aborting Requests

The abort signal allows you to cancel in-progress requests. Aborted requests have `stopReason === 'aborted'`:

```typescript
const controller = new AbortController();

// Abort after 2 seconds
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason tells you if it was "error" or "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// Get results (may be partial if aborted)
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### Continuing After Abort

Aborted messages can be added to the conversation context and continued in subsequent requests:

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail', timestamp: Date.now() }
  ]
};

// First request gets aborted after 2 seconds
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// Add the partial response to context
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });

// Continue the conversation
const continuation = await models.complete(model, context);
```

### Debugging Provider Payloads

Use the `onPayload` callback to inspect the request payload sent to the provider. This is useful for debugging request formatting issues or provider validation errors.

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

The callback is supported by `stream`, `complete`, `streamSimple`, and `completeSimple`.

### Observing Provider Stream Events

Use `onProviderStreamEvent` to inspect provider-specific fields that Pi does not include in `AssistantMessage`. The callback receives the parsed event available to the adapter before Pi normalizes it. Treat the event as read-only because mutations can affect normalization. This is not guaranteed to be the original HTTP bytes or SSE frame.

```typescript
const response = await models.complete(model, context, {
  onProviderStreamEvent: (data) => {
    // Adapter-owned parsed event; fields differ per API.
    const chunk = data as Record<string, unknown>;
    console.log(Object.keys(chunk));
  },
});
```

Callbacks are awaited in stream order, so slow callbacks delay stream consumption and thrown errors fail the request. SDK-backed adapters can expose only fields retained by their SDK.

## Custom Providers

### createProvider()

`createProvider()` builds a provider from parts: identity, auth, a model list, and an API implementation (`api` for chat models, `images` for image generation, `classifiers` for classification; at least one is required, see [Image Generation](#image-generation)). Use it for local inference servers, proxies, or any OpenAI/Anthropic-compatible endpoint:

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // Every provider declares auth; keyless local servers resolve as configured with no key.
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

For providers with real keys, `envApiKeyAuth(displayName, envVars)` gives the standard behavior (stored credential wins, then the first set env var):

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

Mixed-API providers pass a map keyed by `model.api`; each model dispatches to its API's implementation:

```typescript
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* models with api: 'anthropic-messages' or 'openai-responses' */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

Provider-wide endpoint or request transformations belong in the provider's API implementation: wrap the `ProviderStreams` you pass as `api` so every request goes through the transformation before dispatch. This is how a provider can fill endpoint placeholders from its resolved env:

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

Dynamic model lists use `fetchModels`, which can return models of every type. `Models.refresh()` refreshes every configured dynamic provider, passing its effective API-key or refreshed OAuth credential. A `ModelsStore` persists dynamic catalogs; both stores default to in-memory implementations. Its `read`, `write`, and `delete` operations accept optional cancellation, and `Models` binds those waits to the provider refresh signal.

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:9931', signal),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log('refresh cancelled');
for (const [provider, error] of result.errors) console.error(provider, error);
```

`Models.refresh()` is unbounded when its optional signal is omitted. Providers always receive a concrete `RefreshModelsContext.signal` and must honor it for network requests and other blocking work. When a caller supplies a signal, `Models.refresh()` returns promptly with `aborted: true` after cancellation even if a custom provider fails to cooperate; the provider must still honor the signal to stop its underlying work.

Use `models.refresh({ providers: ['llamacpp'] })` to restrict work to selected providers, `models.refresh({ allowNetwork: false })` to restore persisted catalogs without network access, or `models.refresh({ force: true })` to bypass provider freshness checks. Model reads stay synchronous and return the last restored or refreshed list.

`createProvider()` handles dynamic publication and persistence automatically. Handwritten `Provider.refreshModels()` implementations receive the read-only `context.stored` snapshot and publish through `context.publish({ persist?, update? })`. Omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it. `ModelsStoreEntry.models` contains models of every type. Publication is generation-checked; put synchronous in-memory catalog changes in `update` rather than mutating state before publication.

Custom models can carry `headers` (e.g. proxies behind bot detection) and `compat` flags. `Models.getAuth(model)` includes those model headers, and stream methods merge them before explicit request headers and `transformHeaders`. See [OpenAI Compatibility Settings](#openai-compatibility-settings).

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so the system prompt is sent as a `system` message instead. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

Use model-level `thinkingLevelMap` to describe model-specific thinking controls. Keys are pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Missing standard levels through `high` use provider defaults; `xhigh` and `max` are opt-in and require a non-null map entry. String values are sent to the provider, `null` marks a level unsupported, and maps may skip levels.

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### models.json endpoints

The coding agent reaches non-built-in endpoints through `models.json`, which it composes into `createProvider()` providers. The same `api` ids are used: `openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`. That is how an Ollama, vLLM, LM Studio, or Gemini-compatible endpoint is used without a built-in catalog:

```json
{
  "providers": {
    "my-gemini": {
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
      "api": "google-generative-ai",
      "apiKey": "$GEMINI_API_KEY",
      "models": [
        { "id": "gemini-3-pro", "reasoning": true, "contextWindow": 1000000, "maxTokens": 65536 }
      ]
    }
  }
}
```

- `apiKey` accepts a literal, `$NAME`/`${NAME}` environment interpolation, or a leading `!command`; `$$` and `$!` produce a literal `$` and `!`.
- `authHeader: true` sends the resolved key as `Authorization: Bearer` instead of the API's default header.
- A `models` entry adds or replaces a model with the same id; `modelOverrides` patches metadata on an existing model.
- Setting only `baseUrl` on a built-in provider id routes that provider through a proxy without changing its models or auth.
- `compat` takes the same fields as [OpenAI Compatibility Settings](#openai-compatibility-settings).

### Calling API Implementations Directly

The API implementations are importable on their own. Each module exports exactly `stream` and `streamSimple` with that API's full option typing. Direct calls bypass provider auth and context normalization — pass `apiKey` explicitly and wrap the context in `normalizeContext()`:

```typescript
import { normalizeContext } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, normalizeContext(context), {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

Built-in API implementations live under `./api/<api-id>`:

| API id | Options type |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |

`openai-decisions` is a classifier implementation, not a chat one: `@earendil-works/pi-ai/api/openai-decisions` exports `classify` and the lazy `openAIDecisionsApi()` wrapper.

Importing an implementation module loads its SDK. The `./api/<id>.lazy` wrappers (used by the provider factories) defer that load to the first request when the runtime or bundler supports dynamic import chunking. Legacy raw API subpaths from older releases (`./anthropic`, `./google`, `./openai-completions`, ...) were removed; use `@earendil-works/pi-ai/api/<api-id>`.

**Anthropic message threads:** with `sessionId` set and `cacheRetention` not `"none"`, Anthropic requests continue from the previous reply on the server (`message-threads-2026-08-12` beta) and send only the new messages. When anything earlier in the request changed, or the server can't continue, the full request is sent. Token counts and prompt caching are unchanged. On by default only for the `anthropic` provider on `api.anthropic.com`; set `compat.supportsMessageThreads` to change that, for example for gateways that forward the `thread` field. Set `disableContinuation: true` on requests that repeat an earlier one, such as cache warming. Call `cleanupSessionResources(sessionId)` when a session ends.

### OpenAI Compatibility Settings

The `openai-completions` API is implemented by many servers with minor differences. By default, the library auto-detects compatibility settings from the provider id and `baseUrl` for a set of known OpenAI-compatible endpoints, including xAI, DeepSeek, Cerebras, Together AI, NVIDIA NIM, z.ai, OpenCode, Moonshot, and Cloudflare Workers AI. For custom proxies or unknown endpoints, override these settings via the `compat` field. For `openai-responses` models, the compat field supports Responses-specific flags.

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // Whether provider supports the `store` field (default: auto-detected from URL)
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: auto-detected from URL)
  supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: auto-detected from URL)
  supportsUsageInStreaming?: boolean; // Whether provider supports `stream_options: { include_usage: true }` (default: true)
  supportsFinishReason?: boolean;    // Whether streamed responses include `finish_reason`; when false, stop/toolUse is inferred (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports `strict` in tool definitions (default: false; enabled in metadata for capable models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false)
  supportsMidConvoSystemMessages?: boolean; // Whether the model accepts system messages after the conversation started; false folds them into the leading prompt (default: false)
  supportsMidConvoToolAdditions?: boolean; // Whether system messages can add tools mid-conversation via `tools` system messages; requires supportsMidConvoSystemMessages (default: false)
  sendSessionAffinityHeaders?: boolean; // Send session-affinity data from `sessionId` (default: auto-detected)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Session-affinity header format (default: auto-detected)
  promptCacheKeyMode?: 'auto' | 'enabled' | 'disabled'; // Controls the `prompt_cache_key` request field (default: 'auto')
  supportsLongCacheRetention?: boolean; // Whether provider supports long prompt cache retention (default: auto-detected)
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // Which field name to use (default: auto-detected)
  requiresToolResultName?: boolean;  // Whether tool results require the `name` field (default: auto-detected)
  requiresAssistantAfterToolResult?: boolean; // Whether a user message after tool results requires an assistant message in between (default: auto-detected)
  requiresNonNullAssistantContent?: boolean; // Whether replayed assistant messages with no text must send "" instead of null content (default: false)
  requiresThinkingAsText?: boolean;  // Whether thinking blocks must be converted to text (default: auto-detected from URL)
  requiresReasoningContentOnAssistantMessages?: boolean; // Whether all replayed assistant messages must include empty reasoning_content when reasoning is enabled (default: auto-detected from URL)
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'baseten' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // Format for the reasoning/thinking parameter (default: auto-detected)
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_kwargs values for thinkingFormat: 'chat-template'
  chatTemplateArgs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // chat_template_args values for thinkingFormat: 'baseten'
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // Top-level field that caps reasoning tokens from thinkingBudgets. Off by default.
  supportsThinkingTokenBudget?: boolean; // Alias for thinkingTokenBudgetField: 'thinking_token_budget' (vLLM). Prefer thinkingTokenBudgetField. Default: false.
  cacheControlFormat?: 'anthropic';  // Anthropic-style cache_control on system prompt, last tool, and last user/assistant text content
  vllmPriority?: number;             // vLLM scheduler priority sent as top-level `priority`. Off by default.
  zaiToolStream?: boolean;           // Whether z.ai supports top-level `tool_stream` for streaming tool call deltas (default: false)
  openRouterRouting?: OpenRouterRouting; // OpenRouter routing preferences, for endpoints that speak the OpenRouter API (default: {})
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway routing preferences (default: {})
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // Whether provider supports `developer` role vs `system` (default: true)
  supportsMidConvoSystemMessages?: boolean; // Whether the exact model accepts developer/system messages mid-conversation (default: false)
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // Session-affinity header format (default: auto-detected)
  promptCacheKeyMode?: 'auto' | 'enabled' | 'disabled'; // Controls the `prompt_cache_key` request field (default: 'auto')
  supportsLongCacheRetention?: boolean; // Whether provider supports long prompt cache retention (default: true)
  supportsStrictMode?: boolean;      // Whether provider supports strict JSON-schema function tools (default: auto-detected; catalog enables it for capable models)
  supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools (default: false)
  supportsAdditionalTools?: boolean; // Whether the model supports message-anchored `additional_tools` input items (default: false)
  supportsToolSearch?: boolean;      // Whether the model supports client-executed tool search (default: false)
}
```

`sessionAffinityFormat: "openrouter"` selects `x-session-id` for endpoints that implement OpenRouter's session affinity. Explicit request headers take precedence over generated headers.

The `openrouter`, `deepseek`, `together`, `baseten`, `zai`, `qwen`, and `ant-ling` values above are wire-format names for endpoints that speak those dialects. None of them is a built-in provider here; they only apply to providers you define yourself.

If `compat` is not set, the library falls back to URL-based detection. If `compat` is partially set, unspecified fields use the detected defaults. This is useful for:

- **LiteLLM proxies**: May not support the `store` field
- **Custom inference servers**: May use non-standard field names
- **Self-hosted endpoints**: May have different feature support

## Faux Provider for Tests

`fauxProvider()` builds an in-memory provider with scripted responses for tests and demos:

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // optional
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// Optional: multiple faux models for model-switching tests
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

Notes:
- Responses are consumed from a queue in request start order.
- If the queue is empty, the faux provider returns an assistant error message with `errorMessage: "No more faux responses queued"`.
- Use `faux.setResponses([...])` to replace the remaining queue and `faux.appendResponses([...])` to add more responses.
- `faux.models` exposes all faux models. `faux.getModel()` returns the first one, and `faux.getModel(id)` returns a specific one.
- Use `fauxAssistantMessage(...)` for scripted assistant replies. Use `fauxText(...)`, `fauxThinking(...)`, and `fauxToolCall(...)` to build content blocks without filling in low-level fields manually.
- Usage is estimated at roughly 1 token per 4 characters. When `sessionId` is present and `cacheRetention` is not `"none"`, prompt cache reads and writes are simulated automatically.
- Tool call arguments stream incrementally via `toolcall_delta` chunks.
- By default, each streamed chunk is emitted on its own microtask. Set `tokensPerSecond` to pace chunk delivery in real time.
- The intended use is one deterministic scripted flow per handle. If you need independent concurrent flows, create separate faux providers with distinct `provider` ids.

## Cross-Provider Handoffs

The library supports seamless handoffs between different LLM providers within the same conversation. This allows you to switch models mid-conversation while preserving context, including text, tool calls, and tool results.

When messages from one provider are sent to a different provider, the library automatically transforms them for compatibility:

- **User and tool result messages** are passed through unchanged
- **Assistant messages from the same provider, API, and model** are preserved as-is, including thinking blocks
- **Assistant messages from a different model** have their thinking blocks dropped. Signatures and encrypted reasoning only work with the model that produced them, and readable thinking sent as plain text makes the new model treat it as part of the reply
- **Tool calls and regular text** are preserved unchanged

```typescript
import { createModels, type Context } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(xaiProvider());

const context: Context = { messages: [] };

// Start with Claude
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: 'What is 25 * 18?', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// Switch to GPT-5 - it sees Claude's answer, but not Claude's thinking
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: 'Is that calculation correct?', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// Switch to Grok
const grok = models.getModel('xai', 'grok-4.7')!;
context.messages.push({ role: 'user', content: 'What was the original question?', timestamp: Date.now() });
const grokResponse = await models.complete(grok, context);
```

All providers can handle messages from other providers — text, tool calls and results (including images), thinking blocks (dropped when the model changes), and aborted messages with partial content. This enables flexible workflows: start with a fast model, switch to a more capable one for complex reasoning, or maintain continuity across provider outages.

## System Messages

`Context.systemPrompt` and `Context.tools` are shorthand for a leading system message. The public entry points (`Models.stream()`, `streamSimple()`, `complete()`, `completeSimple()`) accept a `Context` and call `normalizeContext()` once; everything below them, including `Provider.stream()`, `ProviderStreams`, and the API implementation modules, receives the resulting `TranscriptContext`, which only has `messages`. The transcript can also carry system messages later in the conversation to change the prompt or the tool set without rewriting the history:

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];             // leading: base prompt; later: added instructions
  sections?: Record<string, string | null>;    // named prompt sections; later messages patch by name, null removes
  toolsAdded?: Tool[];                         // tools that become available here
  toolsRemoved?: ToolReference[];              // tools that stop being available here
  timestamp: number;
}
```

Sections are opaque text rendered verbatim after `content`, joined by blank lines. Keep each one self-delimiting (a tag, a heading) so the model can relate an update to the original. Replaying every system message in order yields the current prompt and tools; the replay helpers take the message list:

```typescript
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

const messages: Message[] = [
  { role: "system", content: "You are helpful.", sections: { rules: "<rules>Be brief.</rules>" }, toolsAdded: [readTool], timestamp: 1 },
  { role: "user", content: "hi", timestamp: 2 },
  { role: "system", content: "", sections: { rules: "<rules>Be thorough.</rules>" }, toolsRemoved: [{ name: "read" }], timestamp: 3 },
];
getCurrentSystemPrompt(messages); // "You are helpful.\n\n<rules>Be thorough.</rules>"
getCurrentTools(messages);        // []
```

A custom `Provider` or `ProviderStreams` implementation reads the prompt and tools the same way from `context.messages`; `context.systemPrompt` and `context.tools` do not exist at that layer.

Models that accept system messages mid-conversation (`supportsMidConvoSystemMessages` in the model's compat settings, set by the generated catalog for verified models) receive each later system message in place, so the cached prefix stays intact; section changes are framed by name for the model. Every other model receives `collapseSystemMessages(transcript)`: the replayed prompt and current tools as the leading system message, with later system messages dropped. Anthropic models that also set `supportsMidConvoToolChanges` send tool changes as native blocks (`inline-tools-2026-09-15` beta): the top-level tool list holds the initial tools plus a stable deferred placeholder and never changes, later tools are defined by value in `tool_addition` blocks (a new definition under an existing name replaces the old one), and removals are `tool_removal` references, so tool changes do not invalidate the prompt cache. That needs at least one initial tool; otherwise the current tool list is sent at the top level with the system text only. OpenAI Responses models with `supportsAdditionalTools` declare every tool in `additional_tools` items, like Codex: the initial tools in one at the head of the input and later additions and redefinitions at their message, with no top-level tool list. A later item replaces same-name definitions from earlier items but cannot replace a top-level tool or remove any tool, so removals are announced as text, later updates restate the tools that are still unavailable, and calls to removed tools fail at execution. OpenAI Responses models with only `supportsToolSearch`, and Kimi models with `supportsMidConvoToolAdditions`, anchor new tools at their message; a removal or a redeclared name moves the tool state up to that point into the top-level list once. Everything else sends the current tool list at the top level.

## Context Serialization

The `Context` object can be easily serialized and deserialized using standard JSON methods, making it simple to persist conversations, implement chat history, or transfer contexts between services:

```typescript
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// Serialize the entire context
const serialized = JSON.stringify(context);

// Save to database, localStorage, file, etc.
localStorage.setItem('conversation', serialized);

// Later: deserialize and continue the conversation
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system', timestamp: Date.now() });

// Continue with any model
const newModel = models.getModel('anthropic', 'claude-haiku-4-5')!;
const continuation = await models.complete(newModel, restored);
```

Models are plain serializable data too — no functions or implementations attached — so persisting "which model was this conversation using" is a `JSON.stringify` away.

> **Note**: If the context contains images (encoded as base64 as shown in the Image Input section), those will also be serialized.

## Browser Usage

The library supports browser environments. The core entrypoint and provider factories are side-effect free and bundle cleanly. Environment variables are not available in browsers, so pass API keys explicitly — or inject a `CredentialStore` (e.g. localStorage-backed) and let provider auth resolve from stored credentials:

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-haiku-4-5')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: 'Hello!', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **Security Warning**: Exposing API keys in frontend code is dangerous. Anyone can extract and abuse your keys. Only use this approach for internal tools or demos. For production applications, use a backend proxy that keeps your API keys secure.

Browser compatibility notes:

- OAuth login flows are Node-only. They are lazy-loaded behind bundler-opaque imports, so registering an OAuth-capable provider does not pull Node-only code into a browser bundle — only actually logging in would.
- Use a server-side proxy or backend service if you need OAuth-based auth from a web app.

## Bundling and Tree Shaking

For small bundles and low-overhead unbundled scripts, import the model runtime and only the providers you need:

```typescript
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

Rules:

- `@earendil-works/pi-ai/models` exports the model runtime (`createModels`, `createProvider`, model helpers, and their types) without schema validation, built-in catalogs, or SDK implementations. Other types can still use `import type` from the root.
- `@earendil-works/pi-ai` is the core entrypoint and does not import built-in catalogs, real provider factories, or SDK implementations, but it eagerly imports schema validation (pi-schema). Unbundled Node scripts do not tree-shake its unused exports; prefer `./models`, `./providers/faux`, and specific `./utils/*` subpaths when those are all you need.
- `@earendil-works/pi-ai/providers/<provider>` imports that provider's catalog and lazy API wrapper only.
- `@earendil-works/pi-ai/providers/all` imports every built-in provider factory and all catalogs. Use it only when you want the full built-in set.
- With code splitting, provider SDKs stay in lazy chunks and load on first request.
- Without code splitting, bundlers fold reachable lazy API implementations into the single bundle. A single-provider bundle then includes that provider's SDK; `providers/all` includes all statically visible SDKs.
- Importing `@earendil-works/pi-ai/api/<api-id>` directly loads that API implementation and its SDK immediately.

Avoid `@earendil-works/pi-ai/compat` in new bundled apps; it preserves the old global API and imports the full built-in catalog surface.

For single-file Node ESM bundles, some SDK dependencies may still use dynamic CommonJS `require()` internally. If you see errors such as `Dynamic require of "child_process" is not supported`, add a Node `require` shim to the bundle. With esbuild:

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

This is only for Node bundles; it is not a browser workaround.

Node bundles that split at dynamic imports (esbuild `splitting: true`) can keep the OAuth login flows inside the bundle but lazy: register loaders with literal dynamic imports, which the bundler turns into chunks that load on first use:

```typescript
import { registerLazyOAuthFlows } from '@earendil-works/pi-ai/lazy-oauth';

registerLazyOAuthFlows();
```

That module is Node-only; never import it into a browser bundle. For a standalone Bun binary, `@earendil-works/pi-ai/bun-oauth` exports `registerBunOAuthFlows()` to embed the same flows statically.

### Provider-Scoped Environment Overrides

Pass `env` in stream options to scope provider configuration to a request. Values in `env` are used before process environment variables for provider auth and for configuration such as `PI_CACHE_RETENTION` and the proxy variables (`HTTP_PROXY`/`HTTPS_PROXY`, or their lowercase forms).

```typescript
const models = builtinModels();
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;

const response = await models.complete(model, context, {
  env: {
    PI_CACHE_RETENTION: 'long'
  }
});
```

Use this when one process needs different provider settings per request, or when ambient environment variables should not leak into a provider call. A stored credential's `env` values and the request's `env` merge, with the request winning.

## OAuth Providers

Several providers support OAuth authentication instead of static API keys:

- **Anthropic** (Claude Pro/Max subscription)
- **OpenAI** (Sign in with ChatGPT: uses the ChatGPT subscription with the OpenAI API)
- **OpenAI Codex** (ChatGPT Plus/Pro subscription, access to GPT-5.x Codex models)
- **xAI** (SuperGrok or X Premium, device-code flow)

Each of these providers carries an `OAuthAuth` on `provider.auth.oauth` with three operations: `login(interaction)` uses the provider-neutral `AuthInteraction.prompt()`/`notify()` protocol and returns a credential, `refresh(credential, signal)` refreshes expiring credentials when applicable, and `toAuth(credential)` derives request auth. Provider login interactions and refresh calls always carry a concrete abort signal. Refresh is automatic: `models.getAuth(providerId)` and request paths refresh expired tokens under a credential-store lock, so concurrent requests and processes cannot double-refresh.

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels({ credentials: myStore }); // persistent CredentialStore
models.setProvider(anthropicProvider());

// Login: Models drives the flow and persists the credential
await models.login('anthropic', 'oauth', {
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code prompts race a local callback server; p.signal aborts them when the server wins
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'info' | 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'info') {
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? 'More information'}: ${link.url}`);
    }
    if (event.type === 'auth_url') console.log(`Open: ${event.url}`);
    if (event.type === 'device_code') console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});

// From here on, requests resolve and refresh the token automatically
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
await models.complete(model, context);

// Logout
await models.logout('anthropic');
```

### Programmatic OAuth

Built-in login and refresh flows are private provider implementations. Use provider-owned `OAuthAuth`, which composes with `CredentialStore` and gets locked auto-refresh through `Models`. The `@earendil-works/pi-ai/oauth` entry point retains only type declarations required by coding-agent extension OAuth compatibility.

There is no `pi-ai` login CLI in this package; the app drives `models.login(providerId, 'oauth', interaction)` itself and persists the returned credential through its `CredentialStore`. `LoginOptions.getDeviceId` is called only by flows that need a stable installation id, and `LoginOptions.agentName` sets the name the flow introduces itself with.

Provider notes:

**Anthropic**: `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, or `ANTHROPIC_AUTH_TOKEN` (sent as `Authorization: Bearer`) resolve in that order after a stored credential. Workload identity federation reads `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, plus optional `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID`, and is only used when no key or auth header resolved.

**OpenAI**: Sign in with ChatGPT tokens only reach the Responses API, so the provider hides `gpt-6-luna` from `getAvailableOfType('classifier')` while it uses OAuth.

**OpenAI Codex**: Superseded by Sign in with ChatGPT on the OpenAI provider. Requires a ChatGPT Plus or Pro subscription. Provides access to GPT-5.x Codex models with extended context windows and reasoning capabilities. The library automatically handles session-based prompt caching when `sessionId` is provided in stream options unless `cacheRetention` is `"none"`. You can set `transport` in stream options to `"sse"`, `"websocket"`, or `"auto"` for Codex Responses transport selection. When using WebSocket with a `sessionId` and cache retention enabled, connections are reused per session and expire after 5 minutes of inactivity (or 45 minutes of total age). Call `cleanupSessionResources(sessionId)` when finished so the pooled connection does not keep the process alive.

**xAI**: Uses the OAuth device-code flow, so `login` notifies a `device_code` event and polls instead of opening a callback server.

## Migrating from the Old Global API

Older versions exposed a global API: `stream()`/`complete()` dispatching on `model.api` via a global registry, sync `getModel()`/`getModels()`/`getProviders()` catalog reads, `registerApiProvider()`, `getEnvApiKey()`, and per-API lazy stream functions. That surface lives unchanged on the **compat entrypoint**:

```typescript
// Before
import { getModel, complete } from '@earendil-works/pi-ai';

// After (verbatim behavior, one import-path change)
import { getModel, complete } from '@earendil-works/pi-ai/compat';
```

Compat is a strict superset of the root entrypoint, so a file can switch its import path wholesale. It will be removed in a future release; migrate to `createModels()` + provider factories:

| Old | New |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` or `getBuiltinModel()` from `providers/all` |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()` or `getBuiltin*` |
| `stream(model, ctx, opts)` (env-key injection) | `models.stream(model, ctx, opts)` (provider auth resolution) |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model.provider)` |
| `streamAnthropic(model, ctx, opts)` | `stream` from `@earendil-works/pi-ai/api/anthropic-messages`, or a provider in a collection |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |
| `getImageModel(provider, id)` / `generateImages(model, ctx, { apiKey })` | `models.getModelOfType('image', provider, id)` / `models.generateImages(model, ctx)` |
| `streamGoogle(model, ctx, opts)` | `stream` from `@earendil-works/pi-ai/api/google-generative-ai`, or a provider in a collection |

The separate `ImagesModels`/`ImagesProvider` collection that existed briefly (`createImagesModels()`, `createImagesProvider()`, `builtinImagesModels()`) is gone: image models now live on the regular provider. Replace `builtinImagesModels()` with `builtinModels()`, `imagesModels.getModel()` with `models.getModelOfType('image', ...)`, and `createImagesProvider({ models, api })` with `createProvider({ models, images })`. The old plural image type names are removed; use `ImageModel` and `ImageApi`, and add `type: "image"` to image model literals.

## Development

### Adding a New Provider

Adding a new LLM provider requires changes across multiple files. The layered layout: API implementations live in `src/api/`, provider factories in `src/providers/`, stable generated catalog wrappers live in `src/providers/<id>.models.ts`, and `src/models.generated.ts` registers them. This checklist covers all necessary steps:

#### 1. Core Types (`src/types.ts`)

- Add the API identifier to `KnownApi` (for example `"openai-completions"`), if it is a new API
- Add the provider name to `KnownProvider` (for example `"xai"`)
- Add the options type to `ApiOptionsMap`

#### 2. API Implementation (`src/api/<api-id>.ts`, only for a new API)

Create a new API implementation file (for example `openai-completions.ts`) that exports exactly `stream` and `streamSimple`, plus:

- An options interface extending `StreamOptions` (for example `OpenAICompletionsOptions`)
- Message conversion functions to transform the `TranscriptContext` messages to provider format; read the prompt and tools from the transcript with `getInitialSystemMessage()`, `getCurrentTools()`, and `resolveTranscript()`
- Tool conversion if the provider supports tools
- Response parsing to emit standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

Add a lazy wrapper `src/api/<api-id>.lazy.ts` (`<name>Api()` via `lazyApi()`) so providers can reference the implementation without importing its SDK. Add any root-level `export type` re-exports in `src/index.ts` that should remain available from `@earendil-works/pi-ai`.

#### 3. Model Catalog (`catalog/providers/<id>.ts`)

- Add a provider definition and register it in `catalog/providers/index.ts`; see `catalog/README.md` for the build order and helpers
- Map chat/tool-capable provider data to `Model`, image-generation data to `ImageModel`, and models.dev `type: "decision"` entries to `ClassifierModel`; hydration groups the ignored `src/providers/data/<id>.json` values by API while stable `src/providers/<id>.models.ts` wrappers derive exact model/API types directly from those JSON keys
- Keep model ids unique within each provider and model type; emit separate entries when an upstream model supports multiple operations
- Handle provider-specific quirks (pricing format, capability flags, model ID transformations) in the provider definition

#### 4. Provider Factory (`src/providers/<id>.ts`)

- `createProvider()` wiring catalog + auth + the lazy API wrapper
- Auth: `envApiKeyAuth` for standard key providers, a custom `ApiKeyAuth` for ambient auth, `lazyOAuth` where an OAuth flow exists
- Register the factory in `src/providers/all.ts`
- If it is a new API: register it in the builtin list in `src/compat.ts`; the `./api/*` subpath export in `package.json` already covers the new module

#### 5. Tests (`test/`)

Create or update test files to cover the new provider:

- `stream.test.ts` - Basic streaming and tool use
- `tokens.test.ts` - Token usage reporting
- `abort.test.ts` - Request cancellation
- `empty.test.ts` - Empty message handling
- `context-overflow.test.ts` - Context limit errors
- `unicode-surrogate.test.ts` - Unicode handling
- `tool-call-without-result.test.ts` - Orphaned tool calls
- `image-tool-result.test.ts` - Images in tool results (when the API accepts images)
- `total-tokens.test.ts` - Token counting accuracy
- `cross-provider-handoff.test.ts` - Cross-provider context replay
- `providers.test.ts` - Provider listing and auth resolution

For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.

For providers with non-standard auth, add a small utility module with credential detection helpers and cover it directly.

#### 6. Coding Agent Integration (`../coding-agent/`)

Update `src/core/model-resolver.ts`:

- Add a default model ID for the provider in `defaultModelPerProvider`

Update `docs/models.md`:

- Add setup instructions, the environment variable, and the `auth.json` key

#### 7. Documentation

Update `packages/ai/README.md`:

- Add to the Supported Providers table
- Document any provider-specific options or authentication requirements
- Add environment variable to the Environment Variables section

#### 8. Changelog

Add an entry to `packages/ai/CHANGELOG.md` under `## [Unreleased]`:

```markdown
### Added
- Added support for [Provider Name] provider ([#PR](link) by [@author](link))
```

## License

MIT
