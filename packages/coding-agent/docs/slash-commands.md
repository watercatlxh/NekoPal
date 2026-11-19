# Chat commands

Send a message that starts with `/` and a command name to run a command instead of prompting the
model. Commands run outside the chat's queue, so `/stop` can interrupt a reply that is already
running.

Extensions, prompt templates, and skills add more commands to the same surface: an extension
registers a command, a prompt template becomes one under its filename, and a skill is available as
`/skill:<name>`.

## NekoPal commands

| Command | Description |
|---|---|
| `/help` | List the commands |
| `/status` | Uptime, version, session id, message count, context usage, active chats |
| `/settings` | Model, language, memory usage, pending review count, enabled jobs, channels |
| `/new` | Start a fresh session |
| `/sessions` | List the ten most recent sessions for this chat |
| `/resume <number\|id>` | Switch to a listed session |
| `/stop` | Abort the running reply and clear its queue |
| `/model [provider/id]` | Show the current model and the authenticated providers, or switch |
| `/memory [list]` | Show saved entries and pending suggestions |
| `/memory approve <id\|all>` | Apply pending suggestions |
| `/memory reject <id\|all>` | Discard pending suggestions |
| `/memory forget <n>` | Delete the n-th stored entry from `/memory list` |
| `/jobs [list]` | List scheduled jobs with their next run and status |
| `/jobs add <name> <schedule> <prompt>` | Schedule a prompt |
| `/jobs rm <id>` | Remove a job |
| `/jobs pause <id>`, `/jobs resume <id>` | Enable or disable a job |
| `/lang <en\|zh>` | Switch the reply language for this chat |
| `/login [provider]` | Sign in to a provider |
| `/logout <provider>` | Remove a stored provider credential |
| `/install <source>` | Install a pi package |
| `/remove <source>` | Remove a pi package |
| `/packages` | List installed packages |
| `/cancel` | Cancel a pending question, login, or confirmation |

## Model and settings

`/login` with no argument lists the four OAuth providers. With a provider it starts the sign-in flow:
NekoPal sends an authorization link or device code and then takes the next message as the pasted
redirect URL or code. The flow times out after ten minutes; `/cancel` stops it earlier.

`/model` with no argument prints the current model and thinking level followed by up to ten model IDs
per authenticated provider. `/model <provider/id>` resolves the reference, switches the session, and
writes `defaultProvider` and `defaultModel` to `settings.toml`.

`/settings` is a read-only panel. To change a value, edit `settings.toml` or ask the agent to use the
`config_set` tool.

## Sessions and context

`/sessions` lists the ten most recent sessions for the current chat, newest first, each with its
modification time, the first forty characters of its first message, and the first eight characters of
its id. `/resume` accepts either the list number or an id prefix.

Compaction happens automatically when the context approaches the model's limit; there is no `/compact`
chat command. The [compaction settings](settings.md#compaction) control when. See
[Sessions and Context](sessions.md).

## Memory

`/memory list` prints both stores with a single running number per entry, then any suggestions
awaiting approval. `approve` and `reject` take one id, an id prefix, or `all`. `forget` takes the
number printed by `list`.

Approving a skill suggestion reloads every open chat, because a new skill only enters the index on
reload.

Memory is split into two files under `~/.nekopal`: `MEMORY.md` holds facts about the environment and
`USER.md` holds facts about you. Both are injected into the system prompt within the character budgets
set by [`nekopal.memory`](settings.md#nekopal). The agent writes them directly when you ask it to
remember something; the background review stages its suggestions for approval.

## Scheduled jobs

`/jobs add` takes a name, a schedule, and the prompt to run:

```text
/jobs add morning 0 9 * * * Summarize the open issues and send me the list.
```

Schedules accept `30m`, `2h`, `1d`, `in 30m`, a five-field cron expression, or an ISO timestamp. A
job delivers its reply to the chat that created it. A job that fires more than half its interval late
is marked `missed` and skipped rather than run when the daemon catches up.

## Commands added by resources

- Extensions register commands with their own arguments and completion behavior.
- Each prompt template is available under its filename.
- Skills are available as `/skill:name` when `enableSkillCommands` is on.

Restart the daemon after adding or changing a discovered command resource. `/install` and `/remove`
reload every open chat themselves. See [Extensions](extensions.md), [Prompt Templates](prompt-templates.md),
and [Skills](skills.md) for their loading and naming rules.
