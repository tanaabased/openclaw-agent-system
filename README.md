<h1 align="center">Agent System</h1>

<p align="center">
  <img src="./assets/icon.png" alt="Agent System mark" width="180" />
</p>

<p align="center">
  <a href="https://github.com/tanaabased/openclaw-agent-system/releases/latest"><img src="https://img.shields.io/github/v/release/tanaabased/openclaw-agent-system?label=STABLE&amp;color=blue" alt="Latest stable release" /></a>
  <a href="https://github.com/tanaabased/openclaw-agent-system/releases"><img src="https://img.shields.io/github/v/release/tanaabased/openclaw-agent-system?include_prereleases&amp;sort=date&amp;label=EDGE&amp;color=blue" alt="Latest release including prereleases" /></a>
  <a href="https://github.com/tanaabased/openclaw-agent-system/actions/workflows/pr-issue-assignments.yml?query=event%3Apull_request"><img src="https://img.shields.io/github/actions/workflow/status/tanaabased/openclaw-agent-system/pr-issue-assignments.yml?event=pull_request&amp;label=ASSIGNMENTS" alt="Issue assignment tests" /></a>
</p>

<p align="center">
  <a href="#openclaw"><img src="https://img.shields.io/badge/OPENCLAW-plugin-6f42c1" alt="Install the OpenClaw plugin" /></a>
  <a href="#codex"><img src="https://img.shields.io/badge/CODEX-plugin-6f42c1" alt="Install the Codex plugin" /></a>
</p>

Agent System puts your agent's identity, environment, automations, credential bindings,
and skills in its own repo. Interact with your agents on GitHub like you do with human
developers. It's agent dotfiles and a workflow runtime in one place.

