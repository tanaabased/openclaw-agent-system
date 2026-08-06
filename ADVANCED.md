# Advanced

This guide contains Agent System's advanced manifest, logging, and CLI references. Start with the [README](./README.md) for installation and the common workflow; use [DEVELOPMENT.md](./DEVELOPMENT.md) when changing Agent System itself.

## Advanced Usage

### Workspace Manifest Lifecycle

An OpenClaw agent workspace opts into Agent System with one manifest:

```text
.agent-system/agent.yaml   # preferred
agent.yaml                 # shorthand
```

The preferred file wins when both exist; the files never merge. Agent System loads the selected manifest at `session_start`. Passive loading validates and reports non-secret manifest state but never resolves environment values, adds agents, changes identity, installs dependencies, or executes workspace code.

Manifest discovery rejects symlinked manifests, a symlinked `.agent-system` directory, files larger than 1 MiB, invalid UTF-8, YAML anchors, aliases, explicit tags, duplicate keys, and unknown schema keys.

### Explicit Agent Onboarding

Run installation from the workspace represented by the manifest:

```sh
cd /path/to/agent-workspace
openclaw agent-system install
```

Installation compares the manifest with current OpenClaw configuration. It adds an absent agent, reconciles the manifest-owned display name and optional avatar, reloads configuration, and verifies the final state. A matching installation is unchanged. An existing agent id bound to another workspace fails instead of being silently repointed.

The implicit `main` agent is not redundantly added when OpenClaw has no explicit agent list. `agent.description` is validated manifest data but is not currently applied to OpenClaw identity. Installation does not choose a model, authenticate a provider, start a Gateway, resolve environment variables, or run a workspace installation script.

## Configuration Reference

Agent System currently has two configuration layers: an empty global plugin configuration and the per-workspace manifest described below.

### Plugin Configuration

Agent System currently owns no global plugin configuration; `openclaw.plugin.json` intentionally exposes an empty strict configuration schema. The workspace manifest is the current configuration surface.

### Workspace Manifest

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  description: Tanaab development agent.
  avatar: avatar.png

environment:
  dotenv:
    - .agent-system/env/base.env
    - .agent-system/env/local.env
  set:
    AGENT_COLOR: green
    AGENT_EMAIL: $COMPANY_EMAIL
    NODE_ENV: development
  required:
    - AGENT_EMAIL
```

| Field                  | Required      | Current behavior                                                                   |
| ---------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `schema-version`       | yes           | Must be the integer `1`.                                                           |
| `agent.id`             | yes           | Lowercase identifier matching `^[a-z0-9][a-z0-9-]*$`; binds manifest to agent.     |
| `agent.name`           | for `install` | Validated when present and applied as the OpenClaw display name during install.    |
| `agent.description`    | no            | Validated and loaded; reserved for a later identity surface.                       |
| `agent.avatar`         | no            | Applied during install when declared; an undeclared existing avatar is retained.   |
| `environment.dotenv`   | no            | One relative path or an ordered non-empty unique list of paths.                    |
| `environment.set`      | no            | String map that overrides dotenv layers for explicit Agent System consumers.       |
| `environment.required` | no            | Non-empty unique list that fails resolution when a final value is absent or empty. |

Schema-owned YAML keys use kebab-case. Unknown keys, camelCase alternatives, and snake_case alternatives fail validation rather than being ignored.

#### Environment Resolution

Environment-variable names must match `^[A-Za-z_][A-Za-z0-9_]*$`. Values must be YAML strings; booleans and numbers fail validation instead of being coerced. Variable names are literal data keys and are never casing-converted.

`environment.dotenv` accepts one path or an ordered list. Paths must be relative, remain inside the canonical workspace even through symlinks, select distinct regular files, contain valid UTF-8, and remain at or below 1 MiB. Every declared file is required. Later files override earlier files; `environment.set` then overrides the final dotenv layer.

The owned dotenv parser supports blank lines, full-line comments, optional `export`, and `NAME=value`. Unquoted `#` remains literal unless whitespace introduces an inline comment. Single-quoted values are literal. Double-quoted values support `\\`, `\"`, `\n`, `\r`, and `\t`. Duplicate names within one file, malformed names, unsupported escapes, unterminated quotes, and NUL bytes fail closed. Dotenv values never interpolate or execute shell syntax.

Set values support one-pass `$NAME` and `${NAME}` references for uppercase names matching `[A-Z_][A-Z0-9_]*`; `$$` emits a literal `$`. References resolve against a snapshot of the plugin process environment plus the final dotenv lookup, with dotenv values winning same-named host lookups. The host environment is lookup-only: `AGENT_EMAIL: $COMPANY_EMAIL` contributes `AGENT_EMAIL` but does not contribute `COMPANY_EMAIL`. Missing references fail resolution, and `environment.set` values do not reference one another.

Dotenv files are read only when an explicit Agent System environment consumer runs. Passive `session_start` manifest loading never reads them. The current slice does not implement 1Password Environments or path prepending.

Agent System does not inject these values into OpenClaw `exec`, Codex `exec_command`, ACP or CLI backends, node-host commands, MCP tools, or other harness-specific command surfaces. Those surfaces keep their own environment and security contracts. Future Agent System provider tools will resolve only the named values needed for one owned action.

