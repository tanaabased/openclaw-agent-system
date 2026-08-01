# Agent System

<p align="center">
  <img src="./assets/agent-system.png" alt="Agent System mark" width="200" />
</p>

<p align="center">
  <a href="https://github.com/tanaabased/openclaw-agent-system/releases"><img src="https://img.shields.io/github/v/release/tanaabased/openclaw-agent-system" alt="Latest release" /></a>
  <a href="https://github.com/tanaabased/openclaw-agent-system/actions/workflows/pr-linter.yml"><img src="https://img.shields.io/github/actions/workflow/status/tanaabased/openclaw-agent-system/pr-linter.yml?label=lint" alt="Lint workflow" /></a>
  <a href="https://github.com/tanaabased/openclaw-agent-system/actions/workflows/pr-unit-tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/tanaabased/openclaw-agent-system/pr-unit-tests.yml?label=tests" alt="Unit test workflow" /></a>
  <a href="https://github.com/tanaabased/openclaw-agent-system/actions/workflows/pr-examples-tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/tanaabased/openclaw-agent-system/pr-examples-tests.yml?label=examples" alt="Example test workflow" /></a>
  <img src="https://img.shields.io/badge/OpenClaw-plugin-00c88a" alt="OpenClaw plugin" />
</p>

Agent System is an OpenClaw plugin for giving an agent workspace a reproducible identity, deterministic environment, secure credential boundary, and explicit installation procedure.

> [!NOTE]
> This repository currently provides the working plugin and delivery scaffold. Manifest discovery, identity application, environment resolution, credentials, installation, and diagnostics remain product work described in [SPEC.md](./SPEC.md).

## Overview

Agent System is intended to turn one strict, workspace-owned `agent.yaml` manifest into:

- a stable public and Git identity
- a deterministic environment assembled from declared sources
- secure access to host bootstrap credentials such as a 1Password service-account token
- an inspectable installation plan and an explicitly invoked installation flow
- read-only validation and drift diagnostics

YAML schema keys use kebab-case while TypeScript uses camelCase. The scaffold includes focused TypeScript ports of Core Next's `encode` and `decode` utilities as the initial conversion primitives. Manifest code will apply those primitives only to schema-owned keys so literal values such as environment-variable names remain unchanged.

## Current command

The plugin registers one canonical OpenClaw command and a shorter alias:

```sh
openclaw agent-system
openclaw as
```

Both commands currently confirm that the plugin is installed and route through the same implementation. Future product commands will live under the canonical `agent-system` command tree.

## Development

Use the pinned Bun and Node.js versions, then install the dependencies:

```sh
bun install
```

Run the repository checks:

```sh
bun run lint
bun run typecheck
bun run test
bun run build
bun run plugin:check
```

When package contents or release wiring change, run the self-contained release package check:

```sh
bun run test:release
```

The release check builds the Node-targeted runtime, validates plugin metadata, creates and inspects a temporary npm archive, verifies its file boundaries and identity metadata, and requires ClawHub package validation to pass without warnings. It cleans up the temporary archive and does not publish the package.

Operational examples are executable Leia scenarios under `examples/`. They are GitHub Actions-only and must not be run as local repository validation. The initial install example installs the prepared archive through OpenClaw's managed npm-package path and verifies both `openclaw agent-system` and `openclaw as`. Pull requests run the example on macOS and Ubuntu independently from lint, unit, and release checks.

Published GitHub releases run independent, release-shaped preparation and validation jobs for npm trusted publishing and ClawHub.

## Project direction

[SPEC.md](./SPEC.md) defines the first implementation path and its security boundaries. It is product intent rather than evidence that a feature has already shipped.

## Issues, Questions and Support

Use the [GitHub issue queue](https://github.com/tanaabased/openclaw-agent-system/issues) for bugs and feature requests.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for implemented changes and [GitHub releases](https://github.com/tanaabased/openclaw-agent-system/releases) for published artifacts.

## Maintainers

- [@pirog](https://github.com/pirog)

## Contributors

<a href="https://github.com/tanaabased/openclaw-agent-system/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=tanaabased/openclaw-agent-system" alt="Agent System contributors" />
</a>

Made with [contrib.rocks](https://contrib.rocks).

## License

Agent System is licensed under the [MIT License](./LICENSE).
