# Manifest Reference

Configure an agent workspace through `agent.yaml`. Start with the
[README](./README.md#usage) for the common workflow; use [Global Configuration](./CONFIG.md)
for operator-owned OpenClaw settings and [CLI Reference](./CLI.md) to apply or inspect declarations.

- [Discovery](#discovery)
- [Configuration](#configuration)
- [Setup](#setup)
- [Component configuration](#component-configuration)
- [Environment resolution](#environment-resolution)
- [Path projection](#path)

## Discovery

Agent System discovers one manifest from an agent workspace:

```text
.agent-system/agent.yaml   # preferred
agent.yaml                 # shorthand
```

The preferred file wins when both exist; the files never merge. Passive loading
validates the manifest but does not resolve environment values or mutate state.
The strict loader rejects unknown or incorrectly cased keys, unsafe symlinks,
files larger than 1 MiB, invalid UTF-8, duplicate keys, and unsupported YAML
features such as anchors, aliases, and explicit tags.

A minimal manifest binds one workspace to one agent:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot

environment:
  set:
    NODE_ENV: development
```

See [Configuration](#configuration) for the complete core manifest and
component-provided sections.

## Configuration

The workspace manifest declares the agent's desired state. `install` reconciles
owned OpenClaw settings; credentials remain outside `openclaw.json`.
[Global Configuration](./CONFIG.md) covers operator-owned plugin settings.

A complete core configuration can contain:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email:
    from-environment: AGENT_EMAIL
  description: Tanaab development agent.
  avatar: avatar.png
  emoji: 🧑‍💻

models:
  default: { model: openai/gpt-6-astra, effort: high }
  low: { model: openai/gpt-5.6-terra, effort: medium }
  medium: { model: openai/gpt-5.6-sol, effort: high }
  high: { model: openai/gpt-6-astra, effort: xhigh }

memory:
  search:
    provider: openai
    model: text-embedding-3-small
    api-key: EMBEDDINGS_API_KEY

environment:
  dotenv:
    - .agent-system/env/base.env
    - .agent-system/env/local.env
  set:
    AGENT_COLOR: green
    AGENT_EMAIL: $COMPANY_EMAIL
    NODE_ENV: development
    SSH_KEY:
      from-op: 'op://v4u7l2t9n5p8r1c6x3z0m4q7da/ssh-key/private key?ssh-format=openssh'
  op:
    - b3v8n1q6m4z9k2r7t5w0x8c6pd
    - z7q4m2n9v6k3p8r5t1w0x4c2ba
  path-prepend:
    - tools/bin
  required:
    - AGENT_EMAIL
```

### `schema-version`

| Type    | Required | Default |
| ------- | -------- | ------- |
| integer | yes      | `1`     |

Identifies the manifest schema. Version `1` is the only accepted value.

### `agent`

| Field         | Type                               | Required      | Default                  | Behavior                                                         |
| ------------- | ---------------------------------- | ------------- | ------------------------ | ---------------------------------------------------------------- |
| `id`          | string                             | yes           | none                     | Literal lowercase id matching `^[a-z0-9][a-z0-9-]*$`.            |
| `name`        | string or `from-environment` value | for `install` | none                     | Agent display name applied to OpenClaw by `install`.             |
| `email`       | string or `from-environment` value | no            | none                     | Agent email available to configured consumers.                   |
| `description` | string                             | no            | none                     | Agent description retained for configured consumers.             |
| `avatar`      | string                             | no            | installed value retained | Applied by `install`; an undeclared OpenClaw avatar is retained. |
| `emoji`       | string                             | no            | installed value retained | Applied by `install`; an undeclared OpenClaw emoji is retained.  |

`name` and `email` accept a literal or an explicit reference to the completed
Agent System environment:

```yaml
agent:
  name:
    from-environment: AGENT_NAME
```

A missing or empty referenced value fails the action that consumes it. A
dollar-prefixed scalar in these fields remains literal.

Identity fields do not configure tools by themselves; a tool may explicitly use
them as defaults.

### `models`

`models` is optional. Omitting it leaves the agent's existing model configuration
untouched. When present, `default` is required; `low`, `medium`, and `high` are an
additive work-tier group and must be declared together or omitted together.

Each profile requires both fields:

| Field    | Type                         | Required | Default | Behavior                                                      |
| -------- | ---------------------------- | -------- | ------- | ------------------------------------------------------------- |
| `model`  | provider-qualified model ref | yes      | none    | Exact `provider/model` reference; no model value is built in. |
| `effort` | `medium`, `high`, or `xhigh` | yes      | none    | Explicit profile effort, intersected with runtime support.    |

Model refs cannot select an authentication profile. Runtime and credential
configuration remain outside the manifest.

OpenClaw's `agents.entries.<id>.models` map stores per-model metadata such as
`agentRuntime`; it does not authorize selection. Selection is governed by the
agent's effective `modelPolicy.allow`, which may come from the agent entry or
`agents.defaults`.

`install` applies declared models to the bound agent:

- Sets the primary model and thinking effort from `default`.
- Binds declared models to the agent's established runtime route without resolving credentials.
- Extends a restrictive per-agent `modelPolicy.allow` only as needed, preserving inherited permissions. Unrestricted or matching wildcard policies need no repair.
- Preserves global defaults, fallbacks, other agents, unrelated model settings, and existing sessions.

> [!NOTE]
> An incompatible or ambiguous runtime binding blocks installation. Removing
> profiles later does not undo defaults or policy entries.

`doctor` checks configuration, selection policy, model presence, and effort
support without authentication or inference. OpenClaw owns runtime health.
Explicit unavailability produces a warning; unknown availability is not failure.
Inspection errors remain distinct from known unsupported models or efforts.

Complete work tiers enable [GitHub issue model routing](channels/github/ADVANCED.md#model-routing)
for new issue conversations. A default-only manifest keeps ordinary model behavior.

For standalone Codex task selection, see [Codex model routing](./CODEX.md#model-routing).

### `memory`

`memory` is optional. Omitting it leaves the bound agent's existing OpenClaw
memory search configuration untouched. When present, `search.provider` is
required:

| Field      | Type                      | Required | Default | Behavior                                                                  |
| ---------- | ------------------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `provider` | `none`, `local`, `openai` | yes      | none    | Selects keyword-only, local embedding, or OpenAI embedding search.        |
| `model`    | string                    | no       | none    | Overrides OpenClaw's embedding model; valid only with `openai`.           |
| `api-key`  | environment name          | no       | none    | Reads one declared Agent System environment binding; valid with `openai`. |

`install` sets the bound agent's provider and fallback, plus the optional model
and API-key reference, while preserving other memory settings and agents. The
`none` provider retains keyword search. Configure `local` through OpenClaw before
expecting semantic search:

```sh
openclaw models --agent tanaabot auth login --provider llama-cpp --method local
```

An OpenAI `api-key` becomes an agent-and-binding-scoped `SecretRef`. Use a
declared dotenv file or stored 1Password credential so it survives restarts.
Agent System resolves only that reference when OpenClaw loads its secret snapshot.

> [!NOTE]
> Source-linked installs use the checkout's built standalone provider because
> OpenClaw cannot load plugin integrations from a `config` origin. Build before
> installation; restart the Gateway after changing the provider form or binding.
> An operator who can rewrite `openclaw.json` can copy the reference.

Doctor preserves the memory database and checks readiness by provider:

- `none`: keyword index.
- `local`: local provider availability.
- `openai`: the configured credential and one bounded embedding probe; an unrelated fallback credential cannot establish readiness.

Authentication, permission, billing/quota, and transport failures omit upstream
error bodies. Index identity and synchronization drift are separate findings.

Use OpenClaw's explicit memory commands when you intend to mutate the index:

```sh
# inspect the bound agent without rebuilding its index.
openclaw memory status --agent tanaabot --deep --json

# rebuild only when doctor reports index drift and you intend the write.
openclaw memory status --index --agent tanaabot
```

### `environment`

| Field          | Type                    | Required | Default | Behavior                                                              |
| -------------- | ----------------------- | -------- | ------- | --------------------------------------------------------------------- |
| `dotenv`       | string or string list   | no       | none    | Ordered workspace-relative dotenv files.                              |
| `set`          | string or `from-op` map | no       | none    | Explicit values merged over dotenv values.                            |
| `op`           | string or string list   | no       | none    | Ordered 1Password Environment IDs merged after `set`.                 |
| `path-prepend` | string or string list   | no       | none    | Ordered workspace-relative executable directories.                    |
| `required`     | string list             | no       | none    | Names that fail complete environment resolution when absent or empty. |

Schema-owned YAML keys use kebab-case. Environment names and user-defined
identifiers remain literal and are never casing-converted. See
[Environment Resolution](#environment-resolution) for source precedence and resolution behavior, and
[Path](#path) for executable projection.

### `setup`

Declares dependency installation and workspace configuration run through `install`, with
optional checks for repeat installation and Doctor. Omit `setup` when the
first-party configuration already handles the work. Setup scripts can change
files or external services; their authors must make checks read-only and applies
safe to repeat.

#### Syntax

Use the short mapping for one checked operation:

```yaml
setup:
  shell: zsh
  check: test -d repos
  apply: mkdir -p repos
```

| Form                                                                | Meaning                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `setup: mkdir -p repos` or a YAML block scalar                      | One unchecked `apply` script using `sh`                                       |
| `check: test -d repos` / `apply: mkdir -p repos`                    | Script using the selected shell                                               |
| `check: [test, -d, repos]` / `apply: [mkdir, -p, repos]`            | Literal argument array, without shell parsing or expansion                    |
| `apply: { command: mkdir, args: [-p, repos], timeout-seconds: 60 }` | Direct executable with optional arguments and timeout; also valid for `check` |

Use `steps` for multiple operations in declaration order. String commands inherit
its shell unless a step overrides it; direct commands ignore shell selection.
This example assumes the referenced script exists:

```yaml
setup:
  shell: bash
  steps:
    - id: directories
      check: test -d repos && test -d artifacts
      apply: |
        mkdir -p repos
        mkdir -p artifacts
    - id: dependencies
      runtimes: [openclaw]
      check: [./scripts/dependencies, check]
      apply:
        command: ./scripts/dependencies
        args: [install]
        timeout-seconds: 600
```

Strings, block scalars, and the short mapping normalize to one step named
`default`. Named steps require a unique lowercase kebab-case `id` and an `apply`;
`check` is optional. `steps` must be nonempty and cannot mix with short-mapping
fields. Bare arrays and command objects are not setup shorthand: place them
under `check` or `apply`.

#### Shells, executables, and limits

`shell` accepts only `sh`, `bash`, or `zsh`; the default is `sh` on every platform,
including macOS. The selected shell must already be installed. Strings are
written to private temporary scripts, run with these fixed arguments, and
removed afterward:

| Shell  | Invocation                                        |
| ------ | ------------------------------------------------- |
| `sh`   | `sh -e <script>`                                  |
| `bash` | `bash --noprofile --norc -e -o pipefail <script>` |
| `zsh`  | `zsh -f -e -o PIPE_FAIL <script>`                 |

There are no custom shell wrappers or automatic login-shell selection. Every
command defaults to a 300-second timeout. Only the direct command object accepts
`timeout-seconds`, an integer from `1` through `3600`; strings and arrays retain
the default.

Commands start in the bound workspace with closed stdin and a 64 KiB combined
output capture limit. Timeouts terminate the command's process tree. Ordinary
diagnostics and JSON results report step ids and diagnostic codes without
including raw command output. The interactive confirmation deliberately shows
the declared commands, so keep secrets out of declarations.

OpenClaw setup receives a minimal host environment for home, locale, temporary paths,
and OpenClaw profile selection, plus managed command bindings. Its `PATH` places
managed launchers before trusted host executable directories. Bare `git` and `gh`
use host executables when a descendant leaves agent scope; see the
[command-routing contract](./CLI.md#trust-boundary). The completed
Agent System environment and operator provider tokens are not copied into the
setup shell. Managed tools resolve their own declared environment and credentials
after binding the target agent and applying policy.

Direct workspace executables such as `./scripts/dependencies` must be executable
regular files within the workspace, with no symlinks or group/world-writable
path segments. Direct executable declarations reject `..` traversal. These
checks and the command limits do not sandbox arbitrary shell code or isolate
processes sharing the same OS user.

#### Runtime applicability

An optional `runtimes` list selects `openclaw`, `codex`, or both. Omission means
both, including bare strings and blocks. Put the filter on the short mapping or
individual named steps, never the `steps` container:

```yaml
setup:
  runtimes: [openclaw]
  check: test -d repos
  apply: mkdir -p repos
```

Lists must be nonempty and contain unique supported values. The invoking
integration selects the runtime from trusted context. OpenClaw always selects
`openclaw`, including for OpenClaw-hosted Codex; the
[standalone Codex adapter](./CODEX.md#supported-context-and-operations) selects
`codex`. Model selection, installed binaries, and manifest prose cannot override
that choice.

All declarations are validated. Nonmatching steps run neither command and report
`status: skipped`, `code: setup-not-applicable`, and their `stepId`; they are not
drift or failure. Filtering precedes preparation, so no matching steps means no
setup-only prerequisite checks. Other configured components still run normally,
and applicable steps retain declaration order. There is no skip exit code or
`when` expression.

#### Checks, installation, and retries

| Applicable step                                     | Doctor    | Install                                          |
| --------------------------------------------------- | --------- | ------------------------------------------------ |
| Check exits `0`                                     | `healthy` | Leaves the step `unchanged`.                     |
| Check exits `1`                                     | `drift`   | Runs apply, then requires the check to exit `0`. |
| Check exits otherwise, cannot execute, or times out | `blocked` | Stops without applying the step.                 |
| No check                                            | `manual`  | Runs apply on every installation.                |

Apply must exit `0`. A failed apply, blocked check, or check that still reports
drift after apply stops later steps and dependent lifecycle work. Earlier
completed work remains in place; there is no transaction or rollback of
arbitrary setup effects. On retry, healthy checked steps are skipped and
unchecked steps run again. Coordinate host-wide or shared-resource changes
outside this per-agent mechanism.

Write checks so that `1` means expected drift and other nonzero exits mean an
inspection failure. The runner cannot distinguish intended drift from an
unhandled command error that also returns `1`. Doctor runs applicable checks
without prompting, applying setup, or repairing prerequisites, and aggregates
their findings. A check is trusted code: its read-only behavior is the author's
responsibility. `validate` only validates declarations and never executes them.

#### Agent identity and repository cloning

For applicable OpenClaw setup, installation establishes agent registration, managed
paths, and configured Git/GitHub tools, including declared GitHub SSH-key
registration, before running setup. Remaining lifecycle components follow
setup. Unavailable prerequisites block execution; setup cannot bootstrap a tool
or credential required to reach its own commands.

To clone as the agent, first declare its [Git identity and SSH
keys](./tools/git/README.md#configuration-reference) and [GitHub username, token,
and public keys](./tools/github/README.md#configuration-reference). Executables,
credential sources, and key files must already be available. Then add:

```yaml
setup:
  steps:
    - id: clone-project
      runtimes: [openclaw]
      check: test -d repos/project/.git
      apply: |
        gh api user --jq .login
        mkdir -p repos
        git clone git@github.com:your-org/project.git repos/project
```

Replace `your-org/project` with the repository to clone. Managed `gh` uses the
agent's token and verifies the declared `github.username`; managed `git` uses
the agent's identity and SSH configuration. Both shell and direct commands use
the same binding, policy, and working-directory boundaries, without falling
back to the operator's tool identity. This does not switch OS accounts: the
process still runs as the installing OS user. The example is OpenClaw-only
because it relies on that integration's managed tools.

### Component Configuration

Components own their manifest schemas and document them beside their
implementation:

| Type    | ID                          | Manifest key           | Configuration                                                                    |
| ------- | --------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| tool    | `agent_system_git`          | `git`                  | [Configuration reference](./tools/git/README.md#configuration-reference)         |
| tool    | `agent_system_git_worktree` | `git.worktrees`        | [Configuration reference](./tools/git/README.md#gitworktrees)                    |
| tool    | `agent_system_github`       | `github`               | [Configuration reference](./tools/github/README.md#configuration-reference)      |
| channel | `agent-system-github`       | `github.notifications` | [Configuration reference](./channels/github/ADVANCED.md#configuration-reference) |

A manifest section opts the workspace into its capability. Tool IDs use
underscores; the channel ID uses hyphens.

## Environment Resolution

Source precedence is fixed:

```text
environment.dotenv[0] < later dotenv files < environment.set < environment.op[0] < later 1Password Environments
```

Variable names match `^[A-Za-z_][A-Za-z0-9_]*$`; values are YAML strings or
`from-op` objects. Dotenv files must be distinct regular files inside the
workspace. They accept comments, optional `export`, and quoted or unquoted
`NAME=value` entries without interpolation or shell execution.

`environment.set` strings expand uppercase `$NAME` and `${NAME}` references
once; `$$` emits `$`. Lookups use the process environment and ordered external
sources, never sibling `set` values. Host values are lookup-only.

A `from-op` object resolves a secret directly:

```yaml
environment:
  set:
    SSH_KEY:
      from-op: 'op://vault/item/private key?ssh-format=openssh'
```

These values are always sensitive; diagnostics omit the reference itself.
A plain `op://` string stays literal. `environment.op` takes opaque
[1Password Environment IDs](https://www.1password.dev/sdks/environments#appendix-get-an-environments-id),
not display names, and loads them in order through the SDK.

Only explicit consumers load dotenv or 1Password values; passive discovery never
does. `environment.required` applies to complete environment resolution, not
unrelated actions. [Credential storage](./CLI.md#credential-storage)
defines lookup order. Install requires a persistent credential; the bootstrap
token is never exported, required, or interpolated by the manifest.

Agent System tools resolve declared values after trusted binding and authorization.
The consolidated environment is not injected into generic OpenClaw, Codex, ACP,
MCP, or third-party tools. PATH projection is the separate contract below.

## Path

Installation builds one deterministic managed prefix followed by a saved Codex
baseline:

```text
<workspace>/bin
<workspace>/<environment.path-prepend[0]>
<workspace>/<later declared entries>
<agent-system-package>/bin
<saved Codex baseline>
```

Declared entries are literal workspace-relative directories. They must exist,
remain inside the canonical workspace without traversing symlinks, and need not
repeat the automatically managed workspace or package `bin` directories.

Initial installation seeds the baseline from the invoking process PATH. Later
installs preserve its exact order and append caller directories not already
saved. Exact duplicates are removed; distinct path aliases are retained.
Managed workspace, declared, and package entries remain authoritative at the
front and obsolete known managed entries are reconciled.

Agent System projects the managed prefix into the selected agent's OpenClaw
`tools.exec.pathPrepend`. For local Codex native shell commands, it writes an
equivalent machine-specific `<workspace>/.codex/config.toml` and adds that path to
the root `.gitignore`.

Agent System owns the Codex file only when it contains
`# agent-system: managed-path-v1`. An existing unmarked file or one containing
`# agent-system: manual-path-v1` remains user-managed. Add the equivalent settings
to a user-managed file without duplicating existing TOML tables:

```toml
# agent-system: manual-path-v1

allow_login_shell = false

[features]
shell_snapshot = true

[shell_environment_policy.set]
PATH = "/absolute/workspace/bin:/absolute/agent-system/bin:/base/path"
```

Rerun `install` when the workspace, package location, declared paths, or host PATH
changes. Use `openclaw agent-system install --rebuild-codex-path` only when the
saved baseline should be replaced by that CLI environment. Native chat Install
offers the equivalent approved `rebuildCodexPath` option. Both report baseline
changes; neither modifies user-managed Codex configuration.

> [!NOTE]
> Existing baseline order wins; stale paths can accumulate. Doctor reports caller
> directories that Install would append, but extra, reordered, or nonexistent
> baseline entries alone are not drift. PATH health does not prove executable availability.

Start a new Codex session after PATH changes; existing sessions do not hot-reload
the workspace configuration. Agent System disables login-shell
execution and sets the deterministic PATH without otherwise changing Codex's
inherited-environment policy. Remote, sandboxed, ACP, MCP, and third-party
surfaces retain their own path and mount contracts.
