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

Agent System puts your OpenClaw agent's identity, environment, and credential
configuration in the repo alongside setup steps for installing dependencies and
configuring the workspace. Clone the repo and run
`openclaw agent-system install` to get your agent ready for work.

Enable [GitHub notifications in Work mode](./channels/github/README.md), assign
an issue to the agent, and watch it work toward a delivery pull request.

Also available as a [minimal standalone Codex plugin](./CODEX.md).

> [!NOTE]
> The OpenClaw integration requires 2026.9.5 or newer and is developed against 2026.9.5. See
> [version compatibility](#version-compatibility).

> [!WARNING]
> Agent System remains a work in progress. Development and Leia coverage focus
> on OpenClaw's native and Codex harnesses. Other agent harnesses may work, but
> they are not yet part of the compatibility test matrix.

## Overview

- **Configuration travels with the repo:** keep identity, environment, credential bindings, and setup in `agent.yaml`; activate them with `openclaw agent-system install`.
- **Assign work like you would to a developer:** the GitHub notification channel turns issue assignments into agent work and delivery pull requests.
- **An identity of its own:** each agent gets its own Git authorship, signing, and GitHub account.
- **SSH keys stay off disk:** 1Password-backed SSH private keys never need to be written to disk.
- **Policy before credentials:** managed operations enforce workspace boundaries and operation policy before loading secrets.
- **The right model for the work:** route GitHub issues to declared model tiers by complexity.
- **Repeatable setup:** rerun Install to reconcile configuration and checked dependency installation; use Doctor to find drift.

## Ships With

### Tools

- [`agent_system_git`](./tools/git/README.md) — Runs ordinary Git commands with the agent's identity, SSH configuration, signing, and operation policy.
- [`agent_system_git_worktree`](./tools/git/README.md#gitworktrees) — Prepares, lists, and removes durable managed worktrees.
- [`agent_system_github`](./tools/github/README.md) — Runs ordinary GitHub CLI commands with the agent's credential, isolated configuration, and operation policy.

### Channels

- [`agent-system-github`](./channels/github/README.md) — Polls and admits approved GitHub assignments, prepares managed issue worktrees, and keeps issue and delivery pull-request comments in one lifecycle session.

### CLI

- [`openclaw agent-system validate`](./CLI.md#openclaw-agent-system-validate) — Validate the workspace manifest.
- [`openclaw agent-system env`](./CLI.md#openclaw-agent-system-env) — Inspect environment sources without exposing values.
- [`openclaw agent-system install`](./CLI.md#openclaw-agent-system-install) — Apply configuration and dependency setup.
- [`openclaw agent-system doctor`](./CLI.md#openclaw-agent-system-doctor) — Inspect readiness and drift.
- [`openclaw agent-system credentials set op`](./CLI.md#openclaw-agent-system-credentials-set-op) — Store the agent’s 1Password bootstrap credential.
- [`openclaw agent-system notifications`](./CLI.md#openclaw-agent-system-notifications) — Refresh and inspect GitHub assignments.
- [`openclaw agent-system tool`](./CLI.md#openclaw-agent-system-tool) — Run a configured tool as the agent.
- [Complete CLI reference](./CLI.md) — All commands, options, and examples.

### Configuration

- [Manifest reference](./MANIFEST.md) — Repository-owned agent configuration and setup.
- [Global configuration](./CONFIG.md) — Operator-owned OpenClaw plugin settings.

### Skills

- [Doctor](./skills/doctor/SKILL.md) — Inspect readiness without applying repairs.
- [Install](./skills/install/SKILL.md) — Install the active workspace through its owning runtime.
- [Git CLI](./skills/git-cli/SKILL.md) — Work with the agent's Git identity and policy.
- [Git worktree](./skills/git-worktree/SKILL.md) — Prepare, reuse, and remove managed worktrees.
- [GitHub CLI](./skills/github-cli/SKILL.md) — Work through the agent's GitHub account.
- [GitHub Update](./skills/github-update/SKILL.md) — Publish missing progress from a private notification session.
- [Codex binding](./skills/codex-binding/SKILL.md) — Bind the standalone plugin to one workspace.

## Installation

### OpenClaw

Install the current release from ClawHub:

```sh
openclaw plugins install clawhub:@tanaab/openclaw-agent-system --accept-capabilities
```

To select npm explicitly instead:

```sh
openclaw plugins install npm:@tanaab/openclaw-agent-system --accept-capabilities
```

Both commands accept the declared capabilities, register the plugin, and enable
it. When GitHub notifications are configured, `openclaw agent-system install`
also grants and verifies the required conversation-hook access; see
[hook setup](./channels/github/README.md#required-conversation-hook).

For a development checkout, follow [Install from source](./DEVELOPMENT.md#install-from-source).

### Version Compatibility

| Agent System release | Minimum OpenClaw | Development target |
| -------------------- | ---------------- | ------------------ |
| Unreleased           | 2026.9.5         | 2026.9.5           |
| 0.6.0                | 2026.9.2         | 2026.9.3           |
| 0.5.3                | 2026.7.1         | 2026.7.2           |

Compatibility metadata declares the minimum supported OpenClaw version. Build
metadata and development dependencies pin the newest version tested for the
release.

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

OpenClaw `install` prepares the agent's managed tools before running applicable
setup, asks for confirmation interactively, and proceeds without a prompt in CI
or with `--yes`. Doctor runs setup checks without applying changes. Use checks and
repeatable applies to make subsequent installs safe; arbitrary setup effects are
not rolled back. See [Setup](./MANIFEST.md#setup) for inline scripts, named steps,
runtime filters, and cloning repositories with the agent's Git/GitHub identity.

Agent System does not provision model credentials, and memory credentials remain
agent environment bindings rather than `openclaw.json` values. See
[Manifest Reference](./MANIFEST.md) for all workspace settings,
[CLI Reference](./CLI.md) for commands, and [Global Configuration](./CONFIG.md)
for operator-owned plugin settings.

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
