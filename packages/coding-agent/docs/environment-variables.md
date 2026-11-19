# Environment Variables

NekoPal uses environment variables in three ways:

- Variables such as `NEKOPAL_OFFLINE` configure the daemon process.
- The daemon reads its channel secrets from variables referenced in `settings.toml`.
- Commands run by the model's `bash` tool receive `PI_*` variables describing the current session.

Provider credentials are documented in [Providers](providers.md#use-an-api-key-from-the-environment).

## Channel secrets

`settings.toml` never holds a literal secret. Values such as `botToken` and `appSecret` are resolved
at startup from either form:

| Form | Meaning |
|---|---|
| `$NAME` or `${NAME}` | Read the environment variable `NAME`. |
| `!command` | Run the command and use its trimmed standard output. |

The daemon refuses to start a channel whose secret resolves to empty and says which variable to set.
`deploy/nekopal.service` reads the variables from `~/.nekopal/env`, so a systemd deployment keeps them
out of the unit file.

```bash
# ~/.nekopal/env
TELEGRAM_BOT_TOKEN=123456:ABC...
QQ_BOT_SECRET=...
```

## Shell Tool Session Environment

Commands run by the `bash` tool receive the current session state:

| Variable | Description |
|----------|-------------|
| `PI_SESSION_ID` | Current session ID |
| `PI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `PI_PROVIDER` | Currently selected model provider |
| `PI_MODEL` | Currently selected model ID |
| `PI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The names keep the `PI_` prefix so scripts written for pi keep working. The values are resolved when
each command starts, so switching models affects the next shell command without a restart.
`PI_PROVIDER` and `PI_MODEL` identify the selected model, not a different upstream model that a router
may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer
from the system prompt:

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

### Custom Shell Tools

Tools created with `createBashTool()` expose the session environment by default when registered with a
session. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, inherited values for these variables are removed so nested processes do not expose
stale parent-session metadata.

## NekoPal Process Configuration

These variables are read by the daemon or the harness itself:

| Variable | Description |
|----------|-------------|
| `NEKOPAL_HOME` | Override the agent directory; default is `~/.nekopal`. |
| `NEKOPAL_SESSION_DIR` | Override the session storage directory. |
| `NEKOPAL_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths. |
| `NEKOPAL_OFFLINE` | Disable network access for package installs and model catalog refreshes. |
| `NEKOPAL_CODEMODE_MAX_WORKERS` | Maximum codemode workers alive at once across all sessions in the process; default `2`. Each worker's script may use up to 256 MB. See [Codemode](codemode.md). |
| `NEKOPAL_OAUTH_CALLBACK_HOST` | Interface for the local OAuth callback listener; default `127.0.0.1`. |
| `NEKOPAL_TIMING` | Set to `1` to log per-request timing. |
| `NEKOPAL_EXPERIMENTAL` | Set to `1` to enable experimental harness features. |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests. |

`PI_CACHE_RETENTION` is still read by the provider API implementations: set it to `long` for extended
prompt caching where supported.

Provider credentials such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are listed in
[Providers](providers.md#use-an-api-key-from-the-environment).
