# Development

This guide covers installing, developing, logging, and testing Agent System. Start with the [README](./README.md) for the current product surface and use [ADVANCED.md](./ADVANCED.md) for the complete manifest, configuration, CLI, environment, and path references.

## Requirements

- Bun from [.bun-version](./.bun-version) for installs, scripts, and builds
- Node.js from [.node-version](./.node-version) for tests and OpenClaw
- Homebrew dependencies from [Brewfile](./Brewfile)
- OpenClaw 2026.7.1-2 or newer
- A configured `tanaabot` agent with usable model authentication only for the recommended live DevGuard workflow

OpenClaw does not support running the Gateway under Bun. Agent System builds as Node-targeted ESM with package dependencies left external.

## Install From Source

Install a linked development checkout in the normal OpenClaw profile:

```sh
git clone https://github.com/tanaabased/openclaw-agent-system.git
cd openclaw-agent-system
brew bundle
bun install
bun run build
openclaw plugins install --link .
openclaw plugins enable agent-system
openclaw plugins inspect agent-system --runtime --json
openclaw plugins doctor
```

If OpenClaw reports a conflicting installation, remove it with
`openclaw plugins uninstall agent-system --force` before linking. The DevGuard
workflow below uses an isolated profile and does not require a normal-profile
installation.

## Usage

[OpenClaw DevGuard](https://github.com/tanaabased/openclaw-devguard) is the recommended way to work on Agent System. It builds, validates, watches, and source-links this checkout inside a dedicated OpenClaw profile and supervised Gateway.

```sh
openclaw plugins install npm:@tanaab/openclaw-devguard
openclaw plugins enable openclaw-devguard
openclaw plugins inspect openclaw-devguard --runtime --json
openclaw devguard init . --reset-agents --agent tanaabot --copy-oauth
openclaw devguard exec -- plugins inspect agent-system --runtime --json
openclaw devguard exec -- agent-system validate --agent tanaabot
OPENCLAW_LOG_LEVEL=debug openclaw devguard run
```

Only [`devguard.json`](./devguard.json) is portable project configuration. Agent selections, copied authentication, isolated OpenClaw state, and audit logs remain machine-local.

While `run` is active, use another terminal for inspection and direct plugin
commands:

```sh
openclaw devguard doctor
openclaw devguard exec -- plugins inspect agent-system --runtime --json
openclaw devguard exec -- agent-system validate --agent tanaabot
openclaw devguard tail
```

Stop supervision with `Ctrl-C`. See DevGuard's
[README](https://github.com/tanaabased/openclaw-devguard#usage) for its complete
workflow and security guidance.

## Logging

Set `OPENCLAW_LOG_LEVEL=debug` when additional runtime diagnostics are needed.
Agent System records value-free events through OpenClaw's logger with an
`[agent-system]` prefix and stable `code=<code>` identities. It never logs
manifest values, resolved environment values, or credentials. `devguard tail`
shows DevGuard policy audit records rather than the plugin logger stream.

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

The executable [Leia](https://github.com/lando/leia) material under [`examples/`](./examples/) and [`scenarios/`](./scenarios/) runs only through GitHub Actions. General examples cover macOS and Ubuntu where supported; notification acceptance scenarios use their own workflow and runner matrix. Both install plugins or mutate isolated OpenClaw and provider state, so neither suite may be run locally.

## Coding Standards

Agent System follows the shared JavaScript, OpenClaw plugin, documentation, and Leia conventions in the [Tanaab Canon repository](https://github.com/tanaabased/canon). The repository's [AGENTS.md](./AGENTS.md) adds Agent System-specific identity, configuration, structure, and validation boundaries.

| Path                   | Responsibility                                                |
| ---------------------- | ------------------------------------------------------------- |
| `index.ts`             | Thin static plugin entrypoint                                 |
| `agent/`               | Agent identity, authority, lifecycle, install, and diagnosis  |
| `api/`                 | Model-facing tool contracts, runtime, policy, and projection  |
| `bin/`                 | Packaged shims and shared tool or SSH launchers               |
| `channels/<provider>/` | Channel schema, runtime, lifecycle, state, and provider guide |
| `cli/`                 | OpenClaw subcommands, registration, and output handling       |
| `core/`                | Cross-owner plugin composition and shared runtime boundaries  |
| `credentials/`         | Credential input, storage, resolution, and management         |
| `environment/`         | Agent environment and 1Password environment resolution        |
| `manifest/`            | Manifest schemas, parsing, discovery, values, and types       |
| `paths/`               | PATH projection, Codex path config, and workspace ignores     |
| `tools/<capability>/`  | Tool schemas, execution, and optional lifecycle contribution  |
| `utils/`               | Cross-owner independently testable function primitives        |
| `scripts/`             | Development and release tasks                                 |
| `test/`                | Flat behavior-focused unit tests                              |

Keep implementation in its nearest owning scope, keep the plugin entrypoint at
`index.ts`, and verify visible behavior before documenting a feature as
functional. Capability-specific configuration and usage documentation belongs
beside its tool or channel. The planned third-party integration boundary is
documented in [Tool API](./API.md); the current `api/` implementation remains
internal to Agent System.
