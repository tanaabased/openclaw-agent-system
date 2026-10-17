# Development

This guide covers installing, developing, logging, and testing Agent System. Start with the [README](./README.md) for the current product surface and use the [manifest](./MANIFEST.md), [CLI](./CLI.md), and [global configuration](./CONFIG.md) references for product behavior.

## Requirements

- Bun from [.bun-version](./.bun-version) for installs, scripts, and builds
- Node.js from [.node-version](./.node-version) for tests and OpenClaw
- Homebrew dependencies from [Brewfile](./Brewfile)
- OpenClaw 2026.9.8 for development and minimum package compatibility
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

### Verification Categories

Classify each assertion by what it proves, not its filename or test runner:

- **Unit tests** execute an owned function or small code unit with controlled inputs and assert its outputs, decisions, or boundary calls. Reading fixture data does not change the category. Renderer snapshots and parser rejection cases can be valid unit tests.
- **Component tests** exercise cooperating units through real process, filesystem, or platform boundaries. Installed OpenClaw journeys belong in the GitHub Actions-only Leia examples.
- **Static checks** inspect source, configuration, documentation, or artifacts without exercising the behavior they describe. They establish an invariant, not successful runtime execution.

Keep a static check only when its invariant has a concrete correctness, compatibility, safety, or maintenance consequence and existing validation does not already establish it. Examples include credential isolation in workflows, forbidden private SDK imports, package metadata consistency, and stale configured paths. Prefer existing parsers and the owning lint, plugin, package, or fixture validator.

Do not preserve prose, file layout, current runner matrices, command spelling, or occurrence counts merely because they are present today. Exact details belong in checks only when independently required by a supported contract. Finding a command in Markdown does not prove that it works. Delete checks with no distinct invariant rather than moving them to another suite.

For mixed specs, classify assertions separately and preserve useful behavioral coverage. Run retained `*.static.spec.ts` checks with `bun run test:static`. They run in the existing unit workflow as a separate step and are included in `test:all`, but excluded from `test:unit`. Any migration must keep retained checks running in CI and update the documented selection in the same change.

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

Portable components use `*.component.spec.ts`; native process, permission, symlink, and socket checks use `*.os.component.spec.ts`. CI runs units and portable components on Ubuntu and native components on both Ubuntu and macOS. Mixed files remain components until their deterministic cases are extracted. Installed-runtime acceptance stays in Leia examples.

`bun run test:stress` explicitly runs `*.stress.spec.ts`, including the 100,000-entry backup fixture. Stress checks are excluded from default tests and PR workflows; ordinary coverage checks pruning with a small filesystem fixture and the inventory limit in memory.

### Recorded CLI Fixtures

The mock delivery tests consume approved CLI captures directly from [`fixtures/`](./fixtures/). The fixture commands are local, explicitly invoked tools; they do not run in CI or as a release prerequisite and need no live model.

Use a disposable pull request in `tanaabased/big-test-bucket`. The PR-author case requires a declared author. The review case requires a pending review followed by a completed review from the declared reviewer on a later page. The capture requests one review per page to exercise pagination without creating a large review history; the production command retains GitHub's ordinary page size. Arrange the actor roles before recording, and close the PR and remove its setup branch when finished. The recorder creates no GitHub resources itself.

`gh` uses the current native login or `GH_TOKEN`. An operator may supply `GH_TOKEN` through an `op run` wrapper; the recorder does not read 1Password references or retain tokens. It checks the effective identity, repository access, and declared PR author before running a case.

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

Repeat record, review, accept, and check for `pr-reviews`. Approved captures use `fixtures/<case>.approved.txt`; CLI version, source PR, actor roles, and capture time live in `fixtures/<case>.meta.json`. Candidates are ignored by Git. The capture keeps JSON output as JSON text, preserves the review page nesting, and removes fields the production parser does not use. Failed commands, timeouts, incomplete output, and missing actor evidence cannot produce a candidate.

To add a case, define its exact executable and argv in [`scripts/cli-fixtures.ts`](./scripts/cli-fixtures.ts), add only the sanitization its consumer needs, and make the owning fake CLI handler assert the command shape before loading the approved capture. Before a release, an operator may run `fixtures:check` against a controlled resource; refresh an intentional drift with `fixtures:record`, inspect the candidate and provenance, and invoke `fixtures:accept` only after review. Do not run the GitHub Actions-only Leia scenarios locally.

### Build And Package Validation

```sh
bun run build
bun run plugin:check
```

Run `bun run test:release` when package contents, compatibility metadata, or release wiring change.

### Leia Scenarios

[Leia](https://github.com/lando/leia) suites run **only in GitHub Actions**:
they install plugins and mutate isolated OpenClaw or provider state.

- [`examples/`](./examples/) covers installed and runtime contracts. [OS tests](./.github/workflows/pr-examples-os.yml) select installation, Doctor, execution, and credentials on macOS and Ubuntu; [Runtime tests](./.github/workflows/pr-examples-runtime.yml) cover standalone Codex and OpenClaw contracts on Ubuntu.
- Only explicitly selected examples run in CI. Unselected folders remain migration inputs; their presence is not evidence of active coverage.
- Follow the [example guidance](./examples/AGENTS.md) for drivers, fixtures, credentials, and assertions.

#### Lifecycle Approval

See the [runtime boundary example](./examples/openclaw-runtimes/README.md)
for installed Control UI approval coverage across native OpenClaw and
OpenClaw-hosted Codex. Other chat channels are outside this matrix.

The integration uses the public
[`before_tool_call.requireApproval` hook](https://docs.openclaw.ai/plugins/plugin-permission-requests).

## Coding Standards

Agent System follows the shared JavaScript, OpenClaw plugin, documentation, and Leia conventions in the [Tanaab Canon repository](https://github.com/tanaabased/canon). The repository's [AGENTS.md](./AGENTS.md) adds Agent System-specific identity, configuration, structure, and validation boundaries.

Capability-specific guides live beside their tool or channel. The planned
third-party integration boundary is documented in [Tool API](./API.md); the
current `api/` implementation remains internal to Agent System.

## Documentation

Read [Documentation Design](./DOCUMENTATION.md) before editing docs: it owns the
structure, change gate, reference formats, worked examples, and review requirements.