[Configure your `agent.yaml`](#usage), clone your agent's repo, and run
[`openclaw agent-system install`](#cli) to set up its [environment](#environment),
[tools](#tools), [skills](#skills), and [GitHub workflows](#github-workflows) from one [configuration](#configuration).

See example agents:

- [EMORI](https://github.com/tanaabased/emori) — Co-founder and operating partner running on OpenClaw.
- [smutlord](https://github.com/tanaabased/smutlord) — Bug-fixing agent running on OpenClaw.
- [tanaabot](https://github.com/tanaabased/tanaabot) — Codex Dot for managed and scheduled tasks in Codex Cloud.
- [pirog/me](https://github.com/pirog/me) — Mike Pirog's bound Codex profile.

## Overview

- **Configuration travels with the repo:** keep identity, environment, credential bindings, automations, setup, and skill selections in `agent.yaml`, alongside your workspace skills and guidance.
- **Assign work like you would to a developer:** use GitHub issues for assessment, implementation, and pull-request delivery in OpenClaw or Codex.
- **An identity of its own:** give each OpenClaw agent its own Git authorship, signing, and GitHub account. Standalone Codex uses your native host identity.
- **SSH keys stay off disk:** 1Password-backed SSH private keys never need to be written to disk.
- **Policy before credentials:** managed operations enforce workspace boundaries and operation policy before loading secrets.
- **The right model for the work:** route GitHub issues to declared model tiers by complexity.
- **Put recurring work on the clock:** schedule repository commands and agent prompts from `agent.yaml`.
- **Repeatable setup:** rerun Install to apply configuration and repeat dependency setup safely; use Doctor to find drift.

## Installation

Check [version compatibility](#version-compatibility) before you begin.

### OpenClaw

```sh
openclaw plugins install npm:@tanaab/openclaw-agent-system --accept-capabilities
```

Then [configure your workspace](#usage).

### Codex

```sh
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system
```

Follow [Codex workspace setup](./CODEX.md#workspace-setup) to approve the hooks and bind your profile.

### From Source

With the [development prerequisites](./DEVELOPMENT.md#requirements) installed, link a local checkout to OpenClaw:

```sh
git clone https://github.com/tanaabased/openclaw-agent-system.git
cd openclaw-agent-system
bun run sync && openclaw plugins install --link . --accept-capabilities && openclaw plugins enable agent-system
```

See [source installation](./DEVELOPMENT.md#install-from-source) for verification and standalone Codex development.

## Usage

Review the `agent.yaml` manifest in your workspace. The examples below show common
settings for [our EMORI agent](https://github.com/tanaabased/emori) and belong in the same
`.agent-system/agent.yaml` file (or `agent.yaml` at the repo root). See the
[manifest reference](./MANIFEST.md) for the full configuration.

### Agent

Give EMORI a workspace identity and read her email from the environment.

```yaml
schema-version: 1

agent:
  id: emori
  name: EMORI
  email:
    from-environment: AGENT_EMAIL
```

### Environment

Load values from 1Password and declare which variables EMORI needs.

```yaml
environment:
  op: z7q4m2n9v6k3p8r5t1w0x4c2ba
  set:
    EMBEDDINGS_API_KEY: $OPENAI_API_KEY
    SSH_KEY:
      from-op: 'op://v4u7l2t9n5p8r1c6x3z0m4q7da/ssh-key/private key?ssh-format=openssh'
  required:
    - AGENT_EMAIL
    - EMBEDDINGS_API_KEY
    - GH_TOKEN_EMORI
    - SSH_KEY
```

### Models

Set the default model and choose a model and reasoning effort for each task tier.

```yaml
models:
  default: { model: openai/gpt-6.2-astra, effort: high }
  low: { model: openai/gpt-6.2-sol, effort: medium }
  medium: { model: openai/gpt-6.2-sol, effort: high }
  high: { model: openai/gpt-6.2-astra, effort: xhigh }
```

### Memory

Choose the embedding model for memory search and the environment variable that supplies its API key.

```yaml
memory:
  search:
    provider: openai
    model: text-embedding-3-small
    api-key: EMBEDDINGS_API_KEY
```

### GitHub

EMORI accepts assignments from pirog across `tanaabased` repos and requests PR reviews
from smutlord. Each night at 3 a.m. local time, she starts looking for work in a
Theme milestone. She can claim up to two issues per night and work on them independently.
Use an open milestone number in place of the example below.

```yaml
github:
  schema-version: 3
  username: emoriwan
  token: GH_TOKEN_EMORI
  routing: ['tanaabased/*']
  issue-assignment:
    allowed: ['@pirog', '@emoriwan']
    reviewers: ['@smutlord']
  issue-pickup:
    start: '03:00'
    projects:
      - repository: tanaabased/theme
        limit: 2
        milestone: { ids: 1, policy: only }
```

### Git and setup

Git uses EMORI's SSH key. Host setup uses an existing Homebrew installation to add
`jq` and `ripgrep`. Agent setup enables the diffs plugin and creates workspace directories.

```yaml
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

### Automations

Schedule a daily repository review and an OpenClaw backup.

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

### Apply the manifest

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

Agent System does not provision model credentials, and memory credentials remain
agent environment bindings rather than `openclaw.json` values. See
[Manifest Reference](./MANIFEST.md) for all workspace settings,
[CLI Reference](./CLI.md) for commands, and [Global Configuration](./CONFIG.md)
for operator-owned plugin settings.

## Ships With

### Tools

Native tools run in OpenClaw, including OpenClaw-hosted Codex. Standalone Codex
uses the [shared skills](#skills) through its native host interfaces.

- [`agent_system_context`](./tools/dispatch/README.md#agent_system_context) — Refresh current task context from the native conversation without input parameters.
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
- [Task assessment](./skills/task-assessment/SKILL.md) — Investigate an issue and present a plan or questions.
- [Task implementation](./skills/task-implementation/SKILL.md) — Implement an authorized issue plan in the existing checkout.
- [Task launch](./skills/task-launch/SKILL.md) — Start an independent issue task or continue an existing same-repository PR without waiting for scheduled intake.
- [Task retirement](./skills/task-retirement/SKILL.md) — Retire a managed task or explicitly selected unmanaged native chat without changing GitHub state.
- [Task update](./skills/task-update/SKILL.md) — Publish material progress missing from the issue when requested.

## Version Compatibility

| Agent System release | Minimum OpenClaw | Development target |
| -------------------- | ---------------- | ------------------ |
| 0.10.0 (upcoming)    | 2026.11.6        | 2026.11.6          |
| 0.9.0–0.9.2          | 2026.10.6        | 2026.10.6          |
| 0.8.0                | 2026.9.5         | 2026.9.6           |
| 0.7.0                | 2026.9.5         | 2026.9.6           |
| 0.6.0                | 2026.9.2         | 2026.9.3           |
| 0.5.3                | 2026.7.1         | 2026.7.2           |

The upcoming release supports macOS and Linux with Node.js `>=24.22.1 <25 || >=26.12.1`.
The development target is the OpenClaw version tested for that release. For the
upcoming release, OpenClaw-hosted Codex also requires `@openclaw/codex@2026.11.6`.
The tested harnesses are OpenClaw native and OpenClaw-hosted Codex. See
[Upgrading](./UPGRADING.md) for the order of host and plugin updates.

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
