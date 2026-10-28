# Agent System

<p align="center">
  <img src="./assets/icon.png" alt="Agent System mark" width="180" />
</p>

<p align="center">
  <a href="https://github.com/tanaabased/openclaw-agent-system/releases"><img src="https://img.shields.io/github/v/release/tanaabased/openclaw-agent-system" alt="Latest release" /></a>
  <a href="https://github.com/tanaabased/openclaw-agent-system/actions/workflows/pr-examples-os.yml"><img src="https://img.shields.io/github/actions/workflow/status/tanaabased/openclaw-agent-system/pr-examples-os.yml?label=Examples" alt="Leia example tests" /></a>
  <img src="https://img.shields.io/badge/macOS-26-111827" alt="macOS 26" />
  <img src="https://img.shields.io/badge/Ubuntu-24.04-00c88a" alt="Ubuntu 24.04" />
</p>

Agent System puts your agent's identity, environment, automations, credential bindings,
and skills in its own repo. Interact with your agents on GitHub like you do with human
developers. It's agent dotfiles and a workflow runtime in one place.

Clone the repo and run `openclaw agent-system install` to get your OpenClaw agent
ready for work.

Built primarily for OpenClaw agents, Agent System can also [bind your Codex profile](./CODEX.md)
to a workspace. Both runtimes support [GitHub issue-assignment workflows](./channels/github/README.md),
from assessment through implementation and PR delivery.

See example agents:

