# Skills

Skills give the agent specialized instructions and supporting files for a particular kind of work.
NekoPal advertises each available skill by name and description, then loads its full instructions only
when the task calls for them.

Use a skill when a workflow needs more context than a prompt template but does not need a new executable integration point. Skills can bundle scripts, references, and assets alongside their instructions.

The harness implements the [Agent Skills specification](https://agentskills.io/specification). Most
invalid fields produce warnings rather than stopping startup.

## Create a skill

A skill is a directory containing `SKILL.md`:

```text
pdf-tools/
├── SKILL.md
├── scripts/
│   └── extract.sh
├── references/
│   └── formats.md
└── assets/
    └── template.json
```

Start `SKILL.md` with frontmatter followed by direct instructions:

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run scripts relative to this skill directory.
```

The description determines when the model considers loading the skill. State both what the skill does and when it applies. Avoid descriptions such as “Helps with PDFs,” which do not provide enough routing information.

Use relative paths from the skill directory when referring to bundled files. The harness tells the
model where the skill lives so it can resolve those paths.

## Understand how skills load

At startup, the harness scans configured skill locations and adds each skill’s name, description, and
path to the system prompt. It does not add the full instructions.

When a task matches, the model reads `SKILL.md` and follows its instructions. This keeps detailed guidance out of context until it is needed. A model might fail to load a relevant skill, so use `/skill:name` when you need to force it.

Arguments after `/skill:name` are appended to the loaded instructions as a user request:

```text
/skill:pdf-tools extract report.pdf
```

Set `disable-model-invocation: true` in frontmatter when a skill should be available only through its
explicit command. The `enableSkillCommands` [setting](settings.md) controls whether skill commands are
registered; manually entered `/skill:name` commands still work.

<a id="choose-where-it-loads"></a>

## Add it to NekoPal

Place the skill in your global or project skills directory (`~/.nekopal/skills/` or
`<workspace>/.nekopal/skills/`). Directories containing `SKILL.md` are discovered recursively.

The Agent Skills locations `~/.agents/skills/` and `.agents/skills/` are also supported. Project
`.agents/skills/` directories are discovered from the working directory through its ancestors, stopping
at the repository root when one exists.

The agent can write skills itself: a `memory` tool call with `target: "skill"` creates
`~/.nekopal/skills/<name>/SKILL.md`, and a skill suggestion from the background review is applied by
`/memory approve`. A new skill enters the index on the next session or 

A directory containing `SKILL.md` is the portable form and should be preferred. See
[Settings](settings.md#resources) and [pi packages](packages.md) for additional locations.

Project skills can instruct the model to run scripts or modify files. Review unfamiliar skills and
their supporting files before granting project trust.

## Write portable frontmatter

The Agent Skills specification defines these fields:

| Field | Purpose |
|---|---|
| `name` | Command and display name |
| `description` | Routing description shown to the model |
| `license` | License name or bundled license file |
| `compatibility` | Environment requirements |
| `metadata` | Additional key-value metadata |
| `allowed-tools` | Experimental pre-approved tool list |
| `disable-model-invocation` | Hide the skill from automatic model selection |

Names use lowercase letters, numbers, and hyphens, with no leading, trailing, or consecutive hyphens. They can contain at most 64 characters; descriptions can contain at most 1024.

NekoPal neither requires nor warns when the declared name differs from the parent directory. Other
Agent Skills implementations may enforce that requirement, so matching names remain the portable
choice.

Malformed `SKILL.md` files and declared skills without descriptions are not loaded. Name collisions keep the first discovered skill and produce a warning.

## Validate and share a skill

Check the daemon's stderr for skill diagnostics after a restart, or send `/skill:name` to force the
skill. Restart the daemon after editing a skill.

Use a [pi package](packages.md) to distribute one or more skills through npm or git. Keep environment
setup inside the skill and declare any required runtime dependencies in the package.

For examples, see the [Anthropic skills collection](https://github.com/anthropics/skills).
