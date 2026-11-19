# How NekoPal Works

NekoPal coordinates model requests, tool execution, context assembly, and session storage. A session
is the record of a conversation, including messages, tool calls and results, model changes,
compactions, and other events.

Messages and events in a session form a tree. Each path through that tree is a branch. The branch
ending at the current entry is the active branch and supplies the history for the next model request.

## Agent loop

A submitted message is added to the active branch. The harness builds a model request from the system
prompt, active branch, available tools, and model settings, then sends it through the selected
provider.

The provider streams an assistant response, which can contain text and tool calls. The harness records
the response, executes each tool call, and records the results. That completes one turn. If tool
results or queued messages require another model request, it starts another turn. Otherwise, the run
ends.

Steering messages enter after the current assistant turn. Follow-up messages enter after the agent has
finished its pending work. `/stop` aborts the current run and clears queued messages.

## Context

The active branch supplies conversation history. The harness converts its session entries into
model-compatible user, assistant, and tool-result messages.

The system prompt is assembled from base instructions, discovered context files, and the sections the
daemon injects: the persona from `SOUL.md`, the memory files, a description of the chat channel, and
the scheduled-job text when a job triggered the run. The request also carries tool definitions and
skill descriptions.

Full skill instructions are loaded on demand. Extensions can add instructions or transform context.

Prompt templates expand chat input before it becomes a user message. Files and images you send become
message content.

## Sessions

Persistent sessions are JSONL files. Each tree entry has an ID and refers to its parent. The current
entry identifies the active branch.

Model context is reconstructed from the active branch. Compaction inserts a summary entry that
replaces older messages in subsequent model requests. The original entries remain in the session tree.

## The daemon

The daemon in `packages/gateway` is the only entry point. It:

1. Reads `~/.nekopal/settings.toml` and starts the adapters whose channels are enabled.
2. Keeps one chat context per `<channel>-<chatId>`, each with its own session and runtime.
3. Routes inbound messages through the allowlist, then a pending question, then the command table, and
   finally the model.
4. Delivers replies, splitting or downgrading them as the channel requires.

A chat's work is serialized: a message that arrives while a reply runs is queued rather than
interleaved. Commands run outside that queue so `/stop` can interrupt a reply.

The daemon also owns the features layered on the harness: bounded memory, scheduled jobs, the `send`
tool for files, and `config_set` for settings changes.

## Extensions and resources

Extensions are TypeScript modules loaded into the daemon process. Their factory functions register
tools, commands, shortcuts, providers, event handlers, and renderers.

Extensions receive `ctx.mode === "rpc"` and `ctx.hasUI === true`: dialogs become chat questions and
`notify` becomes a chat message, so an extension written for pi's RPC mode works unchanged. An
extension that imports `@earendil-works/pi-tui` fails to load, because the terminal UI package is not
shipped.

Skills provide on-demand instructions and supporting files. Prompt templates provide reusable message
text. pi packages distribute these resources through npm or git.

## Trust and permissions

Project trust is resolved before project settings and resources load. After the trust decision and
project-resource loading, context files load. Enabled tools use the operating-system permissions of the
daemon process. Extensions execute inside that process.
