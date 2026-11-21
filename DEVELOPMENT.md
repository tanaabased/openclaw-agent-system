# Development

This guide covers installing, developing, logging, and testing Agent System. Start with
the [README](./README.md) for installation and everyday use. Use the
[manifest](./MANIFEST.md), [CLI](./CLI.md), and [global configuration](./CONFIG.md)
references for product behavior.

## Requirements

- Bun from [.bun-version](./.bun-version) for installs, scripts, and builds
- Node.js from [.node-version](./.node-version) for tests and OpenClaw
- Homebrew dependencies from [Brewfile](./Brewfile)
- OpenClaw 2026.11.6 for development and as the minimum Gateway version
- A configured `tanaabot` agent with usable model authentication only for the recommended live DevGuard workflow

OpenClaw does not support running the Gateway under Bun. Agent System builds ESM for Node.js and keeps package dependencies external.

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

Memory credentials remain SecretRefs; linked installs resolve them through the
built standalone provider.

### Codex

From a checkout with [locked dependencies installed](#requirements), rebuild
after changing the Codex runtime or its imports:

```sh
bun run build
```

Keep development validation isolated from the live Codex installation. Cache drift
against a task worktree is expected; it does not require `bun run codex:sync` or
Agent System Install. Use the isolated package validation flow below for native
installation and discovery checks.

To deliberately install this checkout into your live Codex installation, preview
and apply the source installation:

```sh
./node_modules/.bin/codex-tools install . --dry-run --json
./node_modules/.bin/codex-tools install .
```

When deliberately adopting changes to installed Codex runtime or skill paths, run
`bun run codex:sync` and `bun run codex:check` to update and verify the cache. Changed plugin contents
may require renewed hook review.

Open a new chat to verify skill discovery.

For packaged installation and discovery checks, run `bun run test:codex-plugin`
with `AGENT_SYSTEM_PACKAGE` set to a prepared npm tarball. The release-test
workflow runs this with an isolated Codex home. See [Testing](#testing) for other
repository checks.

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

Set `OPENCLAW_LOG_LEVEL=debug` when you need more runtime diagnostics.
Agent System records value-free events through OpenClaw's logger with an
`[agent-system]` prefix and stable `code=<code>` identities. It never logs
manifest values, resolved environment values, or credentials. `devguard tail`
shows DevGuard policy audit records rather than the plugin logger stream.

## Testing

For implementation changes, run all inexpensive unit and static tests, then the applicable lint, type checks, and component tests covering the changed behavior and affected callers. Include both runtime adapters for shared behavior. Build artifacts when the selected tests consume them, and retain passing results until relevant inputs change. Documentation-only changes need relevant checks rather than automatic behavioral suites.

Use `bun run validate` for comprehensive local validation when focused checks leave an unresolved risk.

### Verification Categories

Classify each assertion by what it proves, not its filename or test runner:

- **Unit tests** execute an owned function or small code unit with controlled inputs and assert its outputs, decisions, or boundary calls. Reading fixture data does not change the category. Renderer snapshots and parser rejection cases can be valid unit tests.
- **Component tests** exercise real cooperation among owned units with external boundaries injected. Use real process, filesystem, or platform boundaries only when those boundaries are part of the contract. Installed runtime journeys belong in the GitHub Actions-only Leia examples.
- **Static checks** inspect source, configuration, documentation, or artifacts without exercising the behavior they describe. They establish an invariant, not successful runtime execution.

Keep a static check when it protects a specific requirement the existing checks miss.
Run static checks with `bun run test:static`.

### Linting And Type Checking

```sh
bun run lint
bun run typecheck
```

`bun run lint` runs ESLint, the Prettier formatting check, and ShellCheck.

### Source Tests

```sh
bun run test
```

The Mocha suites keep behavior-focused specifications flat in [`test/`](./test/). `bun run test` remains the fast unit alias; `bun run test:all` builds the helper artifacts and runs all ordinary source tests. Use `bun run test:unit` for deterministic in-process behavior, `bun run test:static` for repository invariants, `bun run test:component` for portable component checks, and `bun run test:os` for native component contracts.

Select explicit component files with `bun run test:focused`; appending files to `test:component` does not narrow its full-suite glob. Add `--build` when those tests consume built artifacts; it builds once before the selected files. An optional `--grep` narrows cases within those files. Missing files, no file selection, and zero matching tests fail rather than falling back to the full suite.

```sh
bun run test:unit
bun run test:static
bun run test:focused test/task-turn-skills.component.spec.ts
bun run test:focused --build test/codex-dispatch.component.spec.ts test/openclaw-dispatch.component.spec.ts
```

Portable components use `*.component.spec.ts`. Native process, permission,
symlink, and socket checks use `*.os.component.spec.ts`. Run optional stress
tests with `bun run test:stress`.

### Recorded CLI Fixtures

To refresh an approved CLI capture in [fixtures](./fixtures/), use a disposable PR in
`tanaabased/big-test-bucket`. Use the actual PR author for `pr-author`. For
`pr-reviews`, use a PR with a pending review followed by a completed review from
the declared reviewer. Authenticate `gh` with access to the PR.

```sh
# write a sanitized candidate without changing an approved fixture.
bun run fixtures:record --case pr-author --pr 123 --author example-author
bun run fixtures:record --case pr-reviews --pr 123 --author example-author --reviewer example-reviewer

# inspect the candidate and its separate provenance, then accept explicitly.
cat fixtures/pr-author.received.txt fixtures/pr-author.received.meta.json
bun run fixtures:accept --case pr-author

# compare a fresh live capture against the approved fixture without replacing it.
bun run fixtures:check --case pr-author --pr 123 --author example-author
```

Review and accept each changed capture, then close the disposable PR and remove its setup branch.

### Build And Package Validation

```sh
bun run build
bun run plugin:check
```

Run `bun run test:release` when package contents, compatibility metadata, or release wiring change.

The ClawHub package check requires the target SDK and fails on compatibility warnings or breakages.

### Leia Scenarios

> [!IMPORTANT]
> Run [Leia](https://github.com/lando/leia) scenarios only in GitHub Actions. They
> install plugins and change OpenClaw or provider state on disposable runners.

See the [example guidance](./examples/AGENTS.md) for scenario selection, fixtures and credentials.

## Coding Standards

Agent System follows the shared JavaScript, OpenClaw plugin, documentation, and Leia conventions in the [Tanaab Canon repository](https://github.com/tanaabased/canon). The repository's [AGENTS.md](./AGENTS.md) adds Agent System-specific identity, configuration, structure, and validation boundaries.

See the [API reference](./API.md) for the public manifest loader and command report format.

## Documentation

Read [Documentation Design](./DOCUMENTATION.md) before editing docs: it owns the
structure, change gate, reference formats, worked examples, and review requirements.
