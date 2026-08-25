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

#### Deterministic Notification Scenarios

The pull-request notification workflow runs an Ubuntu mock-provider matrix for
the provider-neutral `issue` + `work` assignment, implementation, pull-request
delivery, and retirement scenarios plus the retained `assignment-provider-proof`
parity scenario. The manual
notification workflow keeps every scenario available for focused dispatch and can
select Ubuntu or macOS, with Ubuntu as the default. Both call one reusable
single-scenario workflow. Each mock scenario runs in an isolated job without a
live OpenAI credential and compares its bounded provider journal with checked-in
expected evidence. The provider-neutral `openclaw-notification-setup` helper
selects the configured model, delegates common profile preparation to
`openclaw-setup`, and owns mock-server readiness, AIMock configuration, evidence
comparison, and shutdown. It also disables the unrelated default-agent heartbeat
so notification evidence includes only scenario-owned model requests. The
scenario READMEs remain lifecycle-focused. The installed OpenClaw Gateway still
selects the trusted lifecycle-mode-event prompt, executes the real
`agent_system_github_reply`, `agent_system_github`, `apply_patch`, and
`agent_system_git` tools selected by each scenario, and returns the private turn
response. Agent System still prepares the worktree, publishes the staged assignment
candidate, normalizes the implementation commit, and pushes the managed branch.
AIMock replaces only the model's tool selection, tool arguments, and final text.

The pull-request example workflow no longer selects the long-running live
`examples/issue` material. That example remains checked in until
[#50](https://github.com/tanaabased/openclaw-agent-system/issues/50) decides the
shared live and mocked scenario shape.

The scenario-selectable harness uses `@copilotkit/aimock` directly as an exact
dev dependency and a strict OpenAI Responses-compatible local provider. OpenClaw 2026.7.1-2 exposes
its QA AIMock and mock-provider entrypoints only from an OpenClaw source
checkout; they are absent from the installed npm package used by third-party
plugins. Its stock AIMock entrypoint also returns a catch-all text response, so
it cannot call Agent System's repository-owned reply tool. Depending on that
private CLI was therefore rejected in favor of the direct protocol-level
harness.

The transitional proof remains a parity checkpoint during broader mock
conversion, not a replacement for every live test. A passing mock scenario
covers Gateway dispatch, central
`before_prompt_build` guidance, tool projection and execution, lifecycle state,
and real publication. It does not evaluate model reasoning, unplanned tool
choice, live provider authentication, capacity, latency, or provider-specific
format drift. If the installed Gateway cannot satisfy a strict fixture, keep
that detailed scenario manual and live while diagnosing the external-provider
boundary without adding a production-only hook or publishing the test harness.
Convert the remaining scenarios under
[#50](https://github.com/tanaabased/openclaw-agent-system/issues/50) one at a
time after each preceding mock scenario is green.

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
