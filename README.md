# NekoPal

A personal assistant that lives in your chat apps. It runs as a single headless daemon on your own
machine, talks to you through **Telegram DM** or **QQ C2C**, and has the full pi agent harness
behind it: file access, shell, code execution, skills and a schedule.

NekoPal is a fork of [pi](https://github.com/earendil-works/pi). The harness is pi's; the terminal UI,
the CLI, the telemetry and the 39 extra providers are gone, and everything is configured through one
`settings.toml`.

## What it does

- **Chat only.** No terminal UI, no subcommands: the daemon reads `~/.nekopal/settings.toml`, starts
  the channels that are enabled, and answers messages.
- **Provider management.** Open `/settings` → Model → Providers to sign in with OAuth or configure
  a custom API under its own provider ID. Prefer `$ENV` references to posting literal keys in chat.
  For Google Antigravity, the picker loads the signed-in account's roster from Cloud Code Assist.
  The bundled catalog supplies metadata, not evidence that an account can use a model.
- **Bounded memory.** `MEMORY.md` (environment facts) and `USER.md` (who you are) are injected into
  the system prompt within a character budget. A background review proposes new entries every few
  turns; you approve them with `/memory approve`.
- **Skills.** Reusable procedures live in `~/.nekopal/skills/<name>/SKILL.md` and load like any pi
  skill. The agent can write them, the review can propose them.
- **Scheduled runs.** `cron` schedules a prompt (`30m`, `0 9 * * *`, `in 2h`) and delivers the reply
  to the chat that created it.
- **Files both ways.** Images and documents you send are downloaded and handed to the model;
  `send` delivers files back.

## Getting started

```bash
git clone <this repo> NekoPal
cd NekoPal
npm ci
npm run build
node packages/gateway/dist/main.js
```

With no channel configured the daemon exits with code 1 and tells you what to set.

### Configure

`~/.nekopal/settings.toml` (or `$NEKOPAL_HOME/settings.toml`) holds both the pi settings and the
`[nekopal]` table:

```toml
[nekopal]
defaultLang = "en"                 # "en" | "zh"
workspace = "~/.nekopal/workspace" # the agent's working directory

[nekopal.channels.telegram]
enabled = true
botToken = "$TELEGRAM_BOT_TOKEN"   # "$ENV_NAME" or "!command", never a literal
allowedUsers = [123456789]         # Telegram user ids; empty ignores everyone

[nekopal.channels.qq]
enabled = false
appId = ""
appSecret = "$QQ_BOT_SECRET"
allowedOpenIds = []
stream = true

[nekopal.memory]
memoryChars = 2200
userChars = 1375
reviewEveryTurns = 10              # 0 disables the background review
```

Secrets are references, not values: `$NAME` reads an environment variable and `!cmd` runs a command.
The daemon resolves them at startup and refuses to start a channel whose secret resolves to empty.
A systemd deployment keeps them in `~/.nekopal/env` (see `deploy/nekopal.service`).

Then open `/settings` in chat and select a configured model.

## Commands

| Command | Effect |
|---|---|
| `/help` | List the commands |
| `/status` | Uptime, session, context usage, active chats |
| `/settings` | Open Sessions, Model, Memory, Jobs, or System status |
| `/new`, `/sessions`, `/resume <n\|id>` | Start a fresh session, list recent ones, switch to one |
| `/stop` | Abort the running reply |
| `/model [provider/id]` | Open the model and thinking-level menu, or switch directly to a named model. Selecting a thinking level also saves the default. |
| `/memory [list\|approve\|reject\|forget]` | Review and edit saved memories |
| `/jobs [list\|add\|rm\|pause\|resume]` | Manage scheduled jobs |
| `/settings lang <en\|zh>` | Switch the chat language; also available in System status |
| `/settings format rich\|mdv2` | Telegram only: choose the format for ordinary replies starting with the next run |
| `/packages` | Open the package list and install or remove an extension |
| `/cancel` | Cancel a pending question, custom API wizard, or login |

The agent also has four tools of its own: `memory`, `cron`, `send` and `config_set`. `config_set`
is the only way to change `settings.toml` — the file, its backup and `auth.json` are write-protected
for the `write` and `edit` tools.

## Layout

```
packages/gateway/        the daemon: channels, chats, commands, memory, cron
packages/coding-agent/   the harness: sessions, tools, compaction, extensions, TOML settings
packages/ai/             providers and model catalog
packages/agent/          agent runtime
packages/{telemetry,schema,codemode,mcp}/   supporting libraries
deploy/nekopal.service   systemd unit
```

Internal package names stay `@earendil-works/pi-*` so pi extensions load unchanged. Only
`@nekopal/gateway` is new, and every package is `private`.

## Data directory

```
~/.nekopal/
├── settings.toml, settings.toml.bak
├── auth.json                 provider credentials
├── state.json                chat languages, Telegram offset, QQ quotas
├── SOUL.md                   optional persona text
├── MEMORY.md, USER.md        bounded memory
├── memory/pending/           review suggestions awaiting approval
├── skills/<name>/SKILL.md
├── cron/jobs.json
└── sessions/<channel>-<chatId>/
```

## Development

```bash
npm run build                  # every package, including the gateway
npm test                       # workspace test suites
node scripts/biome-check.mjs   # lint and format
```

The gateway's own tests cover the MarkdownV2 renderer (ported from hermes and differential-tested
against it), message splitting, the memory store, cron scheduling, TOML settings, the dispatcher,
QQ reply budgets and pi extension compatibility.

## Limits

- `bash` can still write a protected file; only `write` and `edit` are guarded.
- QQ file uploads stop at 5 MB (no chunked upload), and QQ has no message deletion.
- Extensions that import `@earendil-works/pi-tui` fail to load with an explicit error, since NekoPal
  ships no terminal UI.

## License

MIT, inherited from pi.
