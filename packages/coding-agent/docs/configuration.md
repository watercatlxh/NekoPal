# Configuration

NekoPal has one user-level configuration directory and an optional project-level one. The user-level
directory is the agent directory, `~/.nekopal` by default. Project configuration lives in `.nekopal`
under the agent's working directory and loads after [project trust](security.md#understand-project-trust)
is granted. The only exception is `sessionDir`, which is read before trust is resolved.

The daemon reads everything from `settings.toml`. Change common preferences with `/settings` in the
chat, or edit the file directly and restart the daemon. Extensions and skills can be reloaded without
a restart.

## Agent directory

The agent directory is shown as `<agent-dir>` below. It defaults to `~/.nekopal`; set the
`NEKOPAL_HOME` environment variable or the SDK's [`agentDir`](sdk.md) option to move it.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.toml` | User-level [settings](settings.md), including preferences, defaults, resource paths, the `[nekopal]` table, and pi package declarations. |
| `<agent-dir>/settings.toml.bak` | Previous version of `settings.toml`, written on every save. |
| `<agent-dir>/mcp.json` | [MCP servers](mcp.md) available in every project. |
| `<agent-dir>/models.json` | [Compatible endpoints, models, and model overrides](models.md#configure-a-compatible-endpoint). |
| `<agent-dir>/auth.json` | Saved OAuth credentials, mode 0600. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories. |
| `<agent-dir>/SYSTEM.md` | Replaces the default system prompt. |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to the system prompt. |
| `<agent-dir>/extensions/` | User [extensions](extensions.md). |
| `<agent-dir>/skills/` | User [skills](skills.md) and supporting files. |
| `<agent-dir>/prompts/` | User [prompt templates](prompt-templates.md). |
| `<agent-dir>/sessions/` | Saved conversations, one directory per chat. |
| `<agent-dir>/trust.json` | Saved project-trust decisions. |

`settings.toml` is written atomically: the previous file is copied to `settings.toml.bak`, then a
temporary file is synced and renamed into place. Comments are not preserved across a programmatic
write. The `write` and `edit` tools refuse to touch `settings.toml`, `settings.toml.bak` and
`auth.json`; the `config_set` tool is the supported way for the agent to change a setting.

## Project `.nekopal` directory

The agent's working directory is `nekopal.workspace`, `~/.nekopal/workspace` by default. Its project
configuration lives in `<workspace>/.nekopal`:

| Path | Responsibility |
|---|---|
| `.nekopal/settings.toml` | Project-level [settings](settings.md), resource paths, and pi package declarations. |
| `.nekopal/mcp.json` | Project [MCP servers](mcp.md). |
| `.nekopal/SYSTEM.md` | Replaces the system prompt for the project. |
| `.nekopal/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.nekopal/extensions/` | Project extensions. |
| `.nekopal/skills/` | Project skills and supporting files. |
| `.nekopal/prompts/` | Project prompt templates. |

For `SYSTEM.md` and `APPEND_SYSTEM.md`, the trusted project file takes precedence over the
corresponding agent-directory file. Files with the same name are not combined.

## Context files

Context files are separate from project `.nekopal` configuration. They load from the agent directory,
the working directory, and its parent directories. A context file applies whenever the agent runs in
its directory or anywhere below it.

An `AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not
suppress context files from the agent directory or other directories.

Context-file discovery does not require project trust.
