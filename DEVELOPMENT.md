# Development

This guide covers installing, developing, logging, and testing Agent System. Start with the [README](./README.md) for the current product surface and use [ADVANCED.md](./ADVANCED.md) for the complete manifest, configuration, CLI, environment, and path references.

## Requirements

- Bun from [.bun-version](./.bun-version) for installs, scripts, and builds
- Node.js from [.node-version](./.node-version) for tests and OpenClaw
- Homebrew dependencies from [Brewfile](./Brewfile)
- OpenClaw 2026.9.5 for development and minimum package compatibility
- A configured `tanaabot` agent with usable model authentication only for the recommended live DevGuard workflow

OpenClaw does not support running the Gateway under Bun. Agent System builds as Node-targeted ESM with package dependencies left external.

## Install From Source

### OpenClaw

Install a linked development checkout in the normal OpenClaw profile:

```sh
git clone https://github.com/tanaabased/openclaw-agent-system.git
cd openclaw-agent-system
brew bundle
bun run sync
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

Linked installs load from this checkout with a `config` origin. After updating
the OpenClaw dependency or changing the memory secret-provider source, run
`bun run sync` to reconcile the locked dependencies, build the checkout, and
verify the built provider with a deliberately nonexistent binding. Then run
`openclaw agent-system install` from the agent workspace, and restart the
Gateway. Reconciliation uses the built standalone provider for a linked checkout;
the declared credential remains a SecretRef and never belongs in
`openclaw.json` as plaintext.

### Codex

Install the checkout once through the pinned development dependency:

```sh
./node_modules/.bin/codex-tools install . --dry-run --json
./node_modules/.bin/codex-tools install .
```

After changing `.codex-plugin/`, `assets/`, `package.json`, or `skills/`, update
the installed cache and verify that it converged:

```sh
bun run codex:sync
bun run codex:check
```

Start a fresh Codex task when verifying skill discovery. The managed path list
in `package.json#codexTools` deliberately excludes OpenClaw runtime source,
tests, examples, and scenarios.

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
Run `bun run test:codex-plugin` with `AGENT_SYSTEM_PACKAGE` set to a prepared npm
tarball when Codex installation or fresh-task skill discovery changes. The
release-test workflow supplies an isolated Codex home and runs this check.

### Leia Scenarios

The executable [Leia](https://github.com/lando/leia) material under [`examples/`](./examples/) and [`scenarios/`](./scenarios/) runs only through GitHub Actions. General examples cover macOS and Ubuntu where supported; notification acceptance scenarios use their own workflow and runner matrix. Both install plugins or mutate isolated OpenClaw and provider state, so neither suite may be run locally.

Choose the driver independently of the folder. Prefer direct assertions when
state proves the contract, use strict AIMock when the real OpenClaw agent/tool
loop matters without model judgment, and use a live model only when provider
transport, model interpretation, or Codex-native behavior is under test. The
`agent` and `github` examples and `credentials` cache checks use AIMock;
`models`, `path`, and `security` remain live.

Shared `openclaw-setup` selects [process-lifetime 1Password caching](ADVANCED.md#opcache);
unit tests set their own policy. The [credentials example](examples/credentials/README.md)
tests storage, cache reuse, flush, and credential-mutation invalidation. Assert multiple fields
from one validation result instead of repeating provider calls.

#### GitHub Notification Scenarios

The [pull-request workflow](./.github/workflows/pr-notification-tests.yml) runs
deterministic notification scenarios on Ubuntu. The
[manual workflow](./.github/workflows/notification-tests.yml) selects individual
scenarios or the complete matrix with a live provider on Ubuntu or macOS.

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
