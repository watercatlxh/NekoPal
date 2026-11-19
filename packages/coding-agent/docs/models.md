# Choose a Model

NekoPal ships four providers, all authenticated through OAuth: `anthropic`, `openai`,
`openai-codex`, and `xai`. Start with `/login`, then choose a model with `/model`. Use custom model
configuration only when you need an endpoint NekoPal does not include, such as a local model, Gemini,
or a proxy.

## Choose a connection

| What you have | Recommended setup |
|---|---|
| A Claude subscription | `/login anthropic` |
| A ChatGPT subscription | `/login openai` or `/login openai-codex` |
| A Grok subscription | `/login xai` |
| A provider API key | Set its environment variable (see [Providers](providers.md#use-an-api-key-from-the-environment)) |
| A local model (Ollama, LM Studio, vLLM, llama.cpp) | Add it to `models.json` |
| An OpenAI-, Anthropic-, or Google-compatible endpoint | Add it to `models.json` |
| A provider with a custom protocol or authentication flow | Build or install a provider extension |

The model catalog is bundled with the package; the daemon makes no catalog request at startup.

## Authenticate

Run `/login` in the chat and pick a provider. NekoPal sends an authorization link, and you paste the
final redirect URL or the code back into the chat. Credentials land in
[`auth.json`](configuration.md#agent-directory) with mode 0600. Run `/logout <provider>` to remove
them.

You can instead provide an API key through the provider's environment variable, which is useful when
the daemon should not write credentials. [Providers](providers.md) lists the variables.

When several credential sources are configured, a stored `auth.json` credential wins, then an
`apiKey` from `models.json`, then the provider's environment variables.

Keep `auth.json` and any credential commands private. Review [Security](security.md) before loading
configuration from a directory you do not control.

## Select a model

Run `/model` to list the models whose providers have usable authentication, grouped by provider. Run
`/model <provider/id>` to switch. The choice is persisted to `settings.toml` as `defaultProvider` and
`defaultModel`, so it survives a restart.

A session records model changes. Resuming the session restores them without changing the defaults for
new sessions.

## Configure a compatible endpoint

Use [`models.json`](configuration.md#agent-directory) when an endpoint speaks an API NekoPal already
supports. This covers most Ollama, LM Studio, vLLM, SGLang, and proxy deployments, and Gemini through
its native API.

```json
{
  "$schema": "https://nekopal.local/schemas/models.schema.json",
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The dummy key makes the model available; Ollama ignores it. For an authenticated endpoint, `apiKey`
and header values can use `$NAME` or `${NAME}` environment interpolation, a literal value, or a
leading `!command`. `$$` and `$!` produce a literal `$` and `!`. Commands in `models.json` run at
request time and are not cached.

The `api` field selects the wire protocol. The protocols available for custom endpoints are
`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, and
`openai-decisions`.

A `models` entry adds or replaces a model with the same ID on that provider. Use `modelOverrides` to
change metadata for an existing built-in or extension-provided model without replacing the provider's
model list. Unknown override IDs are ignored.

To route a built-in provider through a proxy, set only its `baseUrl`. Its models and authentication
stay unchanged:

```json
{
  "providers": {
    "anthropic": { "baseUrl": "https://proxy.example.com/v1" }
  }
}
```

`models.json` is read when the session starts and when the file changes on reload.
[Models Configuration](models-configuration.md) lists every field.

### Use Gemini

Google is not a built-in provider. Add it under a provider key of your choice with the
`google-generative-ai` API:

```json
{
  "providers": {
    "google": {
      "api": "google-generative-ai",
      "apiKey": "$GEMINI_API_KEY",
      "models": [
        { "id": "gemini-2.5-pro", "contextWindow": 1048576, "maxTokens": 65536 }
      ]
    }
  }
}
```

### Describe model input and caching

Use `inputLimits.images.resize` to control how images from chat attachments and `read` results are
encoded before they enter conversation history:

```json
{
  "id": "vision-model",
  "input": ["text", "image"],
  "inputLimits": {
    "images": {
      "resize": {
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxBytes": 524288,
        "jpegQuality": 75
      }
    }
  }
}
```

`maxBytes` limits the base64-encoded payload. Omitted resize fields use conservative defaults of 2000
by 2000 pixels, 4.5 MiB encoded, and JPEG quality 80. Images are encoded once; changing models does
not rewrite historical images.

<a id="prompt-cache-lifetimes"></a>

Use `promptCache` to declare the provider's best-effort cache lifetime in seconds for the `short` or
`long` retention tier:

```json
{ "id": "claude-sonnet-5", "promptCache": { "short": 300, "long": 3600 } }
```

Choose the conservative end of any published range. A model without a lifetime for the active tier is
not eligible for cache warming. A `modelOverrides` entry can set `inputLimits` or `promptCache` for a
built-in or extension model, including a model accessed through a validated proxy. See
[`cacheWarming`](settings.md#model-and-thinking).

### Configure sampling by thinking level

OpenAI-compatible APIs support free-form `samplingParams` model defaults and
`samplingParamsByThinkingLevel` overrides. The latter uses NekoPal thinking-level keys (`off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`), not provider values from
`thinkingLevelMap`:

```json
{
  "id": "qwen-thinking-model",
  "reasoning": true,
  "samplingParams": {
    "temperature": 1.0,
    "top_p": 0.95
  },
  "samplingParamsByThinkingLevel": {
    "off": {
      "temperature": 0.7,
      "top_p": 0.8
    },
    "high": {
      "top_k": 20
    }
  }
}
```

Unsupported thinking levels are clamped first, then model `samplingParams`, the effective level's
override, and request-level `samplingParams` merge in that order. Later values win per key. Missing
levels inherit the model defaults. `modelOverrides` merges per-level entries per key with the base
model. These fields apply only to `openai-completions` and `openai-responses`; other APIs ignore them.

Compatibility settings should describe verified differences in the endpoint's request or response
behavior. Do not enable them based only on an endpoint advertising OpenAI or Anthropic compatibility.

## Use classifier models

Classifier models do not chat. They answer typed questions about JSON state: pick one of several
choices, answer yes or no, or give a score, each with probabilities. The bundled catalog contains
OpenAI's GPT-6 Luna through the [Decisions API](https://developers.openai.com/api/docs/guides/decisions),
which needs an `OPENAI_API_KEY`; a ChatGPT sign-in does not work with it, so `gpt-6-luna` is not
listed as available while `openai` is logged in through `/login`. Log out of `openai` to use the key.

Classifier models do not appear in `/model`. The model reaches them through the
[`codemode`](codemode.md) tool. Enable it with `"defaultTools": ["+codemode"]` in
[settings](settings.md#tools). Scripts then list classifier models with
`models.getAvailableOfType("classifier")` and call `models.classify(model, { state, questions })`:

```js
const luna = await models.getModelOfType("classifier", "openai", "gpt-6-luna");
const result = await models.classify(luna, {
  state: { message: "The change works, thanks." },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the user approve of the result?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
});
return result.answers;
```

[Codemode](codemode.md#classify) describes the question and answer types.

Classifier models whose `input` includes `"image"` also judge images passed in `images`; other
classifier models return an error for them. `gpt-6-luna` takes text and images.

When the service reports token counts, `result.usage` carries them with their cost. The usage of a
script's classifier calls is added to the `codemode` tool result, so it counts toward the session
cost.

Extensions call classifiers through `ctx.modelRegistry.classify()`, without codemode.
[Virtual models](virtual-models.md#route-requests) can use them to route requests; see the
`jev-router.ts` example.

## Add a custom provider

Use an extension when the provider needs custom streaming, model discovery, or authentication
behavior. See [Custom Providers](custom-provider.md) for the extension workflow.

## Troubleshooting

### A model does not appear

Confirm that its provider has usable authentication. Custom models can load from `models.json` but
remain unavailable in `/model` until credentials resolve.

### A compatible endpoint rejects requests

Check its API type and compatibility settings in `models.json`. The upstream server must support the
corresponding request fields and behavior.

### Sign-in opens a browser on the wrong machine

The OAuth callback listens on `127.0.0.1` by default. On a remote machine the browser cannot reach it,
so NekoPal always accepts the final redirect URL or the code pasted into the chat. Set
`NEKOPAL_OAUTH_CALLBACK_HOST` if the callback should listen on another interface.
