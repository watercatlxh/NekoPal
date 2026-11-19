# Settings Reference

Settings live in `settings.toml`: the global file in the agent directory, and an optional project file
in `<workspace>/.nekopal/settings.toml`. Project settings override global settings; resource lists are
combined. See [Configuration](configuration.md) for file locations and trust behavior.

Writes are atomic, and the previous file is kept as `settings.toml.bak`. Comments are not preserved
across a programmatic write. `write` and `edit` refuse to touch the file; the agent changes settings
through the `config_set` tool, and you can edit it directly while the daemon is stopped or use
`/settings` for the common ones.

## NekoPal

The `[nekopal]` table configures the daemon. It is the only part of the file the daemon itself reads.

```toml
[nekopal]
defaultLang = "en"                 # "en" | "zh"
workspace = "~/.nekopal/workspace" # the agent's working directory

[nekopal.channels.telegram]
enabled = false
botToken = "$TELEGRAM_BOT_TOKEN"   # "$ENV_NAME" or "!command", never a literal
allowedUsers = []                  # Telegram user ids; empty ignores everyone

[nekopal.channels.qq]
enabled = false
appId = ""
appSecret = "$QQ_BOT_SECRET"
allowedOpenIds = []                # QQ openids; empty ignores everyone
stream = true
proactivePerMinute = 18            # 1..20
proactivePerDay = 1000             # 1..1000

[nekopal.memory]
memoryChars = 2200                 # 100..10000
userChars = 1375                   # 100..10000
reviewEveryTurns = 10              # 0 disables the background review
```

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultLang` | `"en" \| "zh"` | `"en"` | Reply language before a chat picks one with `/lang`. |
| `workspace` | string | `~/.nekopal/workspace` | The agent's working directory. `~` expands to the home directory. |
| `channels.telegram.enabled` | boolean | `false` | Start the Telegram adapter. |
| `channels.telegram.botToken` | string | `$TELEGRAM_BOT_TOKEN` | Bot token reference. |
| `channels.telegram.allowedUsers` | integer[] | `[]` | Allowed Telegram user ids. |
| `channels.qq.enabled` | boolean | `false` | Start the QQ adapter. |
| `channels.qq.appId` | string | `""` | QQ bot app ID. |
| `channels.qq.appSecret` | string | `$QQ_BOT_SECRET` | App secret reference. |
| `channels.qq.allowedOpenIds` | string[] | `[]` | Allowed QQ openids. |
| `channels.qq.stream` | boolean | `true` | Stream replies into one QQ message as they arrive. |
| `channels.qq.proactivePerMinute` | integer | `18` | Proactive messages per minute per user, 1–20. |
| `channels.qq.proactivePerDay` | integer | `1000` | Proactive messages per day per user, 1–1000. |
| `memory.memoryChars` | integer | `2200` | Character budget for `MEMORY.md`, 100–10000. |
| `memory.userChars` | integer | `1375` | Character budget for `USER.md`, 100–10000. |
| `memory.reviewEveryTurns` | integer | `10` | Review the conversation every N user turns; `0` disables it. |

Channel and secret changes take effect after the daemon restarts. Memory and workspace changes are
read on next use.

## Model and thinking

<a id="model-cycling"></a>

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultProvider` | string | Automatic | Startup provider. `/model` writes this. |
| `defaultModel` | string | Automatic | Startup model ID. `/model` writes this. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | Startup thinking level. |
| `modelThinkingLevels` | object | None | Per-model startup thinking levels keyed by exact `provider/modelId`. |
| `thinkingBudgets` | object | Built-in budgets | Token budgets for `minimal`, `low`, `medium`, and `high` thinking levels. |
| `enabledModels` | `string[]` | All available models | Model patterns used for startup selection and model cycling. |
| `showCacheMissNotices` | boolean | `false` | Show notices for significant cache misses, successful cache warming, compaction usage, and provider recovery. |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"idle"` | Keep eligible provider prompt caches warm during active runs and, with `"idle"`, for up to 30 minutes between runs. Global setting only. |

Cache warming runs only when the model declares a cache lifetime and the estimated avoided cache-miss
cost is at least $0.05. Refresh usage counts toward session totals but does not enter model context.
Extensions can override the decision with `cache_warming_decision`. See
[Prompt Cache Lifetimes](models.md#prompt-cache-lifetimes).

## Interaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued steering messages are delivered. |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued follow-up messages are delivered. |
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `"ask"` | Fallback project-trust behavior. **Can only be set in the global file.** |

With no interactive prompt, `"ask"` behaves like `"never"`: project resources are skipped.

## Tools

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultTools` | `string[]` | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `memory`, `cron`, `send`, `config_set` | Tools enabled at startup. Plain names replace the defaults; `+name` adds a tool and `-name` removes one. An empty array disables all built-in tools but not extension or SDK tools. |
| `codemode.mode` | `"on"` \| `"only"` | `"on"` | How the `codemode` tool presents tools while it is active. `on`: declared tools get a note on calling them from scripts appended to their description, and `codemode` lists only tools that are not declared. `only`: `codemode` lists every tool scripts can call, and active built-in and extension tools are hidden from the model. |
| `codemode.inlineBudget` | number | `3000` | Estimated tokens (characters / 4) the `codemode` tool's description may spend on tool declarations. Tools that do not fit are found with `searchTools()`. `0` lists only namespaces. |

