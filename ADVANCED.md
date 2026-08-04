# Advanced

This guide contains Agent System's advanced manifest, logging, and CLI references. Start with the [README](./README.md) for installation and the common workflow; use [DEVELOPMENT.md](./DEVELOPMENT.md) when changing Agent System itself.

## Advanced Usage

### Workspace Manifest Lifecycle

An OpenClaw agent workspace opts into Agent System with one manifest:

```text
.agent-system/agent.yaml   # preferred
agent.yaml                 # shorthand
```

The preferred file wins when both exist; the files never merge. Agent System loads the selected manifest at `session_start` and again before each tool call so a long-lived session can observe manifest changes. Passive loading validates and reports state but never adds agents, changes identity, installs dependencies, or executes workspace code.

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

Agent System currently owns no global plugin configuration; `openclaw.plugin.json` intentionally exposes an empty strict configuration schema. The workspace manifest is the current configuration surface.

### Manifest Schema

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  description: Tanaab development agent.
  avatar: avatar.png
```

| Field               | Required      | Current behavior                                                                 |
| ------------------- | ------------- | -------------------------------------------------------------------------------- |
| `schema-version`    | yes           | Must be the integer `1`.                                                         |
| `agent.id`          | yes           | Lowercase identifier matching `^[a-z0-9][a-z0-9-]*$`; binds manifest to agent.   |
| `agent.name`        | for `install` | Validated when present and applied as the OpenClaw display name during install.  |
| `agent.description` | no            | Validated and loaded; reserved for a later identity surface.                     |
| `agent.avatar`      | no            | Applied during install when declared; an undeclared existing avatar is retained. |

Schema-owned YAML keys use kebab-case. Unknown keys, camelCase alternatives, and snake_case alternatives fail validation rather than being ignored.

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

## CLI Reference

All commands are registered beneath `openclaw agent-system`; `openclaw as` is an equivalent alias. Bare `agent-system` or `as` prints command help. Normal results use standard output, while warnings and failures use standard error. Failed validation or installation sets a nonzero process exit code.

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

Environment sources, required variables, dotenv loading, 1Password Environments, and host credential storage are product intent in [SPEC.md](https://github.com/tanaabased/openclaw-agent-system/blob/main/SPEC.md), not current configuration or CLI behavior. Their complete precedence and security reference will live here when implemented.

### Installation Scripts And Drift

Workspace installation scripts, non-mutating plans, successful-run metadata, and drift reporting are not implemented. The current `install` command is limited to OpenClaw agent registration and public identity reconciliation.

### Diagnostics

The planned `env`, `credentials`, `plan`, and `doctor` commands are not registered yet. [SPEC.md](https://github.com/tanaabased/openclaw-agent-system/blob/main/SPEC.md) describes their intended boundaries; this guide will become their implemented command reference as each surface ships.
