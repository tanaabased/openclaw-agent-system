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
> Requires OpenClaw 2026.7.1-2 or newer. The plugin supports macOS and Linux; CI exercises macOS 26 and Ubuntu 24.04. The current Phase 1 implementation handles workspace manifests, OpenClaw agent registration and public identity, and explicit per-agent environment values with restricted host references and required-value checks. Additional environment sources, credentials, Git identity, and workspace installation scripts remain product work described in [SPEC.md](https://github.com/tanaabased/openclaw-agent-system/blob/main/SPEC.md).

## Overview

Agent System is intended to turn one strict, workspace-owned `agent.yaml` manifest into:

- a stable public and Git identity
- a deterministic environment assembled from declared sources
- secure access to host bootstrap credentials such as a 1Password service-account token
- an inspectable installation plan and an explicitly invoked installation flow
- read-only validation and drift diagnostics

YAML schema keys use kebab-case while TypeScript uses camelCase. The scaffold includes focused TypeScript ports of Core Next's `encode` and `decode` utilities as the initial conversion primitives. Manifest code will apply those primitives only to schema-owned keys so literal values such as environment-variable names remain unchanged.

## Installation

Install the current development build from a source checkout:

```sh
git clone https://github.com/tanaabased/openclaw-agent-system.git
cd openclaw-agent-system
bun install
bun run build
openclaw plugins install --link .
openclaw plugins enable agent-system
openclaw plugins inspect agent-system --runtime --json
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for source-install caveats, the recommended isolated DevGuard workflow, and repository validation.

## Current manifest

An agent workspace opts into Agent System with `.agent-system/agent.yaml` or the shorter root-level `agent.yaml`:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot

environment:
  dotenv: .agent-system/env/base.env
  set:
    AGENT_COLOR: green
  required:
    - AGENT_COLOR
```

The preferred `.agent-system/agent.yaml` wins when both files exist. The current schema accepts the identity fields `id`, `name`, `description`, and `avatar`; one or more ordered workspace-relative files under `environment.dotenv`; string values under `environment.set`; and `environment.required`. Later dotenv files override earlier files, and explicit set values override the dotenv layers. Set values may reference the plugin process environment or final dotenv values with `$NAME` or `${NAME}`; host values are lookup inputs and are not automatically inherited. Unsupported sections and unknown or incorrectly cased keys fail validation. Anchors, aliases, explicit tags, symlinked manifests, and symlinked `.agent-system` directories are rejected.

## Usage

Validate the current directory or one configured OpenClaw agent workspace:

```sh
openclaw agent-system validate
openclaw agent-system validate --agent tanaabot
openclaw as validate --agent tanaabot
```

Install the agent represented by the current workspace:

```sh
cd /path/to/agent-workspace
openclaw agent-system install
```

`install` requires `agent.name`, adds the OpenClaw agent when absent, and reconciles the manifest-owned name and optional avatar. It is safe to rerun when the agent already matches. An existing agent id bound to another workspace is reported as a conflict instead of being silently replaced.

Resolve and inspect Agent System environment metadata without printing values:

```sh
openclaw agent-system env
openclaw agent-system env --agent tanaabot --json
```

At runtime, the plugin loads a matching manifest at `session_start` and emits value-free manifest lifecycle diagnostics. It does not resolve environment values at session startup or inject them into OpenClaw `exec`, Codex `exec_command`, or other generic command tools. `agent-system env` is the current explicit environment consumer and validation surface. Run OpenClaw with `OPENCLAW_LOG_LEVEL=debug` to see value-free `agent_system.manifest_*` events; explicit environment inspection also emits `agent_system.environment_*` events.

See [ADVANCED.md](./ADVANCED.md) for the complete current manifest, logging, and CLI references, plus clearly marked planned surfaces.

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) for source installation, the recommended DevGuard workflow with `tanaabot`, repository testing, package validation, and coding standards.

## Project direction

[SPEC.md](https://github.com/tanaabased/openclaw-agent-system/blob/main/SPEC.md) defines the first implementation path and its security boundaries. It is product intent rather than evidence that a feature has already shipped.

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
