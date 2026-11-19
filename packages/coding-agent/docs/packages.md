# pi packages

A pi package installs and distributes extensions, skills, and prompt templates as one unit. Use a
package when a customization should be shared through npm or git, or when several resources belong
together.

A package is an ordinary directory or npm package. It can expose conventional resource directories, declare explicit paths under the `pi` key in `package.json`, and carry its own runtime dependencies.

## Install and manage packages

Install from npm, git, or a local path, from the chat:

```text
/install npm:@example/pi-tools@1.0.0
/install git:github.com/example/pi-tools@v1
/install ./local-package
```

`/packages` lists configured packages and `/remove <source>` removes one. After an install or removal
the daemon reloads every open chat, so the new resources are live without a restart.

If a configured package fails to install at startup, for example because npm cannot reach the registry,
NekoPal logs it, skips that package's resources, and keeps running. It tries again on the next start or


Installs are written to `~/.nekopal/settings.toml`. A package declared in a project
`.nekopal/settings.toml` is installed and loaded only after project trust is resolved. Packages can
execute extension code and can include skills that instruct the model to run programs. Review
third-party package source before installing it, and review project package declarations before
granting project trust.

To try a package without installing it, list it in `extensions` as a path or add it to `packages` and
remove it later. NekoPal has no one-shot flag because it has no command line.

Packages are cached under `~/.nekopal/tmp/extensions/` and checked on every start. An npm
package is reinstalled when the registry has a newer version that matches the specification. A version
pinned to an exact number, such as `@1.2.3`, is not checked. A git package is fetched and reset to the
remote branch or ref. A ref that is a commit hash already checked out is not fetched. If the check
fails or `NEKOPAL_OFFLINE` is set, the cached copy loads.

## Choose a source

| Source | Example | Behavior |
|---|---|---|
| npm | `npm:@example/pi-tools@1.0.0` | Installed under the NekoPal npm directory |
| git | `git:github.com/example/pi-tools@v1` | Cloned and reconciled to the selected ref |
| URL | `https://github.com/example/pi-tools` | Treated as a git source |
| Local | `./pi-tools` | Loaded from the resolved path without copying |

Versioned npm specifications are pinned. Git tags and commits are also pinned; package updates
reconcile the checkout but do not move a configured ref.

Relative local paths resolve from the settings file that contains them. A file path loads one
extension. A directory follows normal package discovery rules.

## Create a package

The simplest package uses conventional directories:

```text
my-pi-package/
├── package.json
├── extensions/
├── skills/
└── prompts/
```

Without a `pi` manifest, NekoPal discovers TypeScript and JavaScript extensions, skill directories, and
Markdown prompts from those directories.

Use an explicit manifest when resources live elsewhere or need filtering:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"]
  }
}
```

Paths are relative to the package root. Arrays accept glob patterns and exclusions. List dot-prefixed or symlinked resource roots directly when traversal through a glob would not discover them.

The `pi-package` keyword marks an npm package as a pi package; NekoPal does not require it, but it keeps
the package discoverable by pi tooling.

## Declare a changelog

NekoPal does not display package changelogs, but it reads the manifest field. Point `pi.changelogPath`
at a file inside the package, or set it to `""` to disable changelog discovery:

```json
{
  "name": "my-pi-package",
  "version": "1.2.0",
  "pi": {
    "changelogPath": "./docs/CHANGELOG.md"
  }
}
```

## Declare dependencies

Put runtime packages imported by extensions in `dependencies`. NekoPal installs package dependencies when it installs an npm or git source.

It supplies these packages to extensions and skills:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `typebox`

`@earendil-works/pi-tui` is not provided. An extension that imports it fails to load with an explicit
error.

Declare the host-provided packages listed above in `peerDependencies` with a `"*"` range and do not
bundle them. Automatic peer installation is suppressed for managed npm and git packages. Local packages
are not installed or modified, so their dependency tree remains the package author's responsibility.

Do not list host-provided packages in `dependencies`. A physical copy can bypass the extension module
mapping in compiled ESM and create duplicate classes, registries, and initialization work. NekoPal
reports an extension warning when it detects this manifest configuration. Other packages used as
dependencies must be included in the published tarball and referenced through their `node_modules`
resource paths.

Installed packages load with separate module roots. Do not rely on two packages sharing one dependency instance or one package resolving another package’s undeclared dependency.

## Select package resources

The object form in settings narrows which resources load from a package:

```json
{
  "packages": [
    {
      "source": "npm:@example/pi-tools",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

For each resource type:

- Omit the property to load everything allowed by the package.
- Use `[]` to load none of that type.
- Use `!pattern` to exclude glob matches.
- Use `+path` to include one exact allowed path.
- Use `-path` to exclude one exact path.

Filters narrow the package manifest. They do not expose resources that the package itself did not declare.

The `extensions` and `skills` lists in [settings](settings.md#resources) accept the same filter syntax
and control which discovered resources load.

## Understand scope and identity

The same package can appear in global and project settings. A project entry normally replaces the
global entry. With `autoload: false`, the project entry instead acts as a filtering delta over the
global package.

NekoPal identifies npm packages by package name, git packages by repository URL without the ref, and
local packages by resolved absolute path. This prevents the same package from loading twice through
equivalent declarations.

Use [Extensions](extensions.md), [Skills](skills.md), and [Prompt Templates](prompt-templates.md) to
design each resource before packaging it.
