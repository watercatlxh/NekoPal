# Run NekoPal safely

Treat model-generated commands and code as untrusted. NekoPal can read, change, and execute files with
the permissions of the account that runs the daemon, and it does not ask before every tool call.
Extensions, package installers, language servers, and other child processes run with those same
permissions unless an operating-system or virtualization boundary restricts them.

Files, comments, instructions, command output, and model responses can steer the model through prompt
injection. Project trust controls which project resources load at startup, but it does not make that
content or the resulting actions safe.

Safety comes from limiting the files, credentials, processes, and network services the daemon can
access and affect if a generated action is wrong or hostile. Reviewing replies and using project trust
do not create a security boundary.

## Choose how to run it

| How it runs | What remains protected |
|---|---|
| Directly, with the permissions of its operating-system user | Anything that user cannot access. A dedicated user account narrows those permissions, but the daemon still shares the operating system and network with other users. |
| Entirely inside a container, virtual machine, or sandbox | Host files and processes you do not expose to the environment. Credentials and network services remain accessible if you make them available inside it. This is usually the strongest practical option. |

The workspace setting controls resource discovery and the default location for tools, but it does not
prevent commands from accessing other paths available to the process.

Whichever option you choose, only provide the files and services required for the task. Keep
credentials outside the environment where possible, or use narrowly scoped, short-lived credentials.
Restrict network access when commands do not need it.

NekoPal runs as a network service. Its allowlist is the only access control: a message from a Telegram
user id or QQ openid that is not listed in `settings.toml` is dropped before it reaches the model.
Keep the allowlist short and review it after changing the bot's visibility.

## Protect the configuration

The `write` and `edit` tools refuse to touch these files:

| Path | Reason |
|---|---|
| `~/.nekopal/settings.toml` | Change settings with the `config_set` tool. |
| `~/.nekopal/settings.toml.bak` | Backup of the previous settings file. |
| `~/.nekopal/auth.json` | Credentials are managed with `/login` and `/logout`. |

This is a guard, not a sandbox: the `bash` tool can still write those paths, and a model that is
determined enough can do so. The guard exists to stop an ordinary edit from corrupting the file the
daemon reads at startup, not to defend against a hostile model.

## Understand project trust

Project trust controls whether the daemon loads most settings and resources supplied by the agent's
working directory. It prevents a folder from silently loading executable extensions before you approve
it.

Project trust is not a complete startup boundary. The project `sessionDir` setting is read while
selecting or creating a session, before project trust is resolved. Declining trust prevents the
remaining project settings and protected resources from loading, but it cannot undo that initial
session-directory lookup.

Project trust does not limit what tool calls can access or affect. After startup, enabled tools still
use the operating-system permissions of the process. Instructions and other content in the folder can
also influence the model.

### Resources protected by project trust

A project-trust decision is required when any of these exist under the workspace:

- `.nekopal/settings.toml`
- `.nekopal/mcp.json`
- `.nekopal/extensions`, `.nekopal/skills`, or `.nekopal/prompts`
- `.nekopal/SYSTEM.md` or `.nekopal/APPEND_SYSTEM.md`
- project `.agents/skills` in the workspace or an ancestor directory

A bare `.nekopal` directory does not require project trust.

Granting project trust allows the daemon to load:

- project settings
- project MCP servers from `.nekopal/mcp.json`
- extensions, skills, prompt templates, and system-prompt files under `.nekopal`
- missing packages configured through project settings
- project-local and project-package extensions

### How a trust decision is made

The daemon has no interactive prompt, so an unresolved decision behaves as `"never"`:

1. An extension can handle the `project_trust` event. The first extension that returns yes or no owns
   the decision.
2. Otherwise a saved decision for the workspace or one of its parents applies.
3. Otherwise `defaultProjectTrust` decides. `"always"` loads project resources; `"ask"` and `"never"`
   skip them.

Saved decisions use canonical directory paths and live in:

```text
~/.nekopal/trust.json
```

An extension that handles `project_trust` is the supported way to grant trust in a headless
deployment. Set `defaultProjectTrust = "always"` only when the workspace is a directory you control.

Context files such as `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` load regardless of project
trust. Treat instructions in a folder as untrusted input even when you decline project trust.

## Reduce impact and improve recovery

These practices do not replace isolation, but they reduce exposure or make recovery easier:

- Give the daemon access only to files and services required for the task.
- Use snapshots, backups, or version control before substantial changes.
- Review extensions and packages before loading them. Extensions execute inside the process.
- Prefer narrowly scoped, short-lived credentials.
- Review diffs and generated output before applying results to another system.
- Review sessions before sharing them. They can contain prompts, tool arguments, command output, file
  contents, and credentials exposed during the conversation.

## Report a security issue

Follow the repository [Security Policy](https://github.com/earendil-works/pi/blob/main/SECURITY.md).
Do not open a public issue for a security-sensitive report.

Expected local-agent behavior, prompt injection from untrusted content, lack of a built-in sandbox,
and behavior from user-installed extensions or skills are generally outside the security boundary
unless the report demonstrates a privilege-boundary bypass or access the local user did not already
have.
