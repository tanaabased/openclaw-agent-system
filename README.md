# Agent System

<p align="center">
  <img src="./assets/icon.png" alt="Agent System mark" width="180" />
</p>

<p align="center">
  <a href="https://github.com/tanaabased/openclaw-agent-system/releases"><img src="https://img.shields.io/github/v/release/tanaabased/openclaw-agent-system" alt="Latest release" /></a>
  <a href="https://github.com/tanaabased/openclaw-agent-system/actions/workflows/pr-examples-tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/tanaabased/openclaw-agent-system/pr-examples-tests.yml?label=Examples" alt="Leia example tests" /></a>
  <a href="https://github.com/tanaabased/openclaw-agent-system/actions/workflows/pr-notification-tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/tanaabased/openclaw-agent-system/pr-notification-tests.yml?label=Notifications" alt="GitHub notification tests" /></a>
  <img src="https://img.shields.io/badge/macOS-26-111827" alt="macOS 26" />
  <img src="https://img.shields.io/badge/Ubuntu-24.04-00c88a" alt="Ubuntu 24.04" />
</p>

Agent System equips each OpenClaw agent with its own identity, environment, and
credentials. Declare the agent's configuration in `agent.yaml`, then run
`openclaw agent-system install` from the workspace to register it and configure
its managed tools.

**Current cool capabilities:**

- **1Password-backed per-agent SSH private keys are never written to disk.**
- **Each agent gets its own Git authorship, signing, and GitHub identity.**
- **Work mode turns an assigned GitHub issue into a delivery pull request.**
- **Automatically route GitHub issues to models matched to their complexity.**