Available built-in tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`. The
`memory`, `cron`, `send` and `config_set` tools belong to the daemon and are described in the
repository README. `defaultTools` can also name `codemode` and `tool_search`, which the built-in
extensions register inactive, and other extension tools.

A list of only `+name` and `-name` entries changes the inherited selection instead of replacing it.
For example, this enables `codemode` next to the default tools:

```toml
defaultTools = ["+codemode"]
```

This replaces `bash` with `powershell` and enables `grep`:

```toml
defaultTools = ["-bash", "+powershell", "+grep"]
```

Project settings apply on top of global settings: a project list with only `+name` and `-name` entries
changes the selection, and a project list with a plain name replaces it. In one list, plain names form
the selection, and `+name` and `-name` then apply in order.

A restart enables tools newly added to `defaultTools`. It does not re-enable tools you turned off.

## Sessions and context

| Setting | Type | Default | Description |
|---|---|---|---|
| `sessionDir` | string | Agent session directory | Session storage directory. Relative paths resolve from the working directory. `NEKOPAL_SESSION_DIR` overrides this setting. The daemon gives each chat its own directory under `~/.nekopal/sessions/`. |

### Compaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | Enable automatic compaction. |
| `compaction.reserveTokens` | number | `16384` | Free context tokens below which automatic compaction starts. |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens retained without summarization. |
| `compaction.modelOverrides` | object | None | Per-model token settings keyed by exact `provider/modelId`. |

<a id="per-model-compaction-overrides"></a>

Compaction token values must be non-negative safe integers. Each value resolves independently from the
matching model override, then the ordinary compaction setting, then the built-in default. Project and
global objects merge before model lookup.

See [Compaction Reference](compaction.md) for trigger, summarization, and validation behavior.

### Branch summaries

| Setting | Type | Default | Description |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when summarizing branch history. |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the branch-summary prompt and default to no summary. |

## Images

| Setting | Type | Default | Description |
|---|---|---|---|
| `images.autoResize` | boolean | `true` | Resize images to at most 2000 by 2000 pixels before sending them to a model. |
| `images.blockImages` | boolean | `false` | Prevent images from being sent to models. |

## Network and retries

| Setting | Type | Default | Description |
|---|---|---|---|
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | Preferred transport for AI providers that support multiple transports. |
| `httpProxy` | string | None | Proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` for managed HTTP clients. **Can only be set in the global file.** |
| `httpIdleTimeoutMs` | number \| `"disabled"` | `300000` | HTTP header and body idle timeout in milliseconds. Set to `0` or `"disabled"` to disable. |
| `websocketConnectTimeoutMs` | number \| `"disabled"` | `15000` | WebSocket connection timeout in milliseconds. Set to `0` or `"disabled"` to disable. |
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry for transient failures. |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts. |
| `retry.baseDelayMs` | number | `2000` | Initial exponential-backoff delay in milliseconds. |
| `retry.maxAgentDelayMs` | number | `60000` | Maximum agent-level retry delay in milliseconds. |
| `retry.provider.timeoutMs` | number | `httpIdleTimeoutMs` | Provider request timeout in milliseconds. |
| `retry.provider.maxRetries` | number | `0` | Provider-level retry attempts. |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Maximum server-requested delay in milliseconds. Set to `0` to disable the limit. |

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are required. Provider retries can
delay the daemon from handling quota and usage-limit errors itself.

## Shell

| Setting | Type | Default | Description |
|---|---|---|---|
| `shellPath` | string | Platform default | Custom shell executable path. Supports a leading `~`. |
| `shellCommandPrefix` | string | None | Prefix prepended to every shell command. |
| `npmCommand` | `string[]` | `npm` | Command and arguments used for npm package lookup and installation. |

`shellCommandPrefix` runs before every command the model's `bash` tool executes, so it can enable
Bash aliases or export environment variables:

```toml
shellCommandPrefix = "export CI=1"
```

The prefix runs in a non-interactive shell, so keep it fast and free of interactive prompts. See
[pi packages](packages.md) for package-manager behavior.

## Resources

Resource paths in global settings resolve from the agent directory. Paths in project settings resolve
from the project `.nekopal` directory. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---|---|---|---|
| `packages` | array | `[]` | npm, git, or local pi package sources. See [pi packages](packages.md). |
| `extensions` | `string[]` | `[]` | Extension files or directories. |
| `skills` | `string[]` | `[]` | Skill files or directories. |
| `prompts` | `string[]` | `[]` | Prompt-template files or directories. |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands. |

Resource arrays support glob exclusions with `!pattern`, exact inclusion with `+path`, and exact
exclusion with `-path`. Resources listed in both global and project settings are all loaded.

The built-in extensions are named `builtin:mcp`, `builtin:codemode`, and `builtin:tool-search` in
`extensions`. They load by default; `-builtin:mcp` disables one. A `+builtin:<name>` or
`-builtin:<name>` entry in project settings overrides the global setting.

## Warnings

| Setting | Type | Default | Description |
|---|---|---|---|
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn when Anthropic subscription authentication may use paid extra usage. |
