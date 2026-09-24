# Development

This guide covers installing, developing, logging, and testing Agent System. Start with the [README](./README.md) for the current product surface and use the [manifest](./MANIFEST.md), [CLI](./CLI.md), and [global configuration](./CONFIG.md) references for product behavior.

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

# install the toolchain, locked dependencies, and built runtime.
brew bundle
bun run sync

# link this checkout into the normal openclaw profile.
openclaw plugins install --link . --accept-capabilities
openclaw plugins enable agent-system

# verify the linked plugin.
openclaw plugins inspect agent-system --runtime --json
openclaw plugins doctor
```

If OpenClaw reports a conflicting installation, remove it with
`openclaw plugins uninstall agent-system --force` before linking. The DevGuard
workflow below uses an isolated profile and does not require a normal-profile
installation.

Linked installs use a `config` origin. After changing the OpenClaw dependency
or memory secret-provider source:

1. Run `bun run sync` to install locked dependencies, rebuild, and verify the provider.
2. Run `openclaw agent-system install` from the agent workspace.
3. Restart the Gateway.

Agent installation grants conversation-hook access when notifications are
configured; no separate config command is needed. See
[hook setup](./channels/github/README.md#required-conversation-hook).
Memory credentials remain SecretRefs; linked installs resolve them through the
built standalone provider.

For standalone Codex installation, cache refresh, and packaged skill checks,
see [Codex development](./CODEX.md#development).

## Usage

[OpenClaw DevGuard](https://github.com/tanaabased/openclaw-devguard) is the recommended way to work on Agent System. It builds, validates, watches, and source-links this checkout inside a dedicated OpenClaw profile and supervised Gateway.

```sh
# install and verify the development supervisor.
openclaw plugins install npm:@tanaab/openclaw-devguard --accept-capabilities
openclaw plugins enable openclaw-devguard
openclaw plugins inspect openclaw-devguard --runtime --json

# prepare an isolated profile using the configured test agent.
openclaw devguard init . --reset-agents --agent tanaabot --copy-oauth
openclaw devguard exec -- plugins inspect agent-system --runtime --json
openclaw devguard exec -- agent-system validate --agent tanaabot

# watch, rebuild, and supervise the isolated gateway.
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

[Leia](https://github.com/lando/leia) suites run **only in GitHub Actions**:
they install plugins and mutate isolated OpenClaw or provider state.

- [`examples/`](./examples/) covers general runtime behavior on supported macOS and Ubuntu runners.
- [`scenarios/`](./scenarios/) covers notification acceptance through the installed Gateway using a release-shaped package.
- Follow the [example](./examples/AGENTS.md) and [scenario](./scenarios/AGENTS.md) guidance for drivers, fixtures, credentials, and assertions.

#### GitHub Notification Scenarios

- The [pull-request workflow](./.github/workflows/pr-notification-tests.yml) runs deterministic scenarios on Ubuntu with checked-in lifecycle, tool, and publication evidence.
- The [manual workflow](./.github/workflows/notification-tests.yml) runs selected scenarios or the full matrix with a live provider on Ubuntu or macOS.
- Mock checks do not establish model reasoning, provider authentication, capacity, latency, or provider-specific format compatibility.

#### Lifecycle Approval

The [approval example](./examples/approval/README.md) checks native Install and
Doctor discovery, approval, denial, cancellation, and unavailable approval through
the Control UI protocol with native OpenClaw and OpenClaw-hosted Codex. It runs
only in GitHub Actions against OpenClaw 2026.9.5; local unit checks do not prove
installed chat compatibility. Other chat channels are outside this matrix.

The integration uses the public
[`before_tool_call.requireApproval` hook](https://docs.openclaw.ai/plugins/plugin-permission-requests),
without protected Gateway APIs, generic MCP approval restoration, or changes to
Git/GitHub authorization.

## Coding Standards

Agent System follows the shared JavaScript, OpenClaw plugin, documentation, and Leia conventions in the [Tanaab Canon repository](https://github.com/tanaabased/canon). The repository's [AGENTS.md](./AGENTS.md) adds Agent System-specific identity, configuration, structure, and validation boundaries.

Capability-specific guides live beside their tool or channel. The planned
third-party integration boundary is documented in [Tool API](./API.md); the
current `api/` implementation remains internal to Agent System.

## Documentation

Read [Documentation Design](./DOCUMENTATION.md) before editing docs: it owns the
structure, change gate, reference formats, worked examples, and review requirements.
