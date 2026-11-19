# Prompt Templates

Prompt templates turn Markdown files into reusable `/` commands. Use one when you want to reuse the same
prompt without adding executable behavior or a larger set of supporting instructions.

A template can accept arguments. NekoPal loads templates from global configuration, project
configuration, an explicit path, or a pi package. Project configuration loads only after project trust
is granted.

## Create a template

Create `~/.nekopal/prompts/review.md`:

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes. Focus on ${1:-correctness, security, and error handling}.
```

The filename becomes the command name, so this template is available as `/review`. If `description` is
omitted, the first non-empty line is used.

`argument-hint` is optional. Use `<angle brackets>` for required arguments and `[square brackets]` for optional arguments.

Restart the daemon after adding or changing a template.

<a id="invoke-a-template"></a>

## Use a template

Send the template command in the chat:

```text
/review
/review concurrency
```

The template is expanded before the resulting text enters the agent. Extensions receive the raw input
first through the `input` event unless an extension command with the same name handles it.

Templates support these substitutions:

| Syntax | Result |
|---|---|
| `$1`, `$2`, … | One positional argument |
| `$@` or `$ARGUMENTS` | All arguments joined with spaces |
| `${1:-default}` | First argument, or a default value |
| `${@:-default}` | All arguments, or a default value |
| `${@:N}` | Arguments starting at position `N` |
| `${@:N:L}` | `L` arguments starting at position `N` |

Arguments follow shell-like quoting, so `/review "API compatibility"` supplies one argument containing a space. A quote only starts quoting at the beginning of an argument, so apostrophes inside words such as `doesn't` stay as text, and a quote with no closing match is kept as text. Inside a quoted argument, a backslash before the same quote character keeps it as text, so `/review "the \"fast\" path"` supplies `the "fast" path`; other backslashes are kept as typed.

<a id="choose-where-it-loads"></a>

## Add it to NekoPal

Place the template in your global or project prompt directory (`~/.nekopal/prompts/` or
`<workspace>/.nekopal/prompts/`). Conventional prompt directories load direct `.md` children only.

Settings and packages can select nested Markdown files; a package manifest can narrow discovery with explicit paths and globs. See [Settings](settings.md#resources) and [pi packages](packages.md) for these options.

Project templates become commands after trust is granted. Review their content before trusting an unfamiliar project. See [Security](security.md#understand-project-trust).
