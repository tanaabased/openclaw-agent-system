# Agent System GitHub Notifications Channel

<p align="center">
  <img src="../../assets/github-icon-large.svg" alt="Agent System GitHub notifications" width="180" />
</p>

The `agent-system-github` channel discovers approved GitHub assignments and turns
accepted issue work into one private OpenClaw lifecycle per issue. It polls
through the configured agent identity, prepares managed issue worktrees, and
publishes bounded replies back to the issue or delivery pull request that
prompted them.

## Overview

Configure the channel through `github.notifications` in the agent workspace
manifest. Each accepted issue starts in one manifest-selected mode:

| Mode     | Initial assignment behavior                                                              |
| -------- | ---------------------------------------------------------------------------------------- |
| `guided` | Prepares the session and worktree, acknowledges the assignment, and waits for direction. |
| `work`   | Assesses the issue, may publish a plan, and schedules one private implementation turn.   |

Work implementation uses the same session and worktree, validates the change,
creates one local commit, performs the first ordinary push, and creates or
normalizes one delivery pull request. Guided performs no automatic
implementation; the operator or an approved exact-mention comment decides what
happens next. GitHub prose cannot select or elevate the configured mode.

The channel also:

- records existing assignments as a safe baseline during `install`, without
  creating work for them
- admits only configured assignment types, approved actors, eligible repository
  owners, and repositories where the agent has sufficient access
- keeps approved issue and delivery pull-request comments in the issue-owned
  session, publishes each ordinary final response back to its exact source,
  and drains a bounded pair of queued comments serially per poll
- retires issue-owned work after delivery merge or loss of assignment authority
  and removes only clean managed worktrees for completed lifecycles
- supports the bundled [GitHub Update skill](../../skills/github-update/SKILL.md)
  for an explicit, mode-neutral public progress update

## Requirements

- Agent System installed and enabled
- Git available as `git`
- GitHub CLI available as `gh`
- an Agent System workspace manifest with an agent id and Git author email
- `git.worktrees`, `github.username`, `github.token`, and
  `github.notifications` configured
- the named GitHub token available in the completed Agent System environment
- an OpenClaw model configured for the notification agent
- the notification agent's effective OpenClaw tool profile set to `coding`

The GitHub account must have `write`, `maintain`, or `admin` access to every
repository from which the channel accepts assignments.

## Configuration Reference

Add the channel to `.agent-system/agent.yaml` or the root `agent.yaml`:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email: tanaabot@tanaab.dev
  emoji: 🤖

environment:
  required:
    - GH_TOKEN_TANAABOT

git:
  worktrees: {}
  ssh:
    private-keys: ~/.ssh/id_ed25519

github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  ssh-keys: ~/.ssh/id_ed25519.pub
  notifications:
    assignment-types:
      - issue
    initial-mode: work
    interval-minutes: 5
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
    allowed-repository-owners:
      - login: tanaabased
        node-id: O_kgDOB7x6Qw