`environment.required` applies when Agent System resolves the complete environment, including through `agent-system env`. It does not make every declared variable a prerequisite for unrelated future provider actions; those actions will declare and check their own required inputs.

### Runtime Logging

Set `OPENCLAW_LOG_LEVEL=debug` on the OpenClaw process to include debug lifecycle events. Agent System logs metadata such as trigger, agent id, path, schema version, and a short content digest; it does not log manifest values.

| Event                                    | Level | Meaning                                                  |
| ---------------------------------------- | ----- | -------------------------------------------------------- |
| `agent_system.manifest_scope_unresolved` | debug | No authoritative agent could be identified for the hook. |
| `agent_system.manifest_scope_failed`     | error | Agent or workspace resolution failed.                    |
| `agent_system.manifest_absent`           | debug | The resolved workspace is unmanaged.                     |
| `agent_system.manifest_shadowed`         | warn  | The preferred manifest hid the root shorthand.           |
| `agent_system.manifest_invalid`          | error | Discovery, YAML, schema, or agent binding failed.        |
| `agent_system.manifest_loaded`           | info  | A valid manifest was loaded.                             |
| `agent_system.manifest_changed`          | info  | A later load observed a different manifest digest.       |
| `agent_system.environment_resolved`      | info  | An environment was resolved; reports count and digest.   |

## CLI Reference

All commands are registered beneath `openclaw agent-system`; `openclaw as` is an equivalent alias. Bare `agent-system` or `as` prints command help. Normal results use standard output, while warnings and failures use standard error. Failed validation, environment inspection, or installation sets a nonzero process exit code.

### `openclaw agent-system validate`

Discovers and validates a workspace manifest without mutating OpenClaw state.

#### Usage

```sh
openclaw agent-system validate [--agent <id>]
openclaw as validate [--agent <id>]
```

#### Options

**`--agent <id>`**

Resolves the configured OpenClaw workspace for the exact agent id and requires the manifest's `agent.id` to match. Without this option, validation uses the current directory as the workspace.

#### Behavior

A valid manifest prints its agent id and selected path. A shadowed shorthand produces a warning after the valid result. Missing, invalid, unreadable, unsafe, or mismatched manifests fail with stable diagnostic codes such as `manifest-shadowed`, `manifest-schema`, or `agent-id-mismatch`.

#### Examples

```sh
# validate the current workspace.
openclaw agent-system validate

# validate tanaabot's configured OpenClaw workspace.
openclaw agent-system validate --agent tanaabot
```

### `openclaw agent-system env`

Resolves and reports the environment variable names Agent System provides for one manifest. It never prints values or predicts another tool's environment.

#### Usage

```sh
openclaw agent-system env [--agent <id>] [--json]
openclaw as env [--agent <id>] [--json]
```

#### Options

**`--agent <id>`**

Uses the exact agent's configured OpenClaw workspace and requires the manifest to bind back to that id. Without this option, the command discovers the manifest from the current directory.

**`--json`**

Writes structured output. It follows the same value-free contract as human output.

#### Output

The local view includes `agentId`, `workspaceDir`, `manifestPath`, and one entry per variable:

```text
AGENT_COLOR source=environment.set required=false overridden=1
GITHUB_TOKEN source=environment.dotenv[1] required=true overridden=1
```

#### Examples

```sh
# inspect the current workspace safely.
openclaw agent-system env

# inspect a registered agent in machine-readable form.
openclaw agent-system env --agent tanaabot --json
```

### `openclaw agent-system install`

Installs the agent represented by the current workspace and reconciles its public OpenClaw identity.

#### Usage

```sh
openclaw agent-system install
openclaw as install
```

#### Options

This command currently has no options. Run it from the intended agent workspace.

#### Behavior

Installation first performs the same manifest discovery and validation used by `validate`. It requires `agent.name`, refuses an agent id already bound to another workspace, and runs only the necessary public OpenClaw agent operations. It then reloads configuration and fails if registration or identity still differs from the manifest.

Possible result lines are:

```text
created: OpenClaw agent tanaabot at /path/to/workspace
updated: OpenClaw identity for tanaabot
unchanged: OpenClaw agent tanaabot is installed at /path/to/workspace
```

The created and updated lines may appear together on first installation. Repeated installation produces the unchanged line when no reconciliation is needed.

## Planned Advanced Surfaces

### Environment And Credentials

Ordered 1Password Environments, path prepending, and host credential storage are product intent in [SPEC.md](https://github.com/tanaabased/openclaw-agent-system/blob/main/SPEC.md), not current configuration or CLI behavior. Their complete precedence and security reference will live here when implemented.

### Installation Scripts And Drift

Workspace installation scripts, non-mutating plans, successful-run metadata, and drift reporting are not implemented. The current `install` command is limited to OpenClaw agent registration and public identity reconciliation.

### Diagnostics

The planned `credentials`, `plan`, and `doctor` commands are not registered yet. [SPEC.md](https://github.com/tanaabased/openclaw-agent-system/blob/main/SPEC.md) describes their intended boundaries; this guide will become their implemented command reference as each surface ships.
