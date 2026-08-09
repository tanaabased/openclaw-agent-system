# Development

This guide covers installing, developing, logging, and testing Agent System. Start with the [README](./README.md) for the current product surface, use [ADVANCED.md](./ADVANCED.md) for the complete manifest, configuration, CLI, environment, and path references, and treat [SPEC.md](https://github.com/tanaabased/openclaw-agent-system/blob/main/SPEC.md) as product intent rather than implementation evidence.

## Requirements

- Bun from [.bun-version](./.bun-version) for installs, scripts, and builds
- Node.js from [.node-version](./.node-version) for tests and OpenClaw
- OpenClaw 2026.7.1-2 or newer
- A configured `tanaabot` agent with usable model authentication only for the recommended live DevGuard workflow

OpenClaw does not support running the Gateway under Bun. Agent System builds as Node-targeted ESM with package dependencies left external.

## Install From Source

Install a linked development checkout in the normal OpenClaw profile:

```sh
# clone the repository and install its pinned dependencies.
git clone https://github.com/tanaabased/openclaw-agent-system.git
cd openclaw-agent-system
bun install

# build the node-targeted plugin.
bun run build

# if openclaw reports a conflicting installation, remove it before linking.
# openclaw plugins uninstall agent-system --force

# link and enable this checkout in the normal openclaw profile.
openclaw plugins install --link .
openclaw plugins enable agent-system

# confirm that openclaw loads this development build.
openclaw plugins inspect agent-system --runtime --json
openclaw plugins doctor
```

The uninstall step is intentionally optional. Do not remove an existing installation when it already points to the checkout you intend to develop. The direct normal-profile link is useful for manual plugin loading, but the recommended DevGuard workflow below links Agent System into its own isolated profile and does not require this normal-profile installation.

## Usage

[OpenClaw DevGuard](https://github.com/tanaabased/openclaw-devguard) is the recommended way to work on Agent System. It builds, validates, watches, and source-links this checkout inside a dedicated OpenClaw profile and supervised Gateway.

```sh
# install the latest compatible stable devguard release.
openclaw plugins install npm:@tanaab/openclaw-devguard
openclaw plugins enable openclaw-devguard
openclaw plugins inspect openclaw-devguard --runtime --json

# initialize this checkout with tanaabot and its oauth in isolated state.
openclaw devguard init . --reset-agents --agent tanaabot --copy-oauth

# confirm that the isolated profile loads agent system from this checkout.
openclaw devguard exec -- plugins inspect agent-system --runtime --json

# validate tanaabot's resolved workspace manifest.
openclaw devguard exec -- agent-system validate --agent tanaabot
```

Only [`devguard.json`](./devguard.json) is portable project configuration. Agent selections, copied authentication, isolated OpenClaw state, and audit logs remain machine-local.

In the first terminal:

```sh
# devguard has no --verbose flag; use openclaw debug logging instead.
OPENCLAW_LOG_LEVEL=debug openclaw devguard run

# or perform one build and live gateway verification, then exit.
OPENCLAW_LOG_LEVEL=debug openclaw devguard run --once
```

In another terminal while `run` is active:

```sh
# follow devguard's tool-policy audit log; stop following with ctrl-c.
openclaw devguard tail

# or print the current machine-readable records and exit.
openclaw devguard tail --json --no-follow

# verify the isolated profile, target build, gateway, and policy hook.
openclaw devguard doctor

# exercise agent system directly. bare commands show help.
openclaw devguard exec -- agent-system
openclaw devguard exec -- as

# validate the current directory or tanaabot's configured workspace.
openclaw devguard exec -- agent-system validate
openclaw devguard exec -- agent-system validate --agent tanaabot
```

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

## Logging

Set `OPENCLAW_LOG_LEVEL=debug` on the OpenClaw process for detailed Agent System
lifecycle diagnostics. Agent System logs metadata through the OpenClaw plugin
logger with an `[agent-system]` prefix and never includes manifest or environment
values.

| Events                 | Purpose                                      |
| ---------------------- | -------------------------------------------- |
| `manifest_*`           | Manifest discovery, validation, and changes  |
| `environment_resolved` | Value-free environment resolution metadata   |
| `tool_call_*`          | Tool start, completion, and failure metadata |

During DevGuard development, these messages appear in the `devguard run` terminal.
`devguard tail` reads DevGuard policy audit records instead of the plugin logger
stream. Stable Agent System diagnostic identities are emitted as `code=<code>`
metadata.

## Testing

Run the narrowest relevant check while iterating, then complete the repository-only suite before handoff.

### Linting And Type Checking

```sh
bun run lint
bun run typecheck
```

`bun run lint` runs ESLint, the Prettier formatting check, and ShellCheck.

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

The shared final Leia step receives the repository's model and 1Password test credentials. Only the `agent`, `path`, and `github` scenarios may consume model authentication. Only the `env`, `credentials`, `github`, and `tool` scenarios may consume `OP_SERVICE_ACCOUNT_TOKEN`; `github` and `tool` load account tokens from their declared 1Password Environments rather than workflow environment variables. Each consuming scenario owns its non-secret 1Password Environment ID fixture.

## Coding Standards

Agent System follows the shared JavaScript, OpenClaw plugin, documentation, and Leia conventions in the [Tanaab Canon repository](https://github.com/tanaabased/canon). The repository's [AGENTS.md](./AGENTS.md) adds Agent System-specific identity, configuration, structure, and validation boundaries.

| Path                  | Responsibility                                               |
| --------------------- | ------------------------------------------------------------ |
| `index.ts`            | Static plugin, tool, and lifecycle registration              |
| `cli/`                | One implementation file per subcommand                       |
| `lib/`                | CLI registration, lifecycle registry, and orchestration      |
| `tools/<capability>/` | Tool schemas, execution, and optional lifecycle contribution |
| `utils/`              | Independently testable functions                             |
| `scripts/`            | Development and release tasks                                |
| `test/`               | Flat behavior-focused unit tests                             |

Keep implementation in its nearest owning scope, keep the plugin entrypoint at `index.ts`, and verify visible behavior before documenting a feature as functional.

Foundational `agent` and `path` lifecycle contributions live in `lib/`; capability contributions remain beside their optional model-facing tool definitions. Declaration validation is deterministic and side-effect free, doctor inspection is read-only, and reconciliation runs only through explicit install after global prerequisites pass. Register contributions in deterministic dependency order in `index.ts`, return explicit unchanged outcomes, and cover validation, inspection, reconciliation, and component-aware presentation directly. Public lifecycle behavior is exercised by the GitHub Actions-only `validate`, `install`, and `doctor` Leia scenarios.
