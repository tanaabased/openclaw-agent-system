# Development

This guide covers installing, developing, and testing Agent System. Start with the [README](./README.md) for the current product surface and treat [SPEC.md](./SPEC.md) as product intent rather than implementation evidence.

## Requirements

- Bun from [.bun-version](./.bun-version) for installs, scripts, and builds
- Node.js from [.node-version](./.node-version) for tests and OpenClaw
- OpenClaw 2026.7.1-2 or newer
- A configured `tanaabot` agent with usable model authentication only for the recommended live DevGuard workflow

OpenClaw does not support running the Gateway under Bun. Agent System builds as Node-targeted ESM with package dependencies left external.

## Install From Source

Install a linked development checkout in the normal OpenClaw profile:

```sh
# Clone the repository and install its pinned dependencies.
git clone https://github.com/tanaabased/openclaw-agent-system.git
cd openclaw-agent-system
bun install

# Build the Node-targeted plugin.
bun run build

# If OpenClaw reports a conflicting installation, remove it before linking.
# openclaw plugins uninstall agent-system --force

# Link and enable this checkout in the normal OpenClaw profile.
openclaw plugins install --link .
openclaw plugins enable agent-system

# Confirm that OpenClaw loads this development build.
openclaw plugins inspect agent-system --runtime --json
openclaw plugins doctor
```

The uninstall step is intentionally optional. Do not remove an existing installation when it already points to the checkout you intend to develop. The direct normal-profile link is useful for manual plugin loading, but the recommended DevGuard workflow below links Agent System into its own isolated profile and does not require this normal-profile installation.

## Usage

[OpenClaw DevGuard](https://github.com/tanaabased/openclaw-devguard) is the recommended way to work on Agent System. It builds, validates, watches, and source-links this checkout inside a dedicated OpenClaw profile and supervised Gateway.

```sh
# Install the latest compatible stable DevGuard release.
openclaw plugins install npm:@tanaab/openclaw-devguard
openclaw plugins enable openclaw-devguard
openclaw plugins inspect openclaw-devguard --runtime --json

# Initialize this checkout with tanaabot and its OAuth in isolated state.
openclaw devguard init . --reset-agents --agent tanaabot --copy-oauth

# Confirm that the isolated profile loads Agent System from this checkout.
openclaw devguard exec -- plugins inspect agent-system --runtime --json

# Validate tanaabot's resolved workspace manifest.
openclaw devguard exec -- agent-system validate --agent tanaabot
```

Only [`devguard.json`](./devguard.json) is portable project configuration. Agent selections, copied authentication, isolated OpenClaw state, and audit logs remain machine-local.

In the first terminal:

```sh
# DevGuard has no --verbose flag; use OpenClaw debug logging instead.
OPENCLAW_LOG_LEVEL=debug openclaw devguard run

# Or perform one build and live Gateway verification, then exit.
OPENCLAW_LOG_LEVEL=debug openclaw devguard run --once
```

In another terminal while `run` is active:

```sh
# Follow DevGuard's tool-policy audit log; stop following with Ctrl-C.
openclaw devguard tail

# Or print the current machine-readable records and exit.
openclaw devguard tail --json --no-follow

# Verify the isolated profile, target build, Gateway, and policy hook.
openclaw devguard doctor

# Exercise Agent System directly. Bare commands show help.
openclaw devguard exec -- agent-system
openclaw devguard exec -- as

# Validate the current directory or tanaabot's configured workspace.
openclaw devguard exec -- agent-system validate
openclaw devguard exec -- agent-system validate --agent tanaabot
```

Phase 1 manifest lifecycle events (`agent_system.manifest_loaded`, `manifest_changed`, `manifest_invalid`, `manifest_shadowed`, and debug-only `manifest_absent`) appear in the `devguard run` terminal when `OPENCLAW_LOG_LEVEL=debug` is set. `devguard tail` shows DevGuard policy audit records, not the plugin logger stream. Manifest contents and values are never included in Agent System lifecycle logs.

To exercise an agent-requested tool call and its audit records through `tanaabot`:

```sh
openclaw devguard exec -- agent \
  --agent tanaabot \
  --session-key agent-system-dev \
  --message "Use the exec tool exactly once to run 'openclaw agent-system validate --agent tanaabot', then report the tool result without retrying." \
  --json
```

> [!IMPORTANT]
> The checked-in `probe` policy records the exec attempt and replaces the requested command with a non-mutating recorder, so the original command does not run. Use direct `devguard exec -- agent-system` for plugin behavior and the `tanaabot` request for tool-policy and logging work. Treat audit logs as sensitive and avoid `--unsafe-raw-stream` for routine development.

Stop supervision with `Ctrl-C`; audit logs persist between runs. See DevGuard's [README](https://github.com/tanaabased/openclaw-devguard#usage) for its common workflow, [advanced reference](https://github.com/tanaabased/openclaw-devguard/blob/main/ADVANCED.md) for complete CLI, configuration, logging, and security details, and [development guide](https://github.com/tanaabased/openclaw-devguard/blob/main/DEVELOPMENT.md#install-from-source) when testing a source-linked DevGuard checkout.

## Testing

Run the narrowest relevant check while iterating, then complete the repository-only suite before handoff.

### Linting And Type Checking

```sh
bun run lint
bun run typecheck
```

`bun run lint` runs both ESLint and the Prettier formatting check.

### Unit Tests

```sh
bun run test
```

The default Mocha suite keeps behavior-focused specifications flat in [`test/`](./test/).

### Build And Package Validation

```sh
bun run build
bun run plugin:check
```

Run `bun run test:release` when package contents, compatibility metadata, or release wiring change.

### Leia Scenarios

The executable [Leia](https://github.com/lando/leia) scenarios under [`examples/`](./examples/) run through GitHub Actions on macOS and Ubuntu. They install plugins and mutate isolated OpenClaw state, so they must not be used as routine local validation.

## Coding Standards

Agent System follows the shared JavaScript, OpenClaw plugin, documentation, and Leia conventions in the [Tanaab Canon repository](https://github.com/tanaabased/canon). The repository's [AGENTS.md](./AGENTS.md) adds Agent System-specific identity, configuration, structure, and validation boundaries.

| Path       | Responsibility                             |
| ---------- | ------------------------------------------ |
| `index.ts` | Plugin registration                        |
| `lib/`     | CLI registration and product orchestration |
| `utils/`   | Independently testable functions           |
| `scripts/` | Development and release tasks              |
| `test/`    | Flat behavior-focused unit tests           |

Keep implementation in its nearest owning scope, keep the plugin entrypoint at `index.ts`, and verify visible behavior before documenting a feature as functional.
