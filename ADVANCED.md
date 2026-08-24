# Advanced

This guide is the complete reference for Agent System's core workspace manifest,
configuration, CLI, environment, and path behavior. Start with the
[README](./README.md) for installation and the common workflow; use
[DEVELOPMENT.md](./DEVELOPMENT.md) when changing Agent System itself.

Capability-specific configuration, CLI, and routing documentation:

- [`git`](./tools/git/README.md)
- [`gh`](./tools/github/README.md)
- [GitHub notifications channel](./channels/github/README.md)
- [GitHub notification target design](./channels/github/DESIGN.md)
- [GitHub notification presentation components](./channels/github/PRESENTATION.md)

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
tool-provided sections.

## Configuration

Agent System currently owns no global plugin settings. Its public configuration
is the per-workspace manifest plus any configured tool sections. When
[`github.notifications`](./channels/github/README.md#configuration) is present,
`install` projects only a non-secret channel account and exact agent binding into
global OpenClaw configuration; notification policy and credentials remain
workspace-owned.

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

### Tool Configuration

Tools own their manifest schemas and document them beside their implementation:

| Tool  | Manifest key | Configuration                                                               |
| ----- | ------------ | --------------------------------------------------------------------------- |
| `git` | `git`        | [Configuration reference](./tools/git/README.md#configuration-reference)    |
| `gh`  | `github`     | [Configuration reference](./tools/github/README.md#configuration-reference) |

Adding a tool to this table does not enable it globally; the corresponding
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
```

| Option         | Commands          | Behavior                                                   |
| -------------- | ----------------- | ---------------------------------------------------------- |
| `--from-env`   | `set`, `validate` | Reads only `OP_SERVICE_ACCOUNT_TOKEN`.                     |
| `--stdin`      | `set`             | Reads redirected input without exposing it as an argument. |
| `--store <id>` | all               | Targets `keychain`, `secret-service`, or `file`.           |

Without an input option, `set` uses a masked interactive prompt and fails with
guidance in a noninteractive session. Tokens are never accepted as command
arguments. Every set path verifies access to all declared 1Password resources
before storage.

Automatic persistent selection prefers Keychain then file on macOS and Secret
Service then file on Linux. `validate` checks those stores in order and then the
process fallback; an exact `--store` or `--from-env` request disables fallback.
`unset` is idempotent and affects persistent storage only.

The file fallback lives at
`$XDG_CONFIG_HOME/tanaab/agent-system/<agent-id>/op-token`, or under
`$HOME/.config` when `XDG_CONFIG_HOME` is unset. Agent System requires owner-only
directories, mode `0600`, and a regular non-symlinked credential file.

### `openclaw agent-system install`

Installs the current workspace agent and reconciles its public identity,
executable paths, and configured capability state.

```text
openclaw agent-system install [--json]
```

Installation validates first and, when an OP Environment or direct secret is
declared, requires a working persistent credential before applying changes. It
creates or updates only owned state, verifies the result, and reports unchanged
state on repeated runs. An existing agent id bound to another workspace fails
instead of being repointed. It also reconciles per-agent grants for the native
Git, managed-worktree, and GitHub tools selected by the manifest while preserving
unrelated grants. An explicit operator-owned denial remains authoritative and
blocks reconciliation.

### `openclaw agent-system doctor`

Inspects agent registration, public identity, path projection, and configured
capabilities for drift without applying repairs.

```text
openclaw agent-system doctor [--agent <id>] [--json]
```

Doctor reports all findings, returns nonzero for failing drift, and recommends
`install` for repairable owned state. Manual state remains the operator's
responsibility. It also reports tool-access and execution-boundary findings;
tool-specific checks are documented in each tool guide.

### `openclaw agent-system notifications refresh`

Runs one GitHub notification intake cycle for the current workspace agent or an
explicitly selected installed agent.

```text
openclaw agent-system notifications refresh [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--timeout <seconds>] [--json]
```

The optional repository, kind, and number selector is all-or-nothing and limits
the cycle to that exact item. A refresh may prepare a managed issue worktree,
establish its comment baseline, carry out one pending published Work plan, or
process one new approved exact-mention comment. Deferred and failed cycles
return nonzero. The default timeout is 300 seconds.

### `openclaw agent-system notifications status`

Reads private monitor state and returns a redacted intake projection.

```text
openclaw agent-system notifications status [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--json]
```

Results report redacted assignment and intake status. A durable monitor
diagnostic returns `degraded` and sets a nonzero exit code.

### `openclaw agent-system notifications wait`

Waits for one durable intake checkpoint without parsing chat history or
presentation.

```text
openclaw agent-system notifications wait [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] --for <target> [--refresh] [--timeout <seconds>] [--json]
```

Supported targets are `baseline-ready`, `assignment-rejected`, `prepared`,
`worktree-ready`, and `retired`. Every non-baseline target requires the full
item selector. `--refresh` explicitly advances provider-owned intake while
waiting. The default timeout is 300 seconds, and terminal diagnostics fail
immediately.

### `openclaw agent-system tool`

Runs a registered command through its Agent System tool. Direct invocations are
an explicitly selected operator identity and are intended for administration,
testing, and debugging. Agents should use the corresponding native
`agent_system_*` tool for direct work. A public tool integration contract is
planned in [Tool API](./API.md).

```text
openclaw agent-system tool <command> [--agent <id>] -- <arguments...>
```

| Tool           | Command    | CLI                                   | Shim                                           |
| -------------- | ---------- | ------------------------------------- | ---------------------------------------------- |
| `git`          | `git`      | [Usage](./tools/git/README.md#cli)    | [Packaged shim](./tools/git/README.md#shim)    |
| `git-worktree` | `worktree` | [Usage](./tools/git/README.md#cli)    | none                                           |
| `gh`           | `gh`       | [Usage](./tools/github/README.md#cli) | [Packaged shim](./tools/github/README.md#shim) |

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