- [EMORI](https://github.com/tanaabased/emori) — Co-founder and operating partner running on OpenClaw.
- [smutlord](https://github.com/tanaabased/smutlord) — Bug-fixing agent running on OpenClaw.
- [pirog/me](https://github.com/pirog/me) — Mike Pirog's bound Codex profile.

> [!NOTE]
> The OpenClaw integration requires 2026.10.8 or newer and is developed against 2026.10.8. See
> [version compatibility](#version-compatibility).

> [!WARNING]
> Agent System remains a work in progress. Development and Leia coverage focus
> on OpenClaw's native and Codex harnesses. Other agent harnesses may work, but
> they are not yet part of the compatibility test matrix.

## Overview

- **Configuration travels with the repo:** keep identity, environment, credential bindings, automations, setup, and skill selections in `agent.yaml`, alongside your workspace skills and guidance.
- **Assign work like you would to a developer:** use GitHub issues for assessment, implementation, and pull-request delivery in OpenClaw or Codex.
- **An identity of its own:** give each OpenClaw agent its own Git authorship, signing, and GitHub account. Standalone Codex uses your native host identity.
- **SSH keys stay off disk:** 1Password-backed SSH private keys never need to be written to disk.
- **Policy before credentials:** managed operations enforce workspace boundaries and operation policy before loading secrets.
- **The right model for the work:** route GitHub issues to declared model tiers by complexity.
- **Put recurring work on the clock:** schedule repository commands and agent prompts from `agent.yaml`.
- **Repeatable setup:** rerun Install to apply configuration and repeat dependency setup safely; use Doctor to find drift.

## Ships With

### Tools

Native tools run in OpenClaw, including OpenClaw-hosted Codex. Standalone Codex
uses the [shared skills](#skills) through its native host interfaces.

- [`agent_system_dispatch`](./tools/dispatch/README.md) — Coordinate managed issue work, direct assessment, implementation, replies, and retirement.
- [`agent_system_doctor`](./tools/doctor/README.md) — Inspect the active agent’s readiness and run declared checks after chat approval.
- [`agent_system_git`](./tools/git/README.md) — Run ordinary Git commands with the agent's identity, SSH configuration, signing, and operation policy.
- [`agent_system_git_worktree`](./tools/git/worktree/README.md#agent_system_git_worktree) — Prepare, list, and remove durable managed worktrees.
- [`agent_system_github`](./tools/github/README.md) — Run ordinary GitHub CLI commands with the agent's credential, isolated configuration, and operation policy.
- [`agent_system_google`](./tools/google/README.md) — Run Google data commands with the agent's verified account and isolated OAuth credentials.
- [`agent_system_install`](./tools/install/README.md) — Apply the active agent’s configuration and setup after chat approval.
- [`agent_system_intake`](./tools/intake/README.md) — Inspect or scan GitHub assignments without creating task sessions.
- [`agent_system_model_routing`](./tools/model-routing/README.md) — Resolve model and effort candidates from the agent's profiles.

### GitHub Workflows

- [GitHub notifications](./channels/github/README.md) — Start approved assignments through native automations and keep each issue’s conversation and assessment.

### CLI

- [`openclaw agent-system automations`](./CLI.md#openclaw-agent-system-automations-list) — Inspect, sync, and run declared jobs and read their history.
- [`openclaw agent-system backup`](./CLI.md#openclaw-agent-system-backup-create) — Create, verify, restore, and prune backups; clean up abandoned temporary artifacts.
- [`openclaw agent-system credentials`](./CLI.md#openclaw-agent-system-credentials-set-op) — Set, validate, and remove the 1Password bootstrap credential; inspect and flush its cache.
- [`openclaw agent-system doctor`](./CLI.md#openclaw-agent-system-doctor) — Inspect readiness and drift.
- [`openclaw agent-system env`](./CLI.md#openclaw-agent-system-env) — Inspect environment sources without exposing values.
- [`openclaw agent-system install`](./CLI.md#openclaw-agent-system-install) — Apply configuration and dependency setup.
- [`openclaw agent-system instance`](./CLI.md#openclaw-agent-system-instance-inspect) — Inspect or rename the installation identity, or explicitly rotate its ID.
- [`openclaw agent-system notifications`](./channels/github/CLI.md) — Refresh, inspect, wait for, or reset GitHub notification management.
- [`openclaw agent-system tool`](./CLI.md#openclaw-agent-system-tool) — Run a configured tool as the agent.
- [`openclaw agent-system validate`](./CLI.md#openclaw-agent-system-validate) — Validate the workspace manifest.
- [Complete CLI reference](./CLI.md) — All commands, options, and examples.

### Configuration

- [Manifest reference](./MANIFEST.md) — Repository-owned agent configuration and setup.
- [Global configuration](./CONFIG.md) — Operator-owned OpenClaw plugin settings.

### Skills

- [Codex binding](./skills/codex-binding/SKILL.md) — Bind the standalone plugin to one workspace.
- [Doctor](./skills/doctor/SKILL.md) — Inspect readiness without applying repairs.
- [Git CLI](./skills/git-cli/SKILL.md) — Work with the agent's Git identity and policy.
- [Git worktree](./skills/git-worktree/SKILL.md) — Prepare, reuse, and remove managed worktrees.
- [GitHub CLI](./skills/github-cli/SKILL.md) — Work through the agent's GitHub account.
- [GitHub reply](./skills/github-reply/SKILL.md) — Compose a reply using the agent's configured guidance and voice; publish only when authorized.
- [Google CLI](./skills/google-cli/SKILL.md) — Work through the agent's Google account.
- [Install](./skills/install/SKILL.md) — Install the active workspace through its owning runtime.
- [Model routing](./skills/model-routing/SKILL.md) — Select model and effort candidates for new tasks.
- [Notifications reset](./skills/notifications-reset/SKILL.md) — Reset notification tracking, with optional purge of managed chats and checkouts.
- [Task assessment](./skills/task-assessment/SKILL.md) — Investigate an issue and retain a plan, questions, or a setup blocker.
- [Task implementation](./skills/task-implementation/SKILL.md) — Implement an authorized issue plan in the existing checkout.
- [Task launch](./skills/task-launch/SKILL.md) — Start or reuse managed issue work without assignment or scheduled intake.
- [Task retirement](./skills/task-retirement/SKILL.md) — Retire one managed task without closing or unassigning its issue.
- [Task update](./skills/task-update/SKILL.md) — Publish material progress missing from the issue when requested.

## Installation

### Version Compatibility

| Agent System release | Minimum OpenClaw | Development target |
| -------------------- | ---------------- | ------------------ |
| Next release         | 2026.10.8        | 2026.10.8          |
| 0.9.0                | 2026.10.6        | 2026.10.6          |
| 0.8.0                | 2026.9.5         | 2026.9.6           |
| 0.7.0                | 2026.9.5         | 2026.9.6           |
| 0.6.0                | 2026.9.2         | 2026.9.3           |
| 0.5.3                | 2026.7.1         | 2026.7.2           |

Compatibility metadata declares the minimum supported OpenClaw version. Build
metadata and development dependencies pin the newest version tested for the
release.

For the update order and existing-installation steps, see [upgrading](./UPGRADING.md).

### OpenClaw

Install the current release from npm:

> [!NOTE]
> ClawHub publication is currently blocked by an [upstream backend error](https://github.com/openclaw/clawhub/issues/3788).
> Its listing has an older release. Use npm for the current version.

```sh
openclaw plugins install npm:@tanaab/openclaw-agent-system --accept-capabilities
```

This command accepts the declared capabilities, registers the plugin, and enables
it. GitHub workflows require explicit [configuration and installation](./channels/github/README.md#configuration).

### Codex

Follow the [Codex installation and workspace setup guide](./CODEX.md#plugin-installation)
to install the standalone plugin, approve its hooks, and bind your profile to a workspace.

### From Source

For an OpenClaw development checkout, follow [Install from source](./DEVELOPMENT.md#install-from-source).
For standalone Codex source installation and cache updates, see [Codex development](./DEVELOPMENT.md#codex).

## Usage

Add `.agent-system/agent.yaml` to the workspace you want Agent System to manage. A root-level `agent.yaml` is also supported as a shorthand. The optional setup script below assumes Homebrew is already installed.

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

setup-host:
  runtimes: [openclaw]
  apply: brew install jq ripgrep

setup-agent:
  runtimes: [openclaw]
  apply: |
    # install and configure the diffs plugin for browser previews.
    openclaw plugins inspect diffs >/dev/null 2>&1 || openclaw plugins install clawhub:@openclaw/diffs --accept-capabilities
    openclaw plugins enable diffs --accept-capabilities
    openclaw config set plugins.entries.diffs.config.defaults.mode view
    # prepare local working directories.
    mkdir -p repos artifacts
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

`install` runs host setup, prepares managed tools, then runs agent setup. It asks
for consent interactively; CI or `--yes` runs unattended. Doctor runs setup
checks without repairs. Write setup commands that are safe to repeat: a failure does not undo earlier
changes. See [Setup](./MANIFEST.md#setup) for syntax and runtime filters.

Add recurring work to the same manifest, then rerun Install:

```yaml
automations:
  - id: daily-review
    schedule: every 24 hours
    prompt: Review the repository for actionable maintenance work and report the highest-priority finding.
  - id: daily-backup
    runtimes: [openclaw]
    schedule: every 24 hours
    run: [openclaw, agent-system, backup, create, --json]
```

OpenClaw runs command jobs without a model; standalone Codex supports recurring
prompt jobs through the desktop app. See [automation configuration](./MANIFEST.md#automations)
and [Codex support](./MANIFEST.md#codex-execution-and-ownership) for runtime requirements.

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
