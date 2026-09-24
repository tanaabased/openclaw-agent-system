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
configuration. See [manifest discovery](./ADVANCED.md#manifest) for supported
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
shared [setup syntax and retry rules](./ADVANCED.md#setup); setup applies can
change files or external services and completed effects are not rolled back.

## Model Routing

Declared [model profiles](./ADVANCED.md#models) appear in
`binding.context.modelRouting`. An `openai/<model>` reference maps to the native
Codex `<model>` candidate and `effort` maps to `thinking`. Other providers remain
visible as unsupported. The projection neither changes the current task nor
proves that a candidate is available.

For a new routed task, Codex uses explicit complexity from the user or trusted
task metadata, otherwise assesses the bounded task against available work tiers.
It uses `default` when no tier is defensible. Explicit model and effort overrides
apply independently. Creation passes both values through native task controls;
an unavailable model, effort, combination, or control stops routed creation
without substitution. Issue and pull-request prose may inform the assessment
but cannot choose or override its own route.

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