> [!NOTE]
> Requires OpenClaw 2026.9.5 or newer and is developed against 2026.9.5. See
> [version compatibility](./ADVANCED.md#version-compatibility).

> [!WARNING]
> Agent System remains a work in progress. Development and Leia coverage focus
> on OpenClaw's native and Codex harnesses. Other agent harnesses may work, but
> they are not yet part of the compatibility test matrix.

## Overview

Today, Agent System:

- registers an agent workspace with OpenClaw and reconciles its public identity
- assembles environment variables and credentials per agent from declared dotenv, inline, and 1Password sources
- wraps supported tools with the active agent's declared configuration, environment, credentials, and workspace boundaries
- applies each tool's operation-specific `allow` or `deny` policy before resolving credentials or executing the operation
- validates manifests, installs configured components, projects executable paths, and reports installed-state drift

## Ships With

### Tools

- [`agent_system_git`](./tools/git/README.md) — Runs ordinary Git commands with the agent's identity, SSH configuration, signing, and operation policy.
- [`agent_system_git_worktree`](./tools/git/README.md#gitworktrees) — Prepares, lists, and removes durable managed worktrees.
- [`agent_system_github`](./tools/github/README.md) — Runs ordinary GitHub CLI commands with the agent's credential, isolated configuration, and operation policy.

### Channels

- [`agent-system-github`](./channels/github/README.md) — Polls and admits approved GitHub assignments, prepares managed issue worktrees, and keeps issue and delivery pull-request comments in one lifecycle session.

### Skills

- [Codex binding](./skills/codex-binding/SKILL.md) — Binds one Codex plugin installation to one Agent System workspace.
- [Git CLI](./skills/git-cli/SKILL.md) — Guides agents through ordinary Git operations with `agent_system_git`.
- [Git worktree](./skills/git-worktree/SKILL.md) — Guides agents through preparing, reusing, and removing managed worktrees.
- [GitHub CLI](./skills/github-cli/SKILL.md) — Guides agents through GitHub operations with `agent_system_github`.
- [GitHub Update](./skills/github-update/SKILL.md) — Reconciles private notification progress with the owning public issue and publishes one safe, concise update when needed.

## Installation

### OpenClaw

Install the current release from ClawHub:

```sh
openclaw plugins install clawhub:@tanaab/openclaw-agent-system --accept-capabilities
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true
```

To select npm explicitly instead:

```sh
openclaw plugins install npm:@tanaab/openclaw-agent-system --accept-capabilities
openclaw config set plugins.entries.agent-system.hooks.allowConversationAccess true
```

Either install command accepts Agent System's declared capabilities, then
registers and enables the `agent-system` plugin. The explicit conversation-access
grant lets Agent System add manifest and GitHub lifecycle guidance through
OpenClaw's `before_prompt_build` hook.

For a development checkout, follow [Install from source](./DEVELOPMENT.md#install-from-source).

### Codex

Install the same npm release with [Codex Tools](https://github.com/tanaabased/codex-tools):

```sh
npm install --global @tanaab/codex-tools
codex-tools install npm:@tanaab/openclaw-agent-system --dry-run --json
codex-tools install npm:@tanaab/openclaw-agent-system
```

Codex Tools registers the personal marketplace and installs the plugin. On the
first fresh task, Codex warns that the bundled SessionStart hook needs review.
Open `/hooks`, inspect and trust the Agent System hook, then start another fresh
task. Installation does not trust the hook automatically; Codex binds trust to
its exact definition and asks again after that definition changes.

Ask Codex to bind this plugin installation to one workspace:

```text
Use $agent-system-codex-binding to bind this plugin to /absolute/path/to/agent-workspace.
```

The skill previews the canonical directory and its current manifest state before
asking for confirmation. A missing or malformed manifest does not block the
binding: choose the explicit bind-anyway path and Agent System context remains
inactive until the workspace has a valid manifest. Start a fresh task after any
binding change. See [Codex workspace binding](./ADVANCED.md#codex-workspace-binding)
for state, refresh, and projection details.

The Codex plugin supplies skills and this non-secret workspace context. OpenClaw
remains the owner of Agent System installation, channels, model-facing tools,
credentials, and declared environment resolution.

## Usage

Add `.agent-system/agent.yaml` to the workspace you want Agent System to manage. A root-level `agent.yaml` is also supported as a shorthand.

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email:
    from-environment: AGENT_EMAIL

models:
  default: { model: openai/gpt-6-astra, effort: high }
  low: { model: openai/gpt-5.6-terra, effort: medium }
  medium: { model: openai/gpt-5.6-sol, effort: high }
  high: { model: openai/gpt-6-astra, effort: xhigh }

memory:
  search:
    provider: openai
    model: text-embedding-3-small
    api-key: EMBEDDINGS_API_KEY

environment:
  # import this agent's identity and tool credentials from 1password.
  op: z7q4m2n9v6k3p8r5t1w0x4c2ba
  set:
    EMBEDDINGS_API_KEY: $OPENAI_API_KEY
    SSH_KEY:
      from-op: 'op://v4u7l2t9n5p8r1c6x3z0m4q7da/ssh-key/private key?ssh-format=openssh'
  required:
    - AGENT_EMAIL
    - EMBEDDINGS_API_KEY
    - GH_TOKEN_TANAABOT
    - SSH_KEY

github:
  username: tanaabot
  token: GH_TOKEN_TANAABOT

git:
  ssh:
    private-keys:
      from-environment: SSH_KEY
```

From that workspace, store the 1Password bootstrap credential when needed, then validate and install the agent:

```sh
# persist the current 1password service account token for this agent.
openclaw agent-system credentials set op --from-env

# validate the manifest, then reconcile the agent and its configured components.
openclaw agent-system validate
openclaw agent-system install

# inspect managed state without changing it.
openclaw agent-system doctor

# verify the github identity supplied by this agent's environment.
openclaw agent-system tool gh -- api user --jq .login
```

For workspace preparation, add an optional `setup` declaration:

```yaml
setup:
  check: test -d repos
  apply: mkdir -p repos
```

`install` prepares the agent's managed tools before running setup, asks for
confirmation interactively, and proceeds without a prompt in CI or with `--yes`.
Doctor runs setup checks without applying changes. Use checks and repeatable
applies to make subsequent installs safe; arbitrary setup effects are not rolled
back. See [Setup](./ADVANCED.md#setup) for inline scripts, named steps, runtime
filters, and cloning repositories with the agent's Git/GitHub identity.

Agent System does not provision model credentials, and memory credentials remain
agent environment bindings rather than `openclaw.json` values. See
[Advanced](./ADVANCED.md) for the complete manifest and CLI references.

## Development

See [Development](./DEVELOPMENT.md) for source installation, the recommended DevGuard workflow, validation, and coding standards.

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
