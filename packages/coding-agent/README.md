# @earendil-works/pi-coding-agent

The headless agent harness behind NekoPal: sessions, tools, compaction, extensions, skills and
`settings.toml` configuration.

This package used to ship the `pi` terminal UI and CLI. NekoPal has no terminal UI: the daemon in
[`packages/gateway`](../gateway) drives the harness through
[`createAgentSessionRuntime`](src/core/agent-session-runtime.ts) and the extension API, and every
user-facing surface is a chat message. What remains here is the library.

## What it provides

- **Sessions** — one conversation per chat, stored as JSONL under a session directory, resumable and
  compactable. `SessionManager` reads, appends and lists them.
- **Tools** — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, plus the extension tool registry.
  `core/tools/protected-paths.ts` lets a host refuse writes to specific files.
- **Extensions** — the full pi extension API: hooks, tools, commands, flags, shortcuts, renderers.
  Non-TUI extensions load unchanged; one that imports `@earendil-works/pi-tui` fails with an explicit
  error instead of silently doing nothing.
- **Skills, prompt templates, MCP, codemode, tool search** — the same implementations pi ships.
- **Settings** — a single `settings.toml` (global, plus a project `.nekopal/settings.toml`), written
  atomically with a `.bak` copy. `getNekoPal()` returns the `[nekopal]` table merged over its
  defaults.
- **Model runtime** — OAuth logins for `anthropic`, `openai`, `openai-codex` and `xai`, custom
  endpoints through `models.json`, and no network call outside a login.

## Use it

```ts
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const settingsManager = SettingsManager.create(process.cwd(), agentDir);
const modelRuntime = await ModelRuntime.create({});
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
await loader.reload();

const { session } = await createAgentSession({
	cwd,
	agentDir,
	settingsManager,
	modelRuntime,
	resourceLoader: loader,
	sessionManager: SessionManager.continueRecent(cwd, sessionDir),
});

session.subscribe((event) => {
	// text deltas, tool starts, message ends: everything a chat surface needs
});
await session.prompt("Summarize today's changes");
```

Every path in the harness comes from `getAgentDir()`: `NEKOPAL_HOME` when set, `~/.nekopal` otherwise.

## Documents

The docs under [`docs/`](docs/index.md) describe the parts that survive: extensions, skills, prompt
templates, packages, settings, sessions, compaction, MCP, codemode and the SDK. Pages about the
terminal UI, keybindings, themes and the CLI are leftovers from pi and describe features this
package no longer has.

## License

MIT.
