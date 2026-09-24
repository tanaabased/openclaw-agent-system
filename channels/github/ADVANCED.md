# GitHub Notifications Advanced Guide

Complete configuration, command, and operational reference for the shipped
GitHub notification channel. Start with the [README](./README.md) to configure
and verify the common workflow. [Design](./DESIGN.md) describes the target lifecycle.

- [Configuration reference](#configuration-reference)
- [CLI reference](#cli)
  - [`openclaw agent-system notifications refresh`](#openclaw-agent-system-notifications-refresh)
  - [`openclaw agent-system notifications status`](#openclaw-agent-system-notifications-status)
  - [`openclaw agent-system notifications wait`](#openclaw-agent-system-notifications-wait)
- [Model routing](#model-routing)
- [Processing and lifecycle](#processing-and-lifecycle)
- [Security and lifecycle](#security-and-lifecycle)
- [Durable state and upgrades](#durable-state-and-upgrades)

## Configuration Reference

Declare `github.notifications` in the workspace manifest; see the
[complete example](./README.md#configuration) and shared
[manifest rules](../../MANIFEST.md). All channel fields are listed below.

| Field under `github.notifications` | Required | Default                 | Values                                   |
| ---------------------------------- | -------- | ----------------------- | ---------------------------------------- |
| `assignment-types`                 | no       | `[issue, pull-request]` | One or both kinds, without duplicates    |
| `approved-actors`                  | yes      | none                    | Nonempty list of pinned user identities  |
| `allowed-repository-owners`        | no       | any owner               | Nonempty list of pinned owner identities |
| `initial-mode`                     | no       | `work`                  | `guided` or `work`                       |
| `interval-minutes`                 | no       | `5`                     | Integer from `1` through `1440`          |
| `max-concurrent-issues`            | no       | `2`                     | Positive integer                         |

### `github.notifications.assignment-types`

Selects the assignment kinds the channel discovers. Direct pull-request
assignments have the [documented limitations](./README.md#current-limitations).

### `github.notifications.approved-actors`

Lists the GitHub users allowed to assign work, including the agent's own
verified identity when self-assignment is intended.

| Field            | Type    | Required | Default | Description                                |
| ---------------- | ------- | -------- | ------- | ------------------------------------------ |
| `login`          | string  | yes      | none    | Records the user's current GitHub login.   |
| `node-id`        | string  | yes      | none    | Pins the user's immutable GitHub identity. |
| `operator-owner` | boolean | no       | `false` | Requests OpenClaw operator recognition.    |

Node IDs must be unique within the list. The channel verifies the login and
node ID together so a renamed or recycled login cannot inherit authorization.

#### Optional operator recognition

`operator-owner: true` requests `commands.ownerAllowFrom` access for the verified
`agent-system-github:<node-id>` identity. This is **channel-wide OpenClaw operator
recognition**, not a repository-scoped or styling-only permission. It can expose
other owner-gated capabilities permitted by independent tool policy. The flag is
not accepted on `allowed-repository-owners` and is unrelated to the visible session
assignee. No username-only, unqualified, or wildcard grant is generated.

```yaml
github:
  notifications:
    approved-actors:
      - login: pirog
        node-id: MDQ6VXNlcjcxMzQyNA==
        operator-owner: true
      - login: emoriwan
        node-id: U_kgDOEUqvpg
        operator-owner: false
```

Each actor opts in independently; omitted or false flags grant nothing. Run
`doctor` to inspect access and `install` to reconcile it. Missing or unverifiable
optional access warns without blocking intake. Install verifies login/node-ID
pins before changing grants; passive discovery and issue prose never grant access.

Install requests a configuration reload. If the Gateway remains stale, restart
it and verify a fresh assignment. Doctor inspects its own process's loaded policy,
not a separate Gateway. Explicit tool denials, narrower allowlists, and session
visibility restrictions still apply.

Removing a flag, actor, or notification declaration retires its grant claim on
the next install. Pre-existing/manual grants and grants needed by other
installations remain. Uncertain ownership warns and preserves access; do not
delete the provenance ledger to repair it. Before uninstalling the plugin or
deleting a workspace, remove the flags and run install to verify cleanup while
the declaration and receipts are available. Plugin removal cannot revoke grants.

Initial assignments use native `sessions` tools for owner, color, and group
setup. A read-only check records persisted results privately, preserves manual
fields, and reports missing evidence as unverified. Setup failures do not retry,
block work, or add GitHub comments. This optional access does not replace the
[required conversation hook](#required-conversation-hook).

### `github.notifications.allowed-repository-owners`

Filters assignments by repository owner using the same `login` and `node-id`
identity shape as `approved-actors`, with unique node IDs. The filter does not
grant repository access or approve the owner's members.

### `github.notifications.initial-mode`

Selects `guided` or `work` for newly accepted issues. Guided prepares the
session and waits for direction; Work schedules the initial implementation
turn.

### `github.notifications.interval-minutes`

Sets how often the Gateway polls for assignments and comments.

### `github.notifications.max-concurrent-issues`

Limits concurrent issue work for one agent. The durable queue is shared by the
Gateway and one-shot CLI refreshes, so a second process cannot evade the limit.
An issue keeps its slot across planning and automatic implementation. Delivery,
an explicit wait for follow-up, or a retryable failure releases the slot; failed
work moves to the back of the queue. Pull-request assignment intake is not
counted against this issue-work limit.

### Required Conversation Hook

For configured notifications, `doctor` reports unset or denied
`plugins.entries.agent-system.hooks.allowConversationAccess` as blocked without
changing it. Run `openclaw agent-system install` from the agent workspace to grant
access and verify required hook registration. Install preserves unrelated
configuration and does not override `hooks.allowPromptInjection: false`.
If the running Gateway has not reloaded the permission, restart it after install;
notifications remain blocked until its required hooks are available.

## CLI

`openclaw as` aliases `openclaw agent-system`. Bare `notifications` prints help.

### `openclaw agent-system notifications refresh`

Run one GitHub notification intake cycle immediately.

#### Options

| Option or argument             | Required             | Default             | Description                                                                  |
| ------------------------------ | -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `--agent <id>`                 | no                   | workspace discovery | Use the exact configured workspace for an installed agent.                   |
| `--repository <owner/name>`    | with other selectors | none                | Select a repository; provide `--kind` and `--number` together.               |
| `--kind <issue\|pull-request>` | with other selectors | none                | Select the item kind; provide `--repository` and `--number` together.        |
| `--number <number>`            | with other selectors | none                | Select a positive item number; provide `--repository` and `--kind` together. |
| `--timeout <seconds>`          | no                   | `300`               | Positive integer bounding the complete refresh cycle.                        |
| `--json`                       | no                   | off                 | Write one undecorated structured result to stdout.                           |

#### Usage

```text
openclaw agent-system notifications refresh [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--timeout <seconds>] [--json]
```

```sh
# run intake and prepared-issue reconciliation now.
openclaw agent-system notifications refresh
```

Without an item selector, `refresh` processes the agent's eligible assignments.
A selector limits the cycle to one exact item. A completed cycle may establish
the baseline, prepare an issue, continue one pending Work implementation,
process a bounded pair of admitted comments, or retire work. Deferred and failed
cycles return nonzero.

The CLI first polls and saves intake, then waits for execution within the refresh
timeout. If execution is busy or the wait ends, newly admitted items remain visible
through `notifications status` and can resume on a later cycle. The CLI waits for
any execution it starts to settle before exiting.

Invalid options return exit code `2`; failed, degraded, timed-out, or incomplete
operations return nonzero.

### `openclaw agent-system notifications status`

Read durable notification state without advancing intake.

#### Options

| Option or argument             | Required             | Default             | Description                                                                  |
| ------------------------------ | -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `--agent <id>`                 | no                   | workspace discovery | Use the exact configured workspace for an installed agent.                   |
| `--repository <owner/name>`    | with other selectors | none                | Select a repository; provide `--kind` and `--number` together.               |
| `--kind <issue\|pull-request>` | with other selectors | none                | Select the item kind; provide `--repository` and `--number` together.        |
| `--number <number>`            | with other selectors | none                | Select a positive item number; provide `--repository` and `--kind` together. |
| `--json`                       | no                   | off                 | Write one undecorated structured result to stdout.                           |

#### Usage

```text
openclaw agent-system notifications status [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--json]
```

```sh
# inspect redacted state for the workspace agent.
openclaw agent-system notifications status --json
```

The result reports a redacted baseline and item projection, including lifecycle,
worktree, cleanup, scheduling state, and aggregate active, queued, and limit
counts when available. Waiting items include a stable reason code. A durable
monitor diagnostic returns `degraded` and a nonzero exit code.

Invalid options return exit code `2`; failed, degraded, timed-out, or incomplete
operations return nonzero.

### `openclaw agent-system notifications wait`

Wait for one semantic notification checkpoint without parsing session history or presentation text.

#### Options

| Option or argument             | Required             | Default             | Description                                                                  |
| ------------------------------ | -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `--agent <id>`                 | no                   | workspace discovery | Use the exact configured workspace for an installed agent.                   |
| `--repository <owner/name>`    | with other selectors | none                | Select a repository; provide `--kind` and `--number` together.               |
| `--kind <issue\|pull-request>` | with other selectors | none                | Select the item kind; provide `--repository` and `--number` together.        |
| `--number <number>`            | with other selectors | none                | Select a positive item number; provide `--repository` and `--kind` together. |
| `--for <target>`               | yes                  | none                | Select a supported lifecycle checkpoint below.                               |
| `--refresh`                    | no                   | off                 | Advance provider-owned intake while waiting.                                 |
| `--timeout <seconds>`          | no                   | `300`               | Positive integer bounding the complete wait.                                 |
| `--json`                       | no                   | off                 | Write one undecorated structured result to stdout.                           |

#### Usage

```text
openclaw agent-system notifications wait [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] --for <target> [--refresh] [--timeout <seconds>] [--json]
```

```sh
# advance intake until one issue worktree is ready.
openclaw agent-system notifications wait \
  --repository tanaabased/example \
  --kind issue \
  --number 12 \
  --for worktree-ready \
  --refresh \
  --json
```

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

Invalid options return exit code `2`; failed, degraded, timed-out, or incomplete
operations return nonzero.

## Model routing

Declaring all four [model profiles](../../MANIFEST.md#models) enables routing for
new issue conversations in either mode. Existing conversations and default-only
manifests keep their ordinary behavior. Before the initial assignment turn, the
manifest default model assesses bounded issue content in a fresh, tool-free
native runtime context. The model supplies the reasoning judgment; code validates
its response, maps the tier to the configured profile, and saves the decision
before substantive work. Routing runs inside the issue's execution lease and
outside the shared polling lease.

Verified native **Complexity** determines the tier. When native metadata is
missing or unavailable, the visible fenced YAML capsule with
`schema: tanaab/task-metadata/v2`, `mode: fallback`, and `fallback.complexity`
can supply it. Missing, invalid, conflicting, and unavailable values remain
distinct evidence for the model's labeled content assessment. **Work size**
informs scope and decomposition, never the model tier. An unresolvable assessment,
unsupported profile, or failed classifier blocks that issue for retry; it does
not select an expensive default or a fallback chain. Automatic efforts are
`medium`, `high`, or justified `xhigh`.

For complete issue routing, `install` additively grants Agent System permission
to select the agent and classifier model, allowing the manifest default in both
OpenClaw LLM allowlists. It preserves unrelated grants and settings; default-only,
disabled, and pull-request-only declarations request nothing.

`doctor` distinguishes saved access from permissions loaded by its process. If
loaded access is stale, restart the Gateway and retry the prepared assignment.
Background polling never grants permissions or substitutes for authentication.

The saved model and effort survive retries, restarts, comments, and delivery
pull-request continuation. Later manifest edits do not reclassify existing
conversations. Explicit supported native model and effort overrides take
precedence independently. Automatic routing can continue on a permitted native
fallback; a mismatch with a strict selection or an unapproved model cancels work.
Execution records distinguish verified selections, permitted continuations, and
unverified settings when native evidence is incomplete. Missing evidence alone
does not block publication or prove the requested route ran.

The initial private assessment includes a short routing note with model, effort,
complexity, source, and reason. It is excluded from the public reply and is not
runtime verification.

For a demonstrated reasoning blocker, the agent explains the failed approach
and asks the operator to approve a specific stronger profile. This is a
conversational request, not an automatic escalation or structured clarification
outcome. An approved change requires native controls that support and preserve
both model and effort; otherwise the operator uses supported session controls.
Authentication failures, rate limits, slow tests, and missing requirements do
not justify escalation. A stronger profile is only confirmed by native runtime
evidence.

## Processing and Lifecycle

Run `openclaw agent-system install` after changing the configuration. Installation
establishes the first safe assignment baseline; only assignments observed after
that baseline create local work. A baseline failure reports
`github-notification-baseline-failed` and leaves intake inactive.

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
  and drains a bounded pair of queued comments serially per execution pass
- retires issue-owned work after delivery merge or loss of assignment authority
  and removes only clean managed worktrees for completed lifecycles
- supports the bundled [GitHub Update skill](../../skills/github-update/SKILL.md)
  for an explicit, mode-neutral public progress update

The Gateway polls independently of issue workers, so new assignments can begin
while another issue is running. Each issue serializes preparation, comments,
responses, and retirement across Gateway and CLI processes. Different issues
can proceed concurrently up to the agent's durable issue-work limit; shared
repository preparation is serialized. Assignment acknowledgments wait for
durable session recording.

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

### Durable State and Upgrades

Intake checkpoints and per-issue conversation state are stored separately in the
agent's private state directory. Stop old runtime processes before upgrading;
running old and new state writers together is unsupported.

Supported older conversation snapshots and reply-turn records migrate on use.
The retained `github-notification-conversations.legacy.json` snapshot allows an
interrupted migration to retry, but receives no later updates and is not a
current backup. Older plugin versions cannot read the new index. Missing or
invalid conversation records block only the affected lifecycle.