```

### `github.notifications.assignment-types`

| Type        | Required | Default                    |
| ----------- | -------- | -------------------------- |
| string list | no       | `issue` and `pull-request` |

Selects the assignment kinds the channel discovers. The list must contain one
or both supported values without duplicates.

### `github.notifications.approved-actors`

| Type                 | Required | Default |
| -------------------- | -------- | ------- |
| GitHub identity list | yes      | none    |

Lists the GitHub users allowed to assign work to the notification agent. At
least one identity is required.

| Field     | Type   | Required | Behavior                                   |
| --------- | ------ | -------- | ------------------------------------------ |
| `login`   | string | yes      | Records the user's current GitHub login.   |
| `node-id` | string | yes      | Pins the user's immutable GitHub identity. |

Node IDs must be unique within the list. The channel verifies the login and
node ID together so a renamed or recycled login cannot inherit authorization.

### `github.notifications.allowed-repository-owners`

| Type                 | Required | Default   |
| -------------------- | -------- | --------- |
| GitHub identity list | no       | any owner |

Filters assignments by repository owner using the same `login` and `node-id`
identity shape as `approved-actors`. At least one identity is required when the
field is present, and node IDs must be unique within the list. The filter does
not grant repository access or approve the owner's members.

### `github.notifications.initial-mode`

| Type   | Required | Default |
| ------ | -------- | ------- |
| string | no       | `work`  |

Selects `guided` or `work` for newly accepted issues. Guided prepares the
session and waits for direction; Work schedules the initial implementation
turn.

### `github.notifications.interval-minutes`

| Type    | Required | Default |
| ------- | -------- | ------- |
| integer | no       | `5`     |

Sets the polling interval from `1` through `1440` minutes.

`github.token` names an environment variable and never accepts a literal token.
Work delivery requires [`git.ssh`](../../tools/git/README.md#gitsshprivate-keys)
for the authenticated branch push. The matching public key must already belong
to the configured GitHub account, or `github.ssh-keys` can declare it for
`install` to reconcile. SSH configuration also keeps private-repository
worktree preparation free of credential-bearing clone URLs.

Run `openclaw agent-system install` after changing the configuration. Installation
establishes the first safe assignment baseline; only assignments observed after
that baseline create local work. A baseline failure reports
`github-notification-baseline-failed` and leaves intake inactive.

## CLI

All notification commands run from an agent workspace or use `--agent <id>` to
select one installed agent explicitly. `openclaw as` is an equivalent alias for
`openclaw agent-system`. Bare `notifications` prints command help.

### Usage

```text
openclaw agent-system notifications refresh [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--timeout <seconds>] [--json]
openclaw agent-system notifications status [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--json]
openclaw agent-system notifications wait [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] --for <target> [--refresh] [--timeout <seconds>] [--json]
```

### Common Options

| Option                                                      | Commands | Behavior                                                       |
| ----------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| `--agent <id>`                                              | all      | Uses the exact installed agent instead of workspace discovery. |
| `--repository <owner/name> --kind <kind> --number <number>` | all      | Selects one item; all three values must be provided together.  |
| `--json`                                                    | all      | Writes one undecorated structured result to standard output.   |

`--kind` accepts `issue` or `pull-request`. Item numbers and timeout values must
be positive integers. Invalid options return exit code `2`; failed, degraded,
timed-out, or otherwise incomplete operations return nonzero.

### `openclaw agent-system notifications refresh`

Runs one GitHub notification intake cycle immediately.

| Option                | Required | Default | Behavior                           |
| --------------------- | -------- | ------- | ---------------------------------- |
| `--timeout <seconds>` | no       | `300`   | Bounds the complete refresh cycle. |

Without an item selector, `refresh` processes the agent's eligible assignments.
A selector limits the cycle to one exact item. A completed cycle may establish
the baseline, prepare an issue, continue one pending Work implementation,
process one admitted comment, or retire work. Deferred and failed cycles return
nonzero.

### `openclaw agent-system notifications status`

Reads the durable notification state without advancing intake.

The result reports a redacted baseline and item projection, including lifecycle,
worktree, and cleanup status when available. A durable monitor diagnostic
returns `degraded` and a nonzero exit code.

### `openclaw agent-system notifications wait`

Waits for one semantic notification checkpoint without parsing session history
or presentation text.

| Option                | Required | Default | Behavior                                      |
| --------------------- | -------- | ------- | --------------------------------------------- |
| `--for <target>`      | yes      | none    | Selects the lifecycle checkpoint.             |
| `--refresh`           | no       | off     | Advances provider-owned intake while waiting. |
| `--timeout <seconds>` | no       | `300`   | Bounds the complete wait.                     |

Supported targets:

| Target                | Selector required | Meaning                                       |
| --------------------- | ----------------- | --------------------------------------------- |
| `baseline-ready`      | no                | The first safe provider observation completed |
| `assignment-rejected` | yes               | The selected assignment failed admission      |
| `prepared`            | yes               | Lifecycle-owned intake resources are ready    |
| `worktree-ready`      | yes               | The selected issue worktree is ready          |
| `retired`             | yes               | The selected assignment retired logically     |

Terminal diagnostics fail immediately. A timed-out or otherwise incomplete wait
returns nonzero.

### Examples

```sh
# run intake and prepared-issue reconciliation now.
openclaw agent-system notifications refresh

# inspect redacted state for the workspace agent.
openclaw agent-system notifications status --json

# advance intake until one issue worktree is ready.
openclaw agent-system notifications wait \
  --repository tanaabased/example \
  --kind issue \
  --number 12 \
  --for worktree-ready \
  --refresh \
  --json
```

## Current Limitations

- Plan and Auto modes and mode transitions remain unavailable.
- Directly assigned pull requests retain bounded head metadata but do not create
  a managed worktree or an independent comment session.
- Work assignment turns require an implementation-ready plan; clarification is
  not yet a structured lifecycle outcome.
- Channel-owned publication begins from an admitted GitHub lifecycle. The
  GitHub Update skill is the explicit private-session path for publishing a
  missing progress update outside a notification reply turn.

## Security and Lifecycle

- Installed account and workspace routing must match the manifest. Missing,
  duplicate, conflicting, or cross-agent routing fails closed.
- Admission requires the authenticated assigned account, an approved immutable
  assigning actor, an eligible repository owner, and sufficient repository
  access.
- Assignment and comment reads are bounded and reauthorized before model turns.
  Private monitor and conversation state contain no tokens.
- An approved actor may enter the conversation but cannot select capabilities;
  the trusted channel lifecycle and configured mode remain authoritative.
- Replies are reauthorized against their exact source before credentials load
  and are published idempotently. An ordinary approved comment uses the same
  final response in GitHub and the private session. If deterministic validation
  rejects that response, the channel publishes a safe notice instead of going
  silent while retaining the detailed response privately.
- Merging a delivery pull request retires its issue-owned lifecycle. Closing and
  reopening the pull request suspends and safely re-baselines that comment source.
- Removing `github.notifications` and reinstalling retires tracked assignments,
  removes owned routing and converged monitor state, and stops intake without
  deleting existing issue worktrees.

## Further Reading

- [Agent System README](../../README.md): installation and common manifest workflow
- [Advanced](../../ADVANCED.md): core manifest, configuration, CLI, environment, and path reference
- [Design](./DESIGN.md): target message flow, lifecycle types, modes, durable conversation state, and response boundaries
- [Presentation](./PRESENTATION.md): reusable visible component definitions
- [Git tools](../../tools/git/README.md): identity, SSH, policy, and managed worktree configuration
- [GitHub CLI tool](../../tools/github/README.md): shared GitHub identity, credentials, configuration, and policy
