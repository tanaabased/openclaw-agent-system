# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The GitHub notifications channel is a local
[OpenClaw messaging channel](https://docs.openclaw.ai/channels) that turns
approved GitHub issue assignments into agent-scoped local work. It verifies the
agent, assigning actor, and repository before creating one managed worktree and
one local OpenClaw session for the issue. The Gateway then asks the agent to
review the issue and prepare a plan before posting one short acknowledgment.
Later approved comments that address the verified agent account continue the
same private conversation and receive one bounded public reply.

> [!IMPORTANT]
> GitHub comments never authorize implementation or local tool use. The channel
> does not currently publish locally initiated progress or manage pull-request
> conversations.

## Overview

- During `install`, records the agent's currently assigned open issues as a
  safe baseline without creating local work. An empty result is a valid,
  persisted baseline.
- On later cycles, discovers new assignments and rechecks the agent account,
  assigning actor, repository owner, and repository access.
- For each accepted assignment, creates or reuses one deterministic managed
  worktree and one local OpenClaw session.
- Fetches a bounded issue title, body, labels, and recent comments as untrusted
  context, then runs one tool-free private planning turn.
- Publishes only the planning response's separate one-sentence acknowledgment
  through the channel's authorization, safety, and durable delivery path.
- Establishes a complete bounded comment baseline for each admitted issue, then
  admits only later exact standalone mentions from approved immutable human
  identities.
- Rechecks the exact current comment revision before a tool-free private reply
  turn and again before publishing its separate GitHub reply candidate.

Each enabled channel account owns its polling lifecycle while the Gateway is
running. `openclaw channels status --channel agent-system-github --json`
reports whether that account is running, connected, and healthy. The manual
refresh command runs the deterministic intake path immediately and returns
without waiting for a model. The running Gateway owns asynchronous planning,
acknowledgment delivery, and admitted-comment responses. OpenClaw owns each
durable send attempt, provider retry, receipt normalization, and unknown-send
reconciliation. Agent System stores only value-free revision checkpoints,
confirmed comment receipts, or stable failed diagnostics; `doctor` reports
pending and failed acknowledgments and replies separately from monitor read
health.

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
and local session for an accepted assignment. It does not wait for planning;
the running Gateway picks up that checkpoint asynchronously. Deferred and failed
cycles return a nonzero exit code.

See the [complete CLI reference](../../ADVANCED.md#openclaw-agent-system-notifications-refresh)
for result and concurrency semantics.

## Security and Lifecycle

The installed channel account and binding must route to the same agent and
workspace that own the manifest. Missing, duplicate, conflicting, or cross-agent
routing fails closed.

An assignment is accepted only when the authenticated account is still assigned,
the immutable assigning actor is approved, the repository owner is eligible,
and the account has sufficient repository access.

Issue prose and comments are bounded and framed as untrusted project data.
Planning and admitted-comment turns cannot use tools, and their complete
responses remain in the private OpenClaw session. Only separately labeled
acknowledgment or GitHub-reply candidates can pass through the fail-closed
publication gate, which rejects secrets, links, mentions, local paths, and
unsupported output.

A comment mention addresses the agent but does not authorize file inspection,
repository commands, tests, implementation, or any other tool use. Status
questions may be answered from evidence already recorded in the issue session
and Agent System-owned checkpoints. If that evidence is insufficient, the reply
must say that no verified current update is available from the notification
turn. A later tool-enabled status check and progress publication require an
explicit locally authorized operator action.

Private monitor state contains no tokens, GitHub prose, or generated content.
Deterministic worktree, session, activation, and publication identities make
delivery retry-safe without duplicating local work or GitHub comments.

`install` adds or repairs only the channel account and binding owned by Agent
System. Removing `github.notifications` and running `install` again retires
outstanding local assignments, removes the owned route and converged private
monitor state, and stops new intake. Existing worktrees and sessions are
preserved deliberately; use a fresh isolated OpenClaw profile and agent id when
a post-delivery test must begin without those artifacts.

## Further Reading

- [Agent System README](../../README.md): installation and the common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest and CLI reference
- [Git tools](../../tools/git/README.md): managed worktree configuration and behavior
- [GitHub CLI tool](../../tools/github/README.md): shared GitHub identity and credential configuration
