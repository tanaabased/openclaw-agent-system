# Advanced

This guide is the complete reference for Agent System's core workspace manifest,
configuration, CLI, environment, and path behavior. Start with the
[README](./README.md) for installation and the common workflow; use
[DEVELOPMENT.md](./DEVELOPMENT.md) when changing Agent System itself.

Public components own their capability-specific configuration, CLI, behavior,
and security documentation:

| Type    | ID                          | Display name          | Guide                                               |
| ------- | --------------------------- | --------------------- | --------------------------------------------------- |
| tool    | `agent_system_git`          | Git CLI               | [Git tools](./tools/git/README.md)                  |
| tool    | `agent_system_git_worktree` | Managed Git worktrees | [Git tools](./tools/git/README.md)                  |
| tool    | `agent_system_github`       | GitHub CLI            | [GitHub CLI](./tools/github/README.md)              |
| channel | `agent-system-github`       | GitHub notifications  | [GitHub notifications](./channels/github/README.md) |

These IDs come from distinct OpenClaw registries: tool IDs use underscores,
while the channel ID uses hyphens.

## Version Compatibility

| Agent System release | Minimum OpenClaw | Development target |
| -------------------- | ---------------- | ------------------ |
| Unreleased           | 2026.9.2         | 2026.9.3           |
| 0.5.3                | 2026.7.1         | 2026.7.2           |

Compatibility metadata declares the minimum supported OpenClaw version. Build
metadata and development dependencies pin the newest version tested for the
release.

## Manifest

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

