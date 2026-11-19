# Sessions and Context

NekoPal saves each conversation as a session. The active branch of that session supplies conversation
history for the next model request. Use the session commands to continue work, explore another branch,
or reduce the amount of history sent to the model.

## Continue or switch sessions

Sessions are saved automatically, one directory per chat under `~/.nekopal/sessions/<channel>-<chatId>/`.
The daemon resumes the most recent session for the chat when it starts.

- `/new` starts a new session.
- `/sessions` lists the ten most recent sessions for this chat.
- `/resume <number|id>` switches to one of them.

Each session records the working directory it was created in. The daemon always runs sessions in
`nekopal.workspace`, so tools, project configuration, and context files resolve from there.

## Choose how to branch

Entries are stored as a tree, so returning to an earlier point does not erase the branch you leave.
Extensions can call `ctx.navigateTree()`, `ctx.fork()` and `ctx.newSession()`; the daemon has no chat
command for them, so branching is an extension feature rather than a user-facing one.

When a branch is left, the harness can summarize it and attach that summary to the branch you enter.
This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. It is combined with the
system prompt, discovered context files, available tools, and loaded skill descriptions.
[How NekoPal Works](how-pi-works.md#context) describes how those inputs are assembled.

When the active context approaches the model's limit, the harness compacts older history
automatically. Compaction adds a summary and keeps recent messages. It does not delete the original
session entries.

Configure automatic compaction and retained history through [Settings](settings.md#compaction).
Compaction can fail if the provider is unavailable; the next prompt retries it.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary
behavior, and extension hooks.

## Control session storage

Sessions live under `~/.nekopal/sessions/`, one directory per chat. Set `sessionDir` in
[settings](settings.md#sessions-and-context) or the `NEKOPAL_SESSION_DIR` environment variable to move
the root.

Deleting a chat's directory discards its history. `/new` does not delete anything; it starts a new
session next to the old ones.

## Delivery

Replies go back to the chat that produced them. Long replies are split into several messages, preferring
line breaks and keeping code fences balanced.

On Telegram, a reply that would need more than eight messages is delivered as a `reply.md` file instead.
Markdown goes through a MarkdownV2 converter, and a message that cannot be parsed is re-sent as plain
text.

On QQ, replies are split at 3000 characters. Each chunk is sent as markdown and, if the API rejects it,
re-sent as plain text. QQ has no document fallback: a reply too large to split is replaced by a short
notice, and passive reply slots are limited, so an exhausted budget truncates the tail of a long answer.

A message that arrives while a reply is running is queued and acknowledged. `/stop` aborts the running
reply and clears its queue.

## Report a bug

There is no built-in bug-report command. Open an issue on the repository and include the log lines the
daemon writes to stderr.
