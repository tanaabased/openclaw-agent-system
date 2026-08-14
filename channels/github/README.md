# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The GitHub notifications channel is a local
[OpenClaw messaging channel](https://docs.openclaw.ai/channels) that turns
approved GitHub issue and pull-request assignments into agent-scoped private
sessions, with a managed worktree for each issue. It supports private planning,
bounded replies to approved mentions, and explicitly selected progress updates
without treating GitHub content as authorization for implementation.

> [!IMPORTANT]
> GitHub comments never authorize implementation or local tool use. The channel
> publishes local progress only through an authorized `/agent-system-progress`
> action in the exact assignment session. Direct pull requests have their own
> conversation; the channel does not correlate them with issue conversations or
> participate in inline review threads.

## Overview

- During `install`, records the agent's currently assigned open work items as a
  safe baseline without creating local work. An empty result is a valid,
  persisted baseline.
- On later cycles, discovers new assignments and rechecks the agent account,
  assigning actor, repository owner, and repository access.
- For each accepted issue assignment, creates or reuses one deterministic
  managed worktree and one local OpenClaw session. A direct pull-request
  assignment creates only its local monitoring session.
- Fetches a bounded title, body, labels, and recent comments as untrusted
  context, plus summary-only changed-file metadata for a pull request, then runs
  one tool-free private planning turn. Patch content is never included.
- Publishes only the planning response's separate one-sentence acknowledgment
  through the channel's authorization, safety, and durable delivery path.
- Establishes a complete bounded top-level comment baseline for each admitted
  issue or pull request, then admits only later exact standalone mentions from
  approved immutable human identities.
- Rechecks the exact current comment revision before a tool-free private reply
  turn and again before publishing its separate GitHub reply candidate.
- Publishes a locally selected progress update only from the exact active
  assignment session through an authorized Gateway operator command that
  bypasses the model.

## Requirements

- Agent System installed and enabled
- Git available as `git`
- GitHub CLI available as `gh`
- an Agent System workspace manifest with an agent id and Git author email
- `git.worktrees`, `github.username`, `github.token`, and
  `github.notifications` configured
- the named GitHub token available in the completed Agent System environment
- an authenticated default OpenClaw model for private planning and comment turns

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

# reconcile the route and establish the first baseline, including an empty one.
openclaw agent-system install

# inspect the installed route and the last successful observation.
openclaw agent-system doctor

# process later assignments immediately.
openclaw agent-system notifications refresh

# inspect the live gateway scheduler and connection health.
openclaw channels status --channel agent-system-github --json
```

`install` fails with `github-notification-baseline-failed` if it cannot establish
the initial baseline. Only assignments observed after a successful installation
baseline create local work.

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

The command runs the same intake lifecycle immediately. It reports baseline
readiness, diagnostics, and retry timing, and it can create a managed worktree
and local session for an accepted issue or a session for an accepted pull
request. It does not wait for planning;
the running Gateway picks up that checkpoint asynchronously. Deferred and failed
cycles return a nonzero exit code.

See the [complete CLI reference](../../ADVANCED.md#openclaw-agent-system-notifications-refresh)
for result and concurrency semantics.

## Explicit Progress Publication

Open the active local notification session for an issue or pull request,
complete any desired tool-enabled inspection in an ordinary local turn, then
explicitly select the public update with:

```text
/agent-system-progress Implementation is underway and the current checks are passing.
```

The slash command bypasses the model. It publishes the selected text only after
the common bounded-content safety gate and the same send-time assignment,
manifest, GitHub policy, repository permission, account identity, durable
delivery, and unknown-send reconciliation used by other notification replies.
The command requires an authorized Gateway client with `operator.write` scope
in the exact active assignment session. GitHub-originated messages and ordinary
local chat cannot trigger it, and owner status on a remote chat surface does not
substitute for Gateway operator scope.

The selected update is trimmed, limited to 800 characters, and rejected if it
contains secrets, links, mentions, local paths, structured tool output, or
unsupported formatting. A failed or pending publication remains visible through
`doctor`; automatic replay is deferred to the notification state-management
phase.

## Security and Lifecycle

- The installed account and binding must match the manifest's agent and
  workspace. Missing, duplicate, conflicting, or cross-agent routing fails
  closed.
- Intake requires the authenticated assigned account, an approved immutable
  assigning actor, an eligible repository owner, and sufficient repository
  access.
- GitHub prose and changed-file metadata remain bounded untrusted data.
  Planning and admitted-comment turns cannot use tools. Admitted comments and
  status evidence use ephemeral current-turn structured context. Public
  delivery accepts only the planning turn's separate acknowledgment, an
  admitted comment's visibly quoted reply, or explicitly selected progress.
- Comment mentions do not authorize inspection or implementation. Status replies
  use only recorded evidence; fresh inspection remains a local tool-enabled turn
  whose result stays private unless an operator invokes
  `/agent-system-progress`.
- Each enabled account owns its Gateway polling lifecycle. Manual refresh uses
  the same deterministic intake path without waiting for a model, while
  asynchronous turns and durable sends remain Gateway-owned. `doctor` reports
  incomplete publications separately from monitor read health.
- Private monitor state contains no tokens, GitHub prose, or generated content.
  Deterministic worktree, session, activation, and publication identities keep
  delivery retry-safe.
- Direct pull-request assignments retain the verified head without preparing a
  worktree. Closing or merging retires the route logically while preserving the
  session; issue correlation, review requests, and inline review threads remain
  unsupported.
- Removing `github.notifications` and reinstalling retires active assignments,
  removes owned routing and converged monitor state, and stops intake without
  deleting existing sessions or issue worktrees.

## Further Reading

- [Presentation](./PRESENTATION.md): private session formatting, untrusted context, and public publication boundaries
- [Agent System README](../../README.md): installation and the common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest and CLI reference
- [Git tools](../../tools/git/README.md): managed worktree configuration and behavior
- [GitHub CLI tool](../../tools/github/README.md): shared GitHub identity and credential configuration
