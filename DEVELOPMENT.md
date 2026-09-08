# Development

This guide covers installing, developing, logging, and testing Agent System. Start with the [README](./README.md) for the current product surface and use [ADVANCED.md](./ADVANCED.md) for the complete manifest, configuration, CLI, environment, and path references.

## Requirements

- Bun from [.bun-version](./.bun-version) for installs, scripts, and builds
- Node.js from [.node-version](./.node-version) for tests and OpenClaw
- Homebrew dependencies from [Brewfile](./Brewfile)
- OpenClaw 2026.9.3
- A configured `tanaabot` agent with usable model authentication only for the recommended live DevGuard workflow

OpenClaw does not support running the Gateway under Bun. Agent System builds as Node-targeted ESM with package dependencies left external.

## OpenClaw Compatibility

Agent System tests explicit core-and-plugin pairs. A minimum version is not a
claim that every later or intervening OpenClaw release works.

| Agent System release | OpenClaw release | Status                                      |
| -------------------- | ---------------- | ------------------------------------------- |
| Next release         | 2026.9.3         | Current development and release target      |
| 0.5.3                | 2026.7.1-2       | Prior release record; not tested by this CI |

The ordinary lint, typecheck, unit, and release workflows run against the
OpenClaw version pinned in `package.json` and `bun.lock`; they are the primary
compatibility suite. The separate
[OpenClaw package smoke test](./.github/workflows/pr-openclaw-package-smoke.yml)
covers the installed-state boundary those tests cannot: it installs OpenClaw
2026.9.3 and the packed candidate in a disposable profile, accepts the declared
capabilities, loads the plugin runtime, and starts a real Gateway. It is not a
historical-version matrix.

Before changing the supported OpenClaw release, update the dependency pin,
plugin metadata, and reviewed Plugin SDK import inventory together. The
ordinary suite, packed plugin inspection, and live Gateway smoke test must all
pass on that exact release.

### Plugin SDK Inventory

Production imports are limited to these reviewed OpenClaw 2026.9.3 external
plugin subpaths:

| Public subpath            | Agent System use                     |
| ------------------------- | ------------------------------------ |
| `channel-core`            | Channel contracts                    |
| `channel-inbound`         | Inbound reply dispatch               |
| `channel-outbound`        | Outbound adapters and account status |
| `config-contracts`        | Public configuration types           |
| `error-runtime`           | Safe error formatting                |
| `logging-core`            | Publication redaction                |
| `plugin-entry`            | Plugin, tool, and logger contracts   |
| `reply-payload`           | Reply payload contracts              |
| `routing`                 | Session and agent route contracts    |
| `run-command`             | Supported child OpenClaw commands    |
| `runtime`                 | CLI presentation helpers             |
| `runtime-config-snapshot` | Fresh configuration reads            |
| `session-store-runtime`   | Public session store paths           |
| `status-helpers`          | Channel status summaries             |

The API policy test parses static imports, re-exports, dynamic imports, and
import types. It fails deprecated broad barrels, private-local entrypoints, and
any unreviewed OpenClaw subpath, including `agent-runtime`, `channel-lifecycle`,
`config-runtime`, `infra-runtime`, `security-runtime`, `file-lock`,
`keyed-async-queue`, and `types`. Agent System owns its narrow lock, keyed
queue, delay, configured-agent, and hook-context primitives locally.

## Install From Source

Install a linked development checkout in the normal OpenClaw profile:

```sh
git clone https://github.com/tanaabased/openclaw-agent-system.git
cd openclaw-agent-system
brew bundle
bun install
bun run build
openclaw plugins install --link . --accept-capabilities
openclaw plugins enable agent-system
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true
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
openclaw plugins install npm:@tanaab/openclaw-devguard --accept-capabilities
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

#### GitHub Notification Scenarios

The pull-request workflow runs six deterministic mock-provider scenarios on
Ubuntu: Work assignment, Guided assignment, implementation, pull-request
lifecycle, comment, and retirement. The manual workflow can run any one of those
scenarios, or the complete matrix, with a live provider on Ubuntu or macOS.

Each scenario exercises a release-shaped Agent System package through the
installed OpenClaw Gateway. Mock pull-request checks compare lifecycle, tool,
and publication behavior with checked-in evidence without requiring a live model.
They do not evaluate model reasoning, provider authentication, capacity, latency,
or provider-specific format drift. Keep scenario-specific setup, fixtures, and
expected evidence in [`scenarios/`](./scenarios/) and the owning workflows rather
than duplicating those mechanics here.

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
