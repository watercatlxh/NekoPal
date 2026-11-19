# Providers

NekoPal ships four providers. All of them authenticate with OAuth through `/login` in the chat;
three of them also accept an API key from the environment.

| Provider | Model family | Authentication |
|---|---|---|
| `anthropic` | Claude | `/login anthropic`, or `ANTHROPIC_API_KEY` |
| `openai` | ChatGPT subscription | `/login openai`, or `OPENAI_API_KEY` |
| `openai-codex` | ChatGPT subscription (Codex backend) | `/login openai-codex` |
| `xai` | Grok | `/login xai`, or `XAI_API_KEY` |

Anything else — Gemini, a local model, a gateway — is a custom endpoint in `models.json` (see
[Choose a model](models.md#configure-a-compatible-endpoint)) or a provider extension (see
[Custom providers](custom-provider.md)).

## Authenticate interactively

Run `/login` and pick a provider. NekoPal sends an authorization link or a device code, then waits for
you to paste the final redirect URL or the code back into the chat. Credentials are saved in
[`auth.json`](configuration.md#agent-directory) with mode 0600.

The OAuth callback listens on `127.0.0.1`; when the browser cannot reach the daemon, the pasted
redirect URL completes the flow. Set `NEKOPAL_OAUTH_CALLBACK_HOST` to listen on another interface.

`/cancel` aborts a pending login after ten minutes or on request. Run `/logout <provider>` to remove a
stored credential. This does not unset environment variables, remove authentication from
`models.json`, or revoke the credential at the provider.

`auth.json` contains OAuth tokens. Keep it private and do not commit it.

## Use an API key from the environment

Environment variables are useful when NekoPal should not store the credential. Set the variable in the
daemon's environment or in `~/.nekopal/env`:

```bash
# ~/.nekopal/env
ANTHROPIC_API_KEY=sk-ant-...
```

| Provider | Environment variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| xAI | `XAI_API_KEY` |

Anthropic also recognizes `ANTHROPIC_OAUTH_TOKEN` as an API credential and `ANTHROPIC_AUTH_TOKEN` as
bearer authentication.

With no key or token set, Anthropic uses workload identity federation when
`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE` are
set: the Anthropic SDK exchanges the identity token for a short-lived access token and refreshes it
itself (re-reading the identity token file, so keep that file fresh for long sessions).
`ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID` are passed through when set.

## Load an API key from a command

To use a secret manager without writing the resolved key to disk, set a provider's `key` in
`auth.json` to a command prefixed with `!`:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'anthropic'"
  }
}
```

The command runs when the key is first needed and its standard output is cached for the process
lifetime. Empty output, a timeout, or a nonzero exit leaves the key unresolved until the daemon
restarts.

## Provider-specific notes

A stored API-key credential can include an `env` object. Its values take priority over the process
environment for that provider:

```json
{
  "openai": {
    "type": "api_key",
    "key": "...",
    "env": {
      "OPENAI_ORGANIZATION": "org-..."
    }
  }
}
```

### Anthropic extra usage

When Anthropic subscription authentication may fall back to paid extra usage, the daemon can warn
once. Disable the warning with `warnings.anthropicExtraUsage = false` in [settings](settings.md).
