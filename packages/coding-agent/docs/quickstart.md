# Quickstart

NekoPal runs as a daemon on a machine you control and answers you through Telegram or QQ. It works
with files on that machine and needs a model, which you reach through one of four OAuth providers.

You need Node.js 22.19 or newer and a Telegram bot token or a QQ bot app ID and secret. Nothing else
is installed globally.

## 1. Build it

```bash
git clone <repository> NekoPal
cd NekoPal
npm ci
npm run build
```

`npm run build` compiles every workspace package, including the gateway that contains the daemon
entry point.

## 2. Configure a channel

The daemon reads `~/.nekopal/settings.toml` (or `$NEKOPAL_HOME/settings.toml`). Create it with at
least one channel enabled:

```toml
[nekopal]
defaultLang = "en"
workspace = "~/.nekopal/workspace"

[nekopal.channels.telegram]
enabled = true
botToken = "$TELEGRAM_BOT_TOKEN"
allowedUsers = [123456789]
```

`botToken` is a reference, not a value: `$NAME` reads an environment variable and `!command` runs a
command. Put the real secret in the environment or in `~/.nekopal/env`:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...
```

`allowedUsers` is the static allowlist of Telegram user ids. A message from anyone else is dropped,
so an empty list ignores every message.

For QQ, set `[nekopal.channels.qq]` with `enabled`, `appId`, `appSecret` and `allowedOpenIds`
instead. See [Configuration](configuration.md) for every key.

## 3. Start the daemon

```bash
node packages/gateway/dist/main.js
```

With no channel enabled it exits with code 1 and says which setting to change. On a server, run it
under systemd with `deploy/nekopal.service`; that unit reads secrets from `~/.nekopal/env`.

## 4. Sign in from the chat

Send the bot a message. The first thing to do is sign in to a model provider:

```text
/login
```

NekoPal lists `anthropic`, `openai`, `openai-codex` and `xai`. Pick one and it sends an authorization
link. Open the link, finish the flow, and paste the final redirect URL or the code back into the chat.
The warning in that message is literal: the pasted code stays in the chat history. Credentials are
stored in `~/.nekopal/auth.json` with mode 0600.

`/cancel` aborts a pending login. `/logout <provider>` removes a credential.

## 5. Ask for something

Send a normal message. NekoPal shows each file read, command and edit it performs; it does not ask
before every tool call.

```text
Summarize the last 200 lines of /var/log/nginx/error.log and tell me what to fix.
```

```text
Remember that I prefer short answers.
```

If a reply is already running, a second message is queued and acknowledged; `/stop` aborts the
running reply.

## Continue later

Sessions are saved per chat under `~/.nekopal/sessions/`. `/new` starts a fresh one, `/sessions` lists
recent ones, and `/resume <number|id>` switches back. See [Sessions and Context](sessions.md).

## Next steps

- [Chat commands](slash-commands.md) lists everything NekoPal understands.
- [Configuration](configuration.md) covers the data directory, settings and the `[nekopal]` table.
- [Choose a model](models.md) explains OAuth sign-in and custom endpoints.
- [Security](security.md) explains what the daemon can reach on your machine.

### Choose how to customize NekoPal

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Persistent instructions for the agent | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the chat | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [pi package](packages.md) |

## Remove it

Stop the daemon and delete the checkout. Configuration, credentials, sessions, memory and installed
packages live in `~/.nekopal` and stay until you delete that directory.
