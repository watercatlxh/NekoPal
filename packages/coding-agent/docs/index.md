# NekoPal

NekoPal is a personal assistant that lives in your chat apps. It runs as a single headless daemon on
your own machine and talks to you through a Telegram private chat or a QQ C2C chat. Behind the chat
there is the pi agent harness: file access, shell, skills, bounded memory, scheduled runs and
extensions.

There is no terminal UI and no command-line interface. The daemon reads one
[`settings.toml`](configuration.md), starts the channels that are enabled, and answers messages.
Everything you would otherwise do in a terminal — signing in, changing the model, reviewing memory —
happens with a [chat command](slash-commands.md).

This documentation covers the harness and the daemon internals: configuration, extensions, skills,
sessions, MCP and the SDK. The repository [README](../../../README.md) describes the project as a
whole.

## Start using NekoPal

New here? Follow the [Quickstart](quickstart.md) to build the daemon, configure a channel, and send
the first message.

If NekoPal is already running, choose what you want to do:

- [Chat commands](slash-commands.md) lists every `/command`, including `/login`, `/model`, `/memory`
  and `/jobs`.
- [Choose a model](models.md) covers the four OAuth providers and custom endpoints in `models.json`.
- [Continue or branch a session](sessions.md) to resume earlier conversations.
- [Configure NekoPal](configuration.md) for the data directory, settings, and `[nekopal]` table.
- [Understand how it works](how-pi-works.md), including tools, context, sessions, and the agent loop.

## Customize NekoPal

NekoPal loads pi extensions unchanged, reuses prompt templates, loads skills, and installs pi
packages. Extensions that draw terminal UI are the one exception: the terminal UI package is not
shipped, so an extension that imports it fails to load with an explicit error.

- [Extensions](extensions.md) add tools, commands and event handlers.
- [Skills](skills.md) add task-specific instructions and supporting files.
- [Prompt templates](prompt-templates.md) add reusable message text.
- [pi packages](packages.md) distribute these resources through npm or git.
- [MCP servers](mcp.md) connect external tool servers.

## Embed NekoPal

The harness is a library. Use the [TypeScript SDK](sdk.md) to create and drive agent sessions from
your own Node.js or Bun process.

## Find reference information

Use the reference pages to look up [chat commands](slash-commands.md), [settings](settings.md),
[providers](providers.md), and [environment variables](environment-variables.md).

## Work safely

NekoPal's tools and extensions run with the permissions of the daemon process. It does not ask before
every tool call, and `bash` can write any file the process can write. Review [Security](security.md)
before giving it access to untrusted files, repositories, or unattended automation.
