# Agent System

<p align="center">
  <img src="./assets/agent-system.png" alt="Agent System mark" width="180" />
</p>

<p align="center">
  <a href="https://github.com/tanaabased/openclaw-agent-system/releases"><img src="https://img.shields.io/github/v/release/tanaabased/openclaw-agent-system" alt="Latest release" /></a>
  <a href="https://github.com/tanaabased/openclaw-agent-system/actions/workflows/pr-examples-tests.yml"><img src="https://img.shields.io/github/actions/workflow/status/tanaabased/openclaw-agent-system/pr-examples-tests.yml?label=Leia" alt="Leia example tests" /></a>
  <img src="https://img.shields.io/badge/macOS-26-111827" alt="macOS 26" />
  <img src="https://img.shields.io/badge/Ubuntu-24.04-00c88a" alt="Ubuntu 24.04" />
</p>

Agent System makes an OpenClaw agent workspace self-onboarding: run `openclaw agent-system install` there to register and identify the agent, reconcile its supported configuration, and equip its managed tools to operate with that agent's own environment and credentials instead of a shared global identity.

> [!NOTE]
> Requires OpenClaw 2026.7.1-2 or newer. CI covers macOS 26 and Ubuntu 24.04.

> [!WARNING]
> Agent System is still a work in progress. Check back regularly for updates.

## Overview

Today, Agent System:

- registers an agent workspace with OpenClaw and reconciles its public identity
- assembles environment variables and credentials per agent from declared dotenv, inline, and 1Password sources
- wraps supported tools with the active agent's declared configuration, environment, credentials, and workspace boundaries
- applies each tool's operation-specific `allow`, `ask`, or `deny` policy before resolving credentials or executing the operation
- validates manifests, installs configured components, projects executable paths, and reports installed-state drift

## Installation

Install the current release from npm:

```sh
openclaw plugins install npm:@tanaab/openclaw-agent-system
openclaw plugins enable agent-system
```

For a development checkout, follow [Install from source](./DEVELOPMENT.md#install-from-source).

## Usage

Add `.agent-system/agent.yaml` to the workspace you want Agent System to manage. A root-level `agent.yaml` is also supported as a shorthand.

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email:
    from-environment: AGENT_EMAIL

environment:
  # import this agent's identity and tool credentials from 1password.
  op: z7q4m2n9v6k3p8r5t1w0x4c2ba
  set:
    SSH_KEY:
      from-op: 'op://v4u7l2t9n5p8r1c6x3z0m4q7da/ssh-key/private key?ssh-format=openssh'
  required:
    - AGENT_EMAIL
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

`install` is explicit and repeatable: it adds the OpenClaw agent when needed and reconciles only the state declared by the workspace. See [Advanced](./ADVANCED.md) for the complete manifest and CLI references.

## Tools

Agent System currently ships wrappers for:

- [`git`](./tools/git/README.md) for ordinary Git and managed worktrees
- [`gh`](./tools/github/README.md) for GitHub CLI operations

> [!TIP]
> For managed agents, disable competing Git and GitHub skills, plugins, and tool
> wrappers so requests consistently use Agent System's agent-scoped identity and
> policy boundaries.

Each wrapper uses the shared Agent System runtime for trusted agent binding,
environment and credential resolution, operation policy, execution, redaction,
and auditing. A public [Tool API](./API.md) is planned so other OpenClaw plugins
can add compatible wrappers through the same runtime.

> [!IMPORTANT]
> Model-facing `agent_system_*` tools are the agent-bound execution surface.
> `openclaw agent-system tool`, `credentials`, and the packaged command shims are
> trusted operator interfaces. Agent System guides agents to native tools and
> blocks recognized operator-command, credential, and cross-workspace attempts,
> but indirect scripts and unrestricted same-user host access remain outside
> that boundary. Run `doctor` to inspect the underlying command posture.

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
