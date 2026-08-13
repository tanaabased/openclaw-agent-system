# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The GitHub notifications channel is a local
[OpenClaw messaging channel](https://docs.openclaw.ai/channels) that turns
approved GitHub issue assignments into agent-scoped local work. It verifies the
agent, assigning actor, and repository before creating one managed worktree and
one local OpenClaw session for the issue.

> [!IMPORTANT]
> The channel does not currently fetch issue prose, comments, or mentions,
> invoke a model, or write to GitHub.

## Overview

- On the first successful cycle, records the agent's currently assigned open
  issues as a safe baseline without creating local work.
- On later cycles, discovers new assignments and rechecks the agent account,
  assigning actor, repository owner, and repository access.
- For each accepted assignment, creates or reuses one deterministic managed
  worktree and one local OpenClaw session.

The Gateway monitor runs this lifecycle in the background. The manual refresh
command runs the same intake path immediately. Both stop after local session
recording without dispatching an agent turn.

## Requirements

- Agent System installed and enabled
- Git available as `git`
- GitHub CLI available as `gh`
- an Agent System workspace manifest with an agent id and Git author email
- `git.worktrees`, `github.username`, `github.token`, and
  `github.notifications` configured
- the named GitHub token available in the completed Agent System environment

The GitHub account must have `write`, `maintain`, or `admin` access to every
repository from which the channel accepts assignments.

## Installation and Usage

Add the notification channel to `.agent-system/agent.yaml` or the root
`agent.yaml`. See [Configuration Reference](#configuration-reference) for every
field.

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email: tanaabot@tanaab.dev

environment:
  required:
    - GH_TOKEN_TANAABOT

git:
  worktrees: {}

github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  notifications:
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
```

From the agent workspace:

```sh
# check the manifest without changing installed state.
openclaw agent-system validate

# reconcile the agent and its notification route.
openclaw agent-system install

# inspect the installed route and monitor readiness.
openclaw agent-system doctor

# establish the first baseline or process later assignments immediately.
openclaw agent-system notifications refresh
```

Only assignments observed after the first successful baseline create local
work.

## Configuration Reference

Notifications share the surrounding GitHub host, account, and credential:

```yaml
github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  notifications:
    interval-minutes: 5
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
    allowed-repository-owners:
      - login: tanaabased
        node-id: O_kgDOB7x6Qw
```

| Field                       | Required | Default | Purpose                                  |
| --------------------------- | -------- | ------- | ---------------------------------------- |
| `approved-actors`           | yes      | none    | GitHub users allowed to assign work      |
| `allowed-repository-owners` | no       | any     | Filters assignments by repository owner  |
| `interval-minutes`          | no       | `5`     | Sets the polling interval from 1 to 1440 |

Every approved actor and allowed owner requires a GitHub login and immutable
GitHub node id. Node ids must be unique within each list.

`allowed-repository-owners` is an optional filter. When present, the channel
rejects assignments from repositories whose owner is not listed. It does not
grant repository access or approve that owner's members to assign work; the
agent account still needs sufficient repository access and the assigning actor
must still appear in `approved-actors`.

`github.token` names an environment variable and never accepts a literal token.
For private repositories, configure
[`git.ssh`](../../tools/git/README.md#gitsshprivate-keys) so the Git capability
can prepare the worktree without embedding a token in its clone URL.

## CLI

```text
openclaw agent-system notifications refresh [--agent <id>] [--json]
```

| Option         | Purpose                                                   |
| -------------- | --------------------------------------------------------- |
| `--agent <id>` | Selects an installed agent instead of workspace discovery |
| `--json`       | Returns an undecorated machine-readable result            |

The command bypasses only the configured polling interval. It preserves the
ordinary baseline, provider backoff, failure state, and per-agent execution
lease. A completed cycle may create a managed worktree and local session;
deferred and failed cycles return a nonzero exit code.

See the [complete CLI reference](../../ADVANCED.md#openclaw-agent-system-notifications-refresh)
for result and concurrency semantics.

## Security and Lifecycle

The installed channel account and binding must route to the same agent and
workspace that own the manifest. Missing, duplicate, conflicting, or cross-agent
routing fails closed.

An assignment is accepted only when the authenticated account is still assigned,
the immutable assigning actor is approved, the repository owner is eligible,
and the account has sufficient repository access. GitHub issue titles, bodies,
comments, and mentions are not fetched or treated as instructions.

Private monitor state contains correlation ids and delivery checkpoints, not
tokens or GitHub content. Deterministic worktree and session identities make
delivery retry-safe without duplicating local work.

`install` adds or repairs only the channel account and binding owned by Agent
System. Removing `github.notifications` and running `install` again removes the
owned route and stops new intake without deleting existing worktrees or sessions.

## Further Reading

- [Agent System README](../../README.md): installation and the common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest and CLI reference
- [Git tools](../../tools/git/README.md): managed worktree configuration and behavior
- [GitHub CLI tool](../../tools/github/README.md): shared GitHub identity and credential configuration
