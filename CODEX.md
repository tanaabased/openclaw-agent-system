# Codex

Agent System's standalone Codex plugin provides workspace context, setup, and
model routing from the shared `agent.yaml`. OpenClaw remains the primary
integration; start with the [README](./README.md) for its full lifecycle.

This guide covers standalone Codex. Codex running as an OpenClaw agent harness
uses the OpenClaw integration and its managed tools instead.

## Installation

Install through [Codex Tools](https://github.com/tanaabased/codex-tools) without a global CLI installation:

```sh
# preview registration and installation.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system --dry-run --json

# install the plugin.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system
```

Codex Tools registers the personal marketplace and installs the plugin. Start a
fresh task, open `/hooks`, and review and trust the Agent System SessionStart
hook. Start another fresh task to load its context. Installation does not grant
hook trust; a changed hook definition requires review again. See the official
[hook trust documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

## Workspace Binding

Ask Codex to bind this plugin installation to an agent workspace:

```text
Use $agent-system-codex-binding to bind this plugin to /absolute/path/to/agent-workspace.
```

The skill previews the directory and manifest before confirmation. It also
supports inspecting, replacing, and removing the binding.

> [!NOTE]
> An inaccessible path or non-directory is rejected. You may bind a missing or
> invalid manifest explicitly, but context stays inactive until it is valid.

Each installation or profile stores one workspace pointer in
`PLUGIN_DATA/workspace-binding.json`. Binding never changes workspace files and
is independent of `CODEX_HOME`, the current task directory, and OpenClaw
configuration. See [manifest discovery](./MANIFEST.md#discovery) for supported
locations and validation rules.

Start a fresh task after binding, rebinding, or unbinding. The trusted hook also
rechecks the pointer and manifest on `resume`, `clear`, and `compact`; each result
supersedes earlier context, including revoking a previously active binding.

## Supported Context and Operations

The hook projects supported non-secret identity, Git, and GitHub metadata, plus
declared model tiers. It never resolves dotenv values, 1Password references,
credentials, signing keys, or other declared environment values. Git and GitHub
use native host commands and authorization; the binding supplies no managed
tool authority.

Capabilities depend on the manifest:

| Capability                   | Available when        | Scope                                                      |
| ---------------------------- | --------------------- | ---------------------------------------------------------- |
| `agent-system-doctor`        | The binding is active | Inspect the binding, manifest, and applicable setup checks |
| `agent-system-install`       | Setup is configured   | Apply applicable setup steps                               |
| `agent-system-model-routing` | Models are configured | Select candidates for native task creation                 |
| `agent-system-git-cli`       | Git is configured     | Guide native host Git operations                           |
| `agent-system-github-cli`    | GitHub is configured  | Guide native host GitHub operations                        |

Ask for readiness or installation through the shared skills:

```text
Use $agent-system-doctor to inspect the active Agent System workspace.
Use $agent-system-install to install the active Agent System workspace.
```

Doctor and Install inspect or run only setup steps whose `runtimes` includes
`codex` or is omitted. They use the host's sanitized executable environment and
do not inspect or reconcile OpenClaw agent registration, model availability,
memory, tool access, paths, Git, GitHub, notifications, or credentials. Follow the
shared [setup syntax and retry rules](./MANIFEST.md#setup); setup applies can
change files or external services and completed effects are not rolled back.

## Model Routing

Declared [model profiles](./MANIFEST.md#models) appear in
`binding.context.modelRouting`. An `openai/<model>` reference maps to the native
Codex `<model>` candidate and `effort` maps to `thinking`. Other providers remain
visible as unsupported. The projection neither changes the current task nor
proves that a candidate is available.

For new routed work, use [Agent System Model Routing](./skills/model-routing/SKILL.md).
The hook supplies `routingRuntime` invocation details; the calling model assesses
bounded evidence and the read-only helper validates against the bound manifest.
It does not require a Gateway or a separate classifier call. Explicit model and
effort selections apply independently; native task controls remain authoritative
for availability and application.

Unresolved complexity returns a status and reason. The caller may obtain a manual
selection or explicitly request the configured default; the helper never silently
substitutes it. Missing capability permits caller-owned explicit/default settings,
while invalid profiles or unsupported selections remain errors. The first assessment
retains the **Model routing** blockquote and ordinary follow-ups, resume, and
compaction retain their saved selection. Configuration generators can use the
helper's `inspect` result at `profiles.default`; see the [helper contract](./tools/model-routing/README.md).

## Development

From a checkout with [locked dependencies installed](./DEVELOPMENT.md#requirements),
build and install through the pinned development dependency:

```sh
# build the runtime, then preview and install the local plugin.
bun run build
./node_modules/.bin/codex-tools install . --dry-run --json
./node_modules/.bin/codex-tools install .
```

Rebuild after changing the Codex runtime or its imports. For changes to
`.codex-plugin/`, `assets/`, `hooks/`, `package.json`, or `skills/`, sync the
installed cache directly:

```sh
bun run codex:sync
bun run codex:check
```

Start a fresh task to verify skill discovery. `package.json#codexTools.managedPaths`
defines the installed payload; it excludes OpenClaw runtime source, tests,
examples, and scenarios.

For packaged installation and discovery checks, run `bun run test:codex-plugin`
with `AGENT_SYSTEM_PACKAGE` set to a prepared npm tarball. The release-test
workflow runs this with an isolated Codex home. Other repository checks remain
in [Development](./DEVELOPMENT.md#testing).