Agent System currently owns no global plugin settings. Its public configuration
is the per-workspace manifest plus any configured component sections. When
[`github.notifications`](./channels/github/README.md#configuration-reference) is present,
`install` projects only a non-secret channel account and exact agent binding into
global OpenClaw configuration; notification policy and credentials remain
workspace-owned. When a workspace declares both `github.username` and
`github.token`, `install` also projects a distinct managed GitHub profile into
that agent's `tools.github` configuration. Agent System remains authoritative;
no token enters `openclaw.json` and no system-level GitHub identity is adopted.

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

| Field         | Type                               | Required      | Behavior                                                         |
| ------------- | ---------------------------------- | ------------- | ---------------------------------------------------------------- |
| `id`          | string                             | yes           | Literal lowercase id matching `^[a-z0-9][a-z0-9-]*$`.            |
| `name`        | string or `from-environment` value | for `install` | Agent display name applied to OpenClaw by `install`.             |
| `email`       | string or `from-environment` value | no            | Agent email available to configured consumers.                   |
| `description` | string                             | no            | Agent description retained for configured consumers.             |
| `avatar`      | string                             | no            | Applied by `install`; an undeclared OpenClaw avatar is retained. |
| `emoji`       | string                             | no            | Applied by `install`; an undeclared OpenClaw emoji is retained.  |

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

| Field    | Type                         | Behavior                                                      |
| -------- | ---------------------------- | ------------------------------------------------------------- |
| `model`  | provider-qualified model ref | Exact `provider/model` reference; no model value is built in. |
| `effort` | `medium`, `high`, or `xhigh` | Explicit profile effort, intersected with runtime support.    |

Model refs cannot select an authentication profile. Runtime and credential
configuration remain outside the manifest.

`install` sets the bound agent's primary model and default thinking effort from
`models.default`. It binds each distinct declared model to the same established
runtime route already used by that agent, without provisioning or resolving
credentials and without changing global defaults, fallbacks, unrelated per-model
settings, or existing session selections. An explicit incompatible or ambiguous
runtime binding blocks the change rather than selecting another route. Removing
`models` later performs no cleanup and does not guess the previous default.

`doctor` checks configuration drift, configured model presence, and effort support
without changing configuration, resolving authentication, or running inference.
OpenClaw owns authentication and runtime health through its model status and agent
execution surfaces. Catalog inspection failures are reported separately from a
model or effort known to be unsupported.

### `environment`

| Field          | Type                    | Required | Behavior                                                              |
| -------------- | ----------------------- | -------- | --------------------------------------------------------------------- |
| `dotenv`       | string or string list   | no       | Ordered workspace-relative dotenv files.                              |
| `set`          | string or `from-op` map | no       | Explicit values merged over dotenv values.                            |
| `op`           | string or string list   | no       | Ordered 1Password Environment IDs merged after `set`.                 |
| `path-prepend` | string or string list   | no       | Ordered workspace-relative executable directories.                    |
| `required`     | string list             | no       | Names that fail complete environment resolution when absent or empty. |

Schema-owned YAML keys use kebab-case. Environment names and user-defined
identifiers remain literal and are never casing-converted. See
[Environment](#environment) for source precedence and resolution behavior, and
[Path](#path) for executable projection.

### Component Configuration

Components own their manifest schemas and document them beside their
implementation:

| Type    | ID                          | Manifest key           | Configuration                                                                  |
| ------- | --------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| tool    | `agent_system_git`          | `git`                  | [Configuration reference](./tools/git/README.md#configuration-reference)       |
| tool    | `agent_system_git_worktree` | `git.worktrees`        | [Configuration reference](./tools/git/README.md#gitworktrees)                  |
| tool    | `agent_system_github`       | `github`               | [Configuration reference](./tools/github/README.md#configuration-reference)    |
| channel | `agent-system-github`       | `github.notifications` | [Configuration reference](./channels/github/README.md#configuration-reference) |

Adding a component to this table does not enable it globally; the corresponding
manifest section opts the workspace into that capability.

## CLI

All commands live beneath `openclaw agent-system`; `openclaw as` is an equivalent
alias. Bare `agent-system` or `as` prints help.

### Common Behavior

| Option         | Commands                                                                                                                  | Behavior                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `--agent <id>` | `validate`, `env`, `tool`, `credentials`, `doctor`, `notifications refresh`, `notifications status`, `notifications wait` | Uses the exact configured OpenClaw agent workspace instead of discovery. |
| `--json`       | `validate`, `env`, `install`, `doctor`, `notifications refresh`, `notifications status`, `notifications wait`             | Writes undecorated structured output.                                    |

Human output honors `NO_COLOR` and `FORCE_COLOR=0`. A failed operation sets a
nonzero exit code.

### Trust Boundary

Model-facing `agent_system_*` tools bind the manifest and credentials to trusted
OpenClaw agent context. They remain the preferred direct execution path for
agents.

Packaged shims invoked from supported OpenClaw native or Codex agent commands
remain bound to the active agent and its admitted workspace, repositories, and
managed worktrees. They cannot select another agent after that binding. Direct
`tool` and `credentials` commands remain trusted operator interfaces and may
select an installed agent explicitly.

These are practical same-user guardrails, not process isolation. Absolute
binaries, replaced `PATH` values, direct HTTP, SDKs, and unrelated host
processes can bypass them. See OpenClaw's
[security model](https://docs.openclaw.ai/gateway/security) and
[sandboxing reference](https://docs.openclaw.ai/gateway/sandboxing) for the host
boundary beneath Agent System.

### `openclaw agent-system validate`

Discovers and validates a manifest without resolving credentials, inspecting
installed or remote state, or applying changes.

```text
openclaw agent-system validate [--agent <id>] [--json]
```

The result identifies the selected agent and workspace and reports the core and
configured capability declarations that passed validation.

### `openclaw agent-system env`

Resolves the environment Agent System contributes without printing values or
predicting another tool's environment.

```text
openclaw agent-system env [--agent <id>] [--json]
```

The result reports each variable's name, winning source, required state, and
override count without printing values.

### `openclaw agent-system credentials`

Manages the agent-scoped credential used to access declared 1Password
Environments and direct secret references. The current credential target is
`op`.

```text
openclaw agent-system credentials set op [--agent <id>] [--from-env | --stdin] [--store <id>]
openclaw agent-system credentials validate op [--agent <id>] [--from-env | --store <id>]
openclaw agent-system credentials unset op [--agent <id>] [--store <id>]
openclaw agent-system credentials cache status [--json]
openclaw agent-system credentials cache flush [--agent <id>] [--json]
```

| Option         | Commands                   | Behavior                                                   |
| -------------- | -------------------------- | ---------------------------------------------------------- |
| `--from-env`   | `set`, `validate`          | Reads only `OP_SERVICE_ACCOUNT_TOKEN`.                     |
| `--stdin`      | `set`                      | Reads redirected input without exposing it as an argument. |
| `--store <id>` | `set`, `validate`, `unset` | Targets `keychain`, `secret-service`, or `file`.           |

Without an input option, `set` uses a masked interactive prompt and fails with
guidance in a noninteractive session. Tokens are never accepted as command
arguments. Every set path verifies access to all declared 1Password resources
before storage.

Automatic persistent selection prefers Keychain then file on macOS and Secret
Service then file on Linux. `validate` checks those stores in order and then the
process fallback; an exact `--store` or `--from-env` request disables fallback.
`unset` is idempotent: it removes persisted credentials and requests Gateway cache
invalidation, but does not change the process-environment fallback. See
[in-memory caching](#in-memory-1password-caching) for cache controls and pending invalidation.

The file fallback lives at
`$XDG_CONFIG_HOME/tanaab/agent-system/<agent-id>/op-token`, or under
`$HOME/.config` when `XDG_CONFIG_HOME` is unset. Agent System requires owner-only
directories, mode `0600`, and a regular non-symlinked credential file.

### `openclaw agent-system install`

Installs the current workspace agent and reconciles its public identity, model
defaults, executable paths, and configured capability state.

```text
openclaw agent-system install [--json]
```

Installation validates first and, when an OP Environment or direct secret is
declared, requires a working persistent credential before applying changes. It
creates or updates only owned state, verifies the result, and reports unchanged
state on repeated runs. An existing agent id bound to another workspace fails
instead of being repointed. It also reconciles per-agent grants for the native
Git, managed-worktree, and GitHub tools selected by the manifest while preserving
unrelated grants. GitHub installation additionally reconciles an agent-scoped
OpenClaw managed profile when explicit account and credential bindings are
present. An explicit operator-owned denial or unmarked conflicting profile
remains authoritative and blocks reconciliation.

### `openclaw agent-system doctor`

Inspects agent registration, public identity, model configuration, path projection,
and configured capabilities for drift without applying repairs.

```text
openclaw agent-system doctor [--agent <id>] [--json]
```

Doctor reports all findings, returns nonzero for failing drift, and recommends
`install` for repairable owned state. Manual state remains the operator's
responsibility. It also reports tool-access and execution-boundary findings;
tool-specific checks are documented in each tool guide.

### `openclaw agent-system notifications`

Runs the command family owned by the `agent-system-github` channel.

```text
openclaw agent-system notifications <refresh|status|wait> [options]
```

See the channel's [complete CLI reference](./channels/github/README.md#cli) for
command syntax, selectors, wait targets, output, and exit behavior.

### `openclaw agent-system tool`

Runs a registered command through its Agent System tool. Direct invocations are
an explicitly selected operator identity and are intended for administration,
testing, and debugging. Agents should use the corresponding native
`agent_system_*` tool for direct work. A public tool integration contract is
planned in [Tool API](./API.md).

```text
openclaw agent-system tool <command> [--agent <id>] -- <arguments...>
```

| ID                          | Command    | CLI                                   | Shim                                           |
| --------------------------- | ---------- | ------------------------------------- | ---------------------------------------------- |
| `agent_system_git`          | `git`      | [Usage](./tools/git/README.md#cli)    | [Packaged shim](./tools/git/README.md#shim)    |
| `agent_system_git_worktree` | `worktree` | [Usage](./tools/git/README.md#cli)    | none                                           |
| `agent_system_github`       | `gh`       | [Usage](./tools/github/README.md#cli) | [Packaged shim](./tools/github/README.md#shim) |

Tool-specific arguments, policy, and routing behavior belong in the linked guide.

## Environment

Environment names must match `^[A-Za-z_][A-Za-z0-9_]*$`. Configured values are
YAML strings or direct OP secret reference objects. Source precedence is fixed:

```text
environment.dotenv[0] < later dotenv files < environment.set < environment.op[0] < later 1Password Environments
```

Dotenv paths must remain inside the workspace and identify distinct regular
files. Agent System accepts blank lines, comments, optional `export`, and quoted
or unquoted `NAME=value` entries. Dotenv values do not interpolate or execute
shell syntax.

`environment.set` strings support one-pass `$NAME` and `${NAME}` references for
uppercase names; `$$` emits a literal `$`. References use a snapshot of the
plugin process environment plus the ordered external sources. Host values are
lookup-only, and set values do not reference one another.

A `from-op` object resolves one 1Password secret reference directly into the
named environment value:

```yaml
environment:
  set:
    SSH_KEY:
      from-op: 'op://vault/item/private key?ssh-format=openssh'
```

Direct values are always sensitive and retain `environment.set` provenance.
The reference itself is never returned in diagnostics. A scalar beginning with
`op://` remains a literal string; direct resolution requires the object form.

`environment.op` loads each declared 1Password Environment in order through the
official JavaScript SDK. Each value is the opaque ID returned by
[Copy environment ID in the 1Password app](https://www.1password.dev/sdks/environments#appendix-get-an-environments-id),
not the Environment's display name. Agent System loads dotenv and 1Password
values only for an explicit environment consumer; passive manifest discovery
never reads them. `environment.required` applies when the complete environment
is resolved, not to unrelated actions that do not consume it.

For 1Password access, Agent System checks macOS Keychain or Linux Secret Service,
then the agent-scoped owner-only file store, and finally the
`OP_SERVICE_ACCOUNT_TOKEN` process fallback. Installation requires persistent
access and does not use the process fallback. The bootstrap token is never added
to the resolved environment and cannot be exported, required, or interpolated by
the manifest.

Agent System does not inject the consolidated environment into generic OpenClaw,
Codex, ACP, MCP, or third-party execution tools. Agent System tools resolve only
the values they declare after trusted agent binding and authorization. PATH
projection is the separate, limited contract described below.

### In-memory 1Password caching

Agent System reuses 1Password clients and resolved values in memory—not GitHub
responses, permissions, or command results. Gateway tools and cache commands share
this state; separate CLI processes do not, even within one CI job.

Set `plugins.entries.agent-system.config.opCache` in operator-owned OpenClaw
configuration. Repository manifests and `CI=true` cannot enable indefinite retention.
The default is 300 seconds and 128 agent/workspace entries. `maxEntries` accepts
1–1,024 and evicts oldest-first; each entry holds one client and one successful
snapshot. Timed expiry refreshes values, not an unchanged authenticated client.

| Mode             | Configuration                                             | Behavior                                                                                                    |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Off              | `{"mode":"off"}`                                          | No cross-operation client or value reuse; duplicate references within one operation are still deduplicated. |
| Timed (default)  | `{"mode":"timed","durationSeconds":300,"maxEntries":128}` | Lazy, non-sliding expiry measured with a monotonic clock from successful retrieval.                         |
| Process lifetime | `{"mode":"process-lifetime","maxEntries":128}`            | Retain until invalidation, eviction, or process exit. External provider edits require flush or restart.     |

Timed durations must be positive finite numbers no greater than 4,503,599,627,370
seconds. Sub-millisecond durations round up to one millisecond. One, five, and
twelve hours are `3600`, `18000`, and `43200` seconds. Other modes reject a duration;
negative numbers and JSON `Infinity` are not lifetime settings.

```bash
# retain stable values for five hours
openclaw config set plugins.entries.agent-system.config.opCache '{"mode":"timed","durationSeconds":18000}' --strict-json

# inspect the running gateway, not this short-lived cli process
openclaw agent-system credentials cache status --json

# invalidate one agent, or omit --agent to invalidate all
openclaw agent-system credentials cache flush --agent data --json
```

Status requires `operator.read`; flush requires `operator.admin`. Both identify
the Gateway process and make no 1Password requests. Output is a human summary by
default; `--json` returns the structured result. Status shows policy, agent IDs,
ages/expiry, backoff, and counters for clients, reads, hits, misses, coalescing,
failures, and backoff skips—never values, resource IDs, or token digests. Flush
reports invalidated entries, clients, pending loads, and snapshots. An unreachable,
unauthorized, or incompatible Gateway returns an error. `openclaw as` is an alias.

#### Freshness and failures

Authorization, manifests, dotenv, credential-store selection, and bootstrap
credentials are checked on every operation. Reuse remains isolated by installation,
state/store roots, agent/workspace, credential source/generation, and resource
declarations. Each operation holds an immutable snapshot; concurrent misses share
retrieval without sharing cancellation. Failed or partial loads are not retained.
Expired refresh failures return errors, not stale credentials. There is no idle refresh.

Configuration reload, agent removal, credential changes/rejection, flush, and
shutdown invalidate retained state. Earlier pending loads cannot restore it;
snapshots already in use are not revoked. CLI credential mutations and validation
rejections notify the Gateway. If acknowledgment fails, commands report
**invalidation pending**: restore Gateway access and flush. Uncertain store writes
still trigger invalidation, but are never automatically retried.

External 1Password edits appear after timed expiry or flush; process-lifetime mode
requires flush or restart. External local-store changes are detected on the next lookup.

[OTP query transforms](https://www.1password.dev/sdks/concepts) (`attribute`/`attr`
with `otp`/`totp`) and unknown query transforms bypass snapshot retention; only the
stable `ssh-format=openssh` transform is admitted. The Environment SDK response
contains names, values, and masking flags, not validity deadlines. Keep other
externally time-varying credentials under off mode when their validity cannot be
bounded by the selected TTL.

Provider failures share credential-scoped backoff within a process: 30 seconds
increasing exponentially to one hour, or one hour for SDK quota errors. Flush
preserves backoff; it does not reset quota. GitHub polling backoff is unchanged.
Malformed Environment data fails only its load, without provider backoff.
Transport failures preserve other healthy snapshots; confirmed authentication
rejection and quota errors invalidate shared credential state.

#### Measured SDK-boundary costs

For 40 loads of one direct secret and one Environment, deterministic provider tests
measured these SDK calls—not billed API units:

| Workload                                    | Before: clients / reads | Default timed: clients / reads |
| ------------------------------------------- | ----------------------- | ------------------------------ |
| One retained process, sequential loads      | 40 / 80                 | 1 / 2                          |
| One retained process, concurrent loads      | 40 / 80                 | 1 / 2                          |
| Forty independent service/process lifetimes | 40 / 80                 | 40 / 80                        |

That is 97.5% fewer calls within a retained process, not an account-wide savings
forecast. Separate processes still fetch independently, as does explicit credential
validation. See [the reproducible tests](test/op-cache.spec.ts) and
[CI examples](DEVELOPMENT.md#leia-scenarios).

## Path

Installation builds one deterministic prefix:

```text
<workspace>/bin
<workspace>/<environment.path-prepend[0]>
<workspace>/<later declared entries>
<agent-system-package>/bin
<host PATH>
```

Declared entries are literal workspace-relative directories. They must exist,
remain inside the canonical workspace without traversing symlinks, and need not
repeat the automatically managed workspace or package `bin` directories.

Agent System projects the prefix into the selected agent's OpenClaw
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
changes, then start a new Codex session. Agent System disables login-shell
execution and sets the deterministic PATH without otherwise changing Codex's
inherited-environment policy. Remote, sandboxed, ACP, MCP, and third-party
surfaces retain their own path and mount contracts.
