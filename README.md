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

Agent System is an OpenClaw plugin for giving an agent workspace a reproducible identity, deterministic environment, secure credential boundary, agent-aware tools, and explicit installation procedure.

> [!NOTE]
> Requires OpenClaw 2026.7.1-2 or newer. The plugin supports macOS and Linux; CI exercises macOS 26 and Ubuntu 24.04. The current implementation handles workspace manifests, OpenClaw agent registration and public identity, explicit per-agent environment values from dotenv, inline, and 1Password Environment sources, agent-scoped OP credential management through macOS Keychain, Linux Secret Service, and an owner-only file fallback, executable path projection for OpenClaw exec and local Codex native shell commands, and a generic agent-scoped GitHub CLI tool with destructive, admin, and unknown-operation policy. Git identity and workspace installation scripts remain product work described in [SPEC.md](https://github.com/tanaabased/openclaw-agent-system/blob/main/SPEC.md).

## Overview

Agent System is intended to turn one strict, workspace-owned `agent.yaml` manifest into:

- a stable public and Git identity
- a deterministic environment assembled from declared sources
- secure access to host bootstrap credentials such as a 1Password service-account token
- agent-aware tools that consume only declared action credentials
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
  email:
    from-environment: AGENT_EMAIL

environment:
  dotenv: .agent-system/env/base.env
  set:
    AGENT_COLOR: green
    AGENT_EMAIL: $COMPANY_EMAIL
  op: env_agent
  required:
    - AGENT_COLOR

github:
  host: github.com
  policy:
    destructive: ask
    admin: deny
    unknown: deny
  username:
    from-environment: GITHUB_USERNAME
  token: GITHUB_TOKEN
  ssh-keys: ~/.ssh/id_ed25519.pub
  ssh-signing-keys:
    path: .agent-system/keys/signing.pub
    title: Tanaabot signing key
  config:
    git-protocol: ssh
    telemetry: disabled
```

The preferred `.agent-system/agent.yaml` wins when both files exist. The current schema accepts the identity fields `id`, `name`, `email`, `description`, and `avatar`; ordered dotenv paths; string values under `environment.set`; ordered 1Password Environment ids; ordered workspace-relative executable directories under `environment.path-prepend`; `environment.required`; and GitHub CLI, account-key, and operation-policy configuration. `agent.id` is literal; `agent.name`, `agent.email`, and `github.username` accept either literal strings or an explicit `from-environment` reference to the completed Agent System environment. `github.token` is an optional environment-variable name, never a literal token; when omitted, the tool looks for `GH_TOKEN` and then `GITHUB_TOKEN` in the completed agent environment. Read and ordinary write operations are allowed; destructive, admin, and unknown operations default to `deny` and may be set to `allow` or agent-only `ask`. Declaring `github.ssh-keys` or `github.ssh-signing-keys` makes `github.username` and `github.token` required for safe account mutation. Each key section accepts one public key or path, a list, or object forms with `key` or `path` plus an optional `title`. Precedence is dotenv, then explicit set values, then 1Password Environments. Set values may reference the plugin process environment or external-source values with `$NAME` or `${NAME}`; host values are lookup inputs and are not automatically inherited.

1Password resolution uses the official JavaScript SDK and occurs only for an explicit environment consumer such as `agent-system env`. Agent System checks macOS Keychain or Linux Secret Service, then the agent-scoped file fallback, before its permanent `OP_SERVICE_ACCOUNT_TOKEN` process-environment fallback. The token is reserved bootstrap state: Agent System never exports it as an agent environment variable or prints it in normal diagnostics.

Unsupported sections and unknown or incorrectly cased keys fail validation. Anchors, aliases, explicit tags, symlinked manifests, and symlinked `.agent-system` directories are rejected.

## Usage

Validate the current directory or one configured OpenClaw agent workspace:

```sh
openclaw agent-system validate
openclaw agent-system validate --agent tanaabot
openclaw as validate --agent tanaabot
```

When the manifest declares `environment.op`, validate and store the process token before installation:

```sh
openclaw agent-system credentials validate op
openclaw agent-system credentials set op --from-env
openclaw agent-system credentials validate op
```

Install the agent represented by the current workspace:

```sh
cd /path/to/agent-workspace
openclaw agent-system install
```

`install` first checks global credential prerequisites, then reconciles the foundational agent and path lifecycle components followed by configured capabilities such as GitHub. The agent component requires `agent.name`, resolves it from the completed Agent System environment when declared with `from-environment`, adds the OpenClaw agent when absent, and reconciles the manifest-owned name and optional avatar. `agent.email` remains lazy until a consumer such as the planned Git tool needs it. The path component creates the workspace `bin/` directory, prepends the workspace bin, declared workspace paths, and Agent System's packaged bin to OpenClaw exec, and manages the equivalent literal path in `.codex/config.toml` for local Codex native shell commands. Agent System-owned Codex config is visibly listed in the workspace `.gitignore`; an existing user-managed Codex config is left untouched with a warning. The GitHub component reconciles a private token-free GitHub CLI config and adds missing declared authentication and SSH-signing public keys. It never removes or retitles account keys. If `environment.op` is declared, installation verifies stored access before any component mutates state; it does not use the process-token fallback, prompt, import the process token, or store credentials. Every component verifies the state it owns, and repeated installation reports an explicit unchanged outcome for each active component. An existing agent id bound to another workspace is reported as a conflict instead of being silently replaced.

Inspect agent registration, public identity, executable paths, and configured capability state without repairing it:

```sh
openclaw agent-system doctor
openclaw agent-system doctor --agent tanaabot --json
```

Resolve and inspect Agent System environment metadata without printing values:

```sh
openclaw agent-system env
openclaw agent-system env --agent tanaabot --json
```

At runtime, the plugin loads a matching manifest at `session_start` and `before_prompt_build` and emits value-free manifest lifecycle diagnostics. It does not resolve or inject general environment values at either hook. A configured `github` section adds the packaged `$tanaab-github-cli` skill and concise preference guidance for `agent_system_github`. The tool accepts ordinary noninteractive `gh` arguments plus optional bounded stdin, binds them to trusted agent context, applies the manifest policy before credentials, resolves only the selected agent token, generates an isolated per-agent `GH_CONFIG_DIR`, verifies `github.username` when configured, launches the real `gh` executable without a shell, bounds and redacts output, and emits metadata-only call logs. Agent-originated `ask` decisions use OpenClaw approval and a one-use receipt; direct `openclaw as tool gh` and packaged `gh` calls cannot ask and fail closed. Authentication/config mutation, credential display, aliases, extensions, and browser/editor launch paths are blocked. Classification is defense in depth rather than a replacement for least-privilege GitHub tokens. Installation projects only `PATH` into the explicitly supported OpenClaw exec and local Codex native shell surfaces; other generic command tools retain their own environment contracts. Run OpenClaw with `OPENCLAW_LOG_LEVEL=debug` to see value-free `[agent-system] manifest_*`, `[agent-system] environment_*`, and tool call messages.

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
