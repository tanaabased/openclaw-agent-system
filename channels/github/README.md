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
  one tool-free private planning turn with hidden instructions. Patch content is
  never included.
- Publishes one deterministic assignment receipt through the channel's
  authorization, safety, and durable delivery path as soon as the private
  session is recorded; planning does not author or delay that receipt.
- Establishes a complete bounded top-level comment baseline for each admitted
  issue or pull request, then admits only later exact standalone mentions from
  approved immutable human identities.
- Rechecks the exact current comment revision, passes its bounded text directly
  into the private session, and injects response instructions separately. It
  rechecks again before publishing the quoted `To GitHub` response.
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

# inspect redacted assignment, planning, comment, and publication checkpoints.
openclaw agent-system notifications status --json

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
openclaw agent-system notifications status [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--json]
openclaw agent-system notifications wait [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--comment <number>] --for <target> [--refresh] [--timeout <seconds>] [--json]
```

| Option                      | Commands         | Purpose                                                                |
| --------------------------- | ---------------- | ---------------------------------------------------------------------- |
| `--agent <id>`              | all              | Selects an installed agent instead of workspace discovery              |
| `--repository <owner/name>` | `status`, `wait` | Selects one repository; requires `--kind` and `--number`               |
| `--kind <kind>`             | `status`, `wait` | Selects `issue` or `pull-request`; requires the complete item selector |
| `--number <number>`         | `status`, `wait` | Selects one positive GitHub item number                                |
| `--comment <number>`        | `wait`           | Selects one positive comment id for a comment target                   |
| `--for <target>`            | `wait`           | Selects the durable semantic checkpoint                                |
| `--refresh`                 | `wait`           | Runs bounded intake cycles while waiting                               |
| `--timeout <seconds>`       | `wait`           | Sets the positive wait timeout; defaults to `300`                      |
| `--json`                    | all              | Returns one undecorated machine-readable result                        |

### Refresh

`notifications refresh` runs the same intake lifecycle immediately. It reports baseline
readiness, diagnostics, and retry timing, and it can create a managed worktree
and local session for an accepted issue or a session for an accepted pull
request. It does not wait for planning;
the running Gateway picks up that checkpoint asynchronously. Deferred and failed
cycles return a nonzero exit code.

### Status

`notifications status` reads the channel's durable private control state and
returns a redacted semantic projection. Without an item selector it lists every
tracked item. A selector must provide repository, kind, and number together.
The result reports baseline readiness, disposition, delivery stage, mode,
session and worktree readiness, planning and acknowledgment checkpoints,
progress counts, bounded pull-request head metadata, and value-free comment turn
and reply status.

The projection never includes issue or comment bodies, structured provider
context, hidden instructions, session keys, worktree paths, credentials, or raw
provider payloads. A monitor diagnostic reports `degraded` and returns nonzero;
missing or not-yet-observed state reports `pending` without inventing a failure.

### Wait

`notifications wait` polls that semantic projection until one checkpoint is
reached, a durable failure appears, or the timeout expires. Use `--refresh` only
for provider-observation transitions such as assignment admission, comment
admission, or retirement. Omit it while waiting for Gateway-owned asynchronous
planning, replies, and explicit progress publication.

| Target                     | Meaning                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `baseline-ready`           | The first safe provider observation completed                |
| `assignment-rejected`      | The selected assignment failed admission                     |
| `received`                 | Deterministic local receipt completed or advanced further    |
| `active`                   | The selected assignment can run or accept continuations      |
| `planning-complete`        | The current private planning turn completed                  |
| `acknowledgment-published` | The assignment acknowledgment has a durable provider receipt |
| `comment-rejected`         | The selected comment revision failed admission               |
| `comment-received`         | The selected comment revision entered the private lifecycle  |
| `comment-replied`          | Its private turn and public reply both completed             |
| `progress-published`       | At least one explicit progress update has a durable receipt  |
| `retired`                  | The selected assignment retired without deleting local proof |

Comment targets require `--comment`. Every target except `baseline-ready`
requires a complete item selector. Failed and timed-out waits return nonzero and
include the last redacted observation in JSON for diagnostics.

See the complete CLI reference for
[`refresh`](../../ADVANCED.md#openclaw-agent-system-notifications-refresh),
[`status`](../../ADVANCED.md#openclaw-agent-system-notifications-status), and
[`wait`](../../ADVANCED.md#openclaw-agent-system-notifications-wait).

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
  status evidence use ephemeral current-turn structured context, while trusted
  response instructions stay out of visible chat. Public delivery accepts only
  a deterministic assignment receipt, an admitted comment's quoted `To GitHub`
  response, or explicitly selected progress.
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
