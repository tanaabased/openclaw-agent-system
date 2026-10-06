# GitHub Notifications Advanced Guide

Configuration, commands, and operations for the GitHub notification channel.
Start with the [README](./README.md) for setup.

- [Configuration Reference](#configuration-reference)
  - [`github.notifications.allowed-repository-owners`](#githubnotificationsallowed-repository-owners)
  - [`github.notifications.approved-actors`](#githubnotificationsapproved-actors)
  - [`github.notifications.assignment-types`](#githubnotificationsassignment-types)
  - [`github.notifications.initial-mode`](#githubnotificationsinitial-mode)
  - [`github.notifications.interval-minutes`](#githubnotificationsinterval-minutes)
  - [`github.notifications.max-concurrent-issues`](#githubnotificationsmax-concurrent-issues)
  - [`github.notifications.pull-request`](#githubnotificationspull-request)
  - [Required Conversation Hook](#required-conversation-hook)
- [Tools](#tools)
  - [`agent_system_github_task_pr`](#agent_system_github_task_pr)
- [CLI](#cli)
  - [`openclaw agent-system notifications refresh`](#openclaw-agent-system-notifications-refresh)
  - [`openclaw agent-system notifications status`](#openclaw-agent-system-notifications-status)
  - [`openclaw agent-system notifications wait`](#openclaw-agent-system-notifications-wait)
- [Model routing](#model-routing)
- [Processing and Lifecycle](#processing-and-lifecycle)
  - [Managed Worktrees](#managed-worktrees)
  - [Pull Request Review Feedback](#pull-request-review-feedback)
- [Security and Lifecycle](#security-and-lifecycle)
  - [Durable State and Upgrades](#durable-state-and-upgrades)

## Configuration Reference

Declare `github.notifications` in the workspace manifest; see the
[complete example](./README.md#configuration) and shared
[manifest rules](../../MANIFEST.md).

| Field under `github.notifications` | Required | Default                 | Values                                   |
| ---------------------------------- | -------- | ----------------------- | ---------------------------------------- |
| `allowed-repository-owners`        | no       | any owner               | Nonempty list of pinned owner identities |
| `approved-actors`                  | yes      | none                    | Nonempty list of pinned user identities  |
| `assignment-types`                 | no       | `[issue, pull-request]` | One or both kinds, without duplicates    |
| `initial-mode`                     | no       | `work`                  | `guided` or `work`                       |
| `interval-minutes`                 | no       | `5`                     | Integer from `1` through `1440`          |
| `max-concurrent-issues`            | no       | `2`                     | Positive integer                         |
| `pull-request`                     | no       | see below               | Delivery PR assignees and reviewers      |

### `github.notifications.allowed-repository-owners`

Filters assignments by repository owner using the same `login` and `node-id`
identity shape as `approved-actors`, with unique node IDs. The filter does not
grant repository access or approve the owner's members.

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

### `github.notifications.assignment-types`

Selects the assignment kinds the channel discovers. Direct pull-request
assignments have the [documented limitations](./README.md#current-limitations).

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

### `github.notifications.pull-request`

Controls recipients on issue task pull requests published by automatic Work
delivery or the issue-owned `agent_system_github_task_pr` tool. Relevant issue
Work and Guided turns receive these defaults; unrelated direct `gh` pull requests
are not linked.

| Field       | Type                              | Required | Default            | Description                                                                                                               |
| ----------- | --------------------------------- | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `assignees` | `assignment-actor` or pinned list | no       | `assignment-actor` | Add the admitted assigning actor, or replace that choice with up to ten pinned users. `[]` disables automatic assignment. |
| `reviewers` | pinned list                       | no       | `[]`               | Request reviews from eligible users. Assignment alone does not request review.                                            |

Each pinned user has `login` and `node-id`, as in `approved-actors`. The login
must still resolve to that node ID at delivery. Duplicate identities within a
list are invalid. GitHub eligibility applies; the agent cannot review its own
PR. The same person may be both assignee and reviewer. Recipients need not be
`approved-actors`: receiving a PR never grants assignment or comment authority.
Existing assignees, review requests, and CODEOWNERS behavior are preserved.

```yaml
github:
  notifications:
    approved-actors:
      - login: pirog
        node-id: U_kgDOB9x7Qw
    pull-request:
      reviewers:
        - login: reviewer
          node-id: REPLACE_WITH_REAL_GITHUB_NODE_ID
```

A missing assigning-actor identity fails delivery rather than falling back to
the issue author. An interrupted handoff reuses its PR and adds only missing
recipients, without re-requesting a submitted review.

### Required Conversation Hook

For configured notifications, `doctor` reports unset or denied
`plugins.entries.agent-system.hooks.allowConversationAccess` as blocked without
changing it. Run `openclaw agent-system install` from the agent workspace to grant
access and verify required hook registration. Install preserves unrelated
configuration and does not override `hooks.allowPromptInjection: false`.
If the running Gateway has not reloaded the permission, restart it after install;
notifications remain blocked until its required hooks are available.

## Tools

### `agent_system_github_task_pr`

Publish a task pull request from a prepared, trusted GitHub issue-owned session
when work continues outside the automatic Work implementation turn. Use this
tool instead of `gh pr create` for that issue. Automatic Work delivery still
publishes terminally without a model tool call.

#### Parameters

| Parameter | Type   | Required | Default             | Description                   |
| --------- | ------ | -------- | ------------------- | ----------------------------- |
| `body`    | string | no       | `Closes #<issue>`   | Body for a newly created PR.  |
| `title`   | string | no       | current issue title | Title for a newly created PR. |

#### Usage

From the prepared issue session, publish committed work on its exact managed
branch:

```json
{ "title": "Finish the issue fix", "body": "Implementation and validation. Closes #12" }
```

The tool verifies current assignment authority, the agent-owned open PR and
branch, then adds missing configured recipients. It preserves an existing PR's
title, body, assignees, and completed reviews. It records the PR in the issue
session; the next notification reconciliation completes the ordinary
`pull-request-opened` card, comment baseline, and issue handoff. The tool does
not merge. It is unavailable outside a prepared issue-owned session.

The response reports `status: linked` for the completed PR link and a
`handoffStatus` snapshot at return time: `awaiting-reconciliation` until the
durable handoff is published, then `published` on a later call. A verified same-PR
retry remains available during its own PR-opened turn. If that turn lacks confirmed
terminal completion, `recovery-required` preserves the pending event and stops
automatic replay; it does not mean the PR must be recreated. This includes
interrupted attempts whose completion cannot be recovered through the supported
host API. Pending comments remain unconsumed until handoff is resolved. Checkpoint
failures retain a bounded reason code and the already-completed publication outcome.
The tool does not run the asynchronous handoff turn itself.

## CLI

Invalid options return exit code `2`; failed, degraded, timed-out, or incomplete
operations return nonzero.

`openclaw as` aliases `openclaw agent-system`. Bare `notifications` prints help.

### `openclaw agent-system notifications refresh`

Run one GitHub notification intake cycle immediately.

#### Options

| Option or argument             | Required             | Default             | Description                                                                  |
| ------------------------------ | -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `--agent <id>`                 | no                   | workspace discovery | Use the exact configured workspace for an installed agent.                   |
| `--json`                       | no                   | off                 | Write one undecorated structured result to stdout.                           |
| `--kind <issue\|pull-request>` | with other selectors | none                | Select the item kind; provide `--repository` and `--number` together.        |
| `--number <number>`            | with other selectors | none                | Select a positive item number; provide `--repository` and `--kind` together. |
| `--repository <owner/name>`    | with other selectors | none                | Select a repository; provide `--kind` and `--number` together.               |
| `--timeout <seconds>`          | no                   | `300`               | Integer from `1` through `2147483` bounding the complete refresh cycle.      |

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
Manual refresh bypasses the normal interval and local permission/configuration
backoff for one bounded attempt. Confirmed GitHub throttling still defers retry
and reports its reason and retry time.

The CLI first polls and saves intake, then waits for execution within the refresh
timeout. If execution is busy or the wait ends, newly admitted items remain visible
through `notifications status` and can resume on a later cycle. The CLI waits for
any execution it starts to settle before exiting.

### `openclaw agent-system notifications status`

Read durable notification state without advancing intake.

#### Options

| Option or argument             | Required             | Default             | Description                                                                  |
| ------------------------------ | -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `--agent <id>`                 | no                   | workspace discovery | Use the exact configured workspace for an installed agent.                   |
| `--json`                       | no                   | off                 | Write one undecorated structured result to stdout.                           |
| `--kind <issue\|pull-request>` | with other selectors | none                | Select the item kind; provide `--repository` and `--number` together.        |
| `--number <number>`            | with other selectors | none                | Select a positive item number; provide `--repository` and `--kind` together. |
| `--repository <owner/name>`    | with other selectors | none                | Select a repository; provide `--kind` and `--number` together.               |

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
Permission-check failures list the affected repository and item with a safe
cause; unrelated admitted items remain available, and later polls retry the
failed items after access is corrected.

### `openclaw agent-system notifications wait`

Wait for one semantic notification checkpoint without parsing session history or presentation text.

#### Options

| Option or argument             | Required             | Default             | Description                                                                  |
| ------------------------------ | -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `--agent <id>`                 | no                   | workspace discovery | Use the exact configured workspace for an installed agent.                   |
| `--for <target>`               | yes                  | none                | Select a supported lifecycle checkpoint below.                               |
| `--json`                       | no                   | off                 | Write one undecorated structured result to stdout.                           |
| `--kind <issue\|pull-request>` | with other selectors | none                | Select the item kind; provide `--repository` and `--number` together.        |
| `--number <number>`            | with other selectors | none                | Select a positive item number; provide `--repository` and `--kind` together. |
| `--refresh`                    | no                   | off                 | Advance provider-owned intake while waiting.                                 |
| `--repository <owner/name>`    | with other selectors | none                | Select a repository; provide `--kind` and `--number` together.               |
| `--timeout <seconds>`          | no                   | `300`               | Integer from `1` through `2147483` bounding the complete wait.               |

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
| `assignment-rejected` | yes               | The selected assignment failed admission      |
| `baseline-ready`      | no                | The first safe provider observation completed |
| `prepared`            | yes               | Lifecycle-owned intake resources are ready    |
| `retired`             | yes               | The selected assignment retired logically     |
| `worktree-ready`      | yes               | The selected issue worktree is ready          |

Terminal diagnostics fail immediately. A timed-out or otherwise incomplete wait
returns nonzero.

## Model routing

All four [model profiles](../../MANIFEST.md#models) enable routing for new issue
conversations in either mode; existing conversations and default-only manifests
keep their behavior. Before substantive work, the manifest default model assesses
bounded issue content in a fresh, tool-free native context. The channel validates
the assessment with the [shared resolver](../../tools/model-routing/README.md)
and saves the selection before the initial assignment turn.
Automatic effort is `medium`, `high`, or justified `xhigh`.

Verified native **Complexity** takes precedence. When native metadata is missing
or unavailable, a visible fenced YAML capsule with `schema: tanaab/task-metadata/v2`,
`mode: fallback`, and `fallback.complexity` can supply it. Missing, invalid,
conflicting, and unavailable values remain distinct evidence for content
assessment. **Work size** informs scope and decomposition, never the tier.
Unresolved complexity retains its status and reason and uses the frozen default;
manual model and effort selection remains available. Unsupported profiles,
malformed assessments, and failed classifiers block the issue for retry without
substitution.

For complete issue routing, `install` additively grants agent and classifier
access to the manifest default in both OpenClaw LLM allowlists, preserving
unrelated settings. Default-only, disabled, and pull-request-only declarations
request nothing. If `doctor` reports saved permissions absent from its loaded
state, restart the Gateway and retry the prepared assignment. Polling never
grants access or substitutes for authentication.

Saved model and effort survive retries, restarts, comments, delivery continuation,
and manifest edits. Supported native overrides take precedence independently.
A permitted native fallback can continue automatic routing; a strict-selection
mismatch or unapproved model cancels work. Execution records distinguish verified,
permitted, and unverified selections. Missing native evidence alone neither blocks
publication nor proves the requested route ran. The initial
[routing note](../../tools/model-routing/README.md#reporting-and-continuation)
remains private and is not execution evidence.

A demonstrated reasoning blocker permits a conversational request for operator
approval of a specific stronger profile, explaining the failed approach; it is
not a structured clarification outcome. Authentication failures, rate limits,
slow tests, and missing requirements do not justify escalation. Apply an approved
change only through native controls that preserve both model and effort, or leave
it to the operator's supported session controls. Native runtime evidence must
confirm the stronger selection.

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

- enforces the [admission and publication boundaries](#security-and-lifecycle)
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
repository preparation is serialized. See the
[assignment scenario](https://github.com/tanaabased/openclaw-agent-system/blob/main/scenarios/issue-work-assignment/README.md)
for execution-lease and durable-recording checks.

### Managed Worktrees

The channel uses [managed Git worktrees](../../tools/git/README.md#gitworktrees).
New GitHub issue worktrees keep the immutable-id directory but name the branch
`<issue-number>-<title-slug>-<five-character-hash>`. The title slug is limited to
48 characters and falls back to `issue` when the title cannot be slugged. The
hash separates agent-scoped worktrees for the same issue. Existing GitHub issue
branches keep their original names through retries, title edits, and cleanup.

When GitHub reports new canonical coordinates for the same immutable repository
and owner identities, the channel may update the managed origin. It verifies and
fetches the new origin before continuing and restores the prior origin on failure.
This retargeting is unavailable through the model-facing worktree tool and
operator command.

Completed assignment retirement removes only the exact clean managed checkout,
using non-forced Git removal. Missing worktrees complete idempotently; dirty,
unsafe, or unreadable checkouts, local branches, and remote refs remain untouched.
See the [retirement scenario](https://github.com/tanaabased/openclaw-agent-system/blob/main/scenarios/issue-work-retirement/README.md)
for incomplete-work retention and completed-work cleanup.

### Pull Request Review Feedback

Submitted reviews on an issue's linked delivery PR enter the same conversation as
ordinary comments. An approved human must mention the installed GitHub account in
their review summary or one of their findings, outside quotes and code. That mention
admits the review's findings together; reviewer assignment or a review skill does
not grant admission. Pending reviews do not trigger work. Later inline replies
require their own approved author and exact mention; parent text and diff hunks
cannot supply either.

One review produces one feedback turn. Later edits include only changed findings,
while unchanged summaries and parent replies remain context. The
[feedback presentation](./PRESENTATION.md#direct-message) preserves source links
and locations; original locations are historical, and the agent must inspect
current code before applying an old finding. The
[comment scenario](https://github.com/tanaabased/openclaw-agent-system/blob/main/scenarios/issue-work-comment/README.md)
covers grouped reviews, historical locations, and later inline replies.

Discovery pages and consumed member digests survive restarts. Each pass reads a
bounded page of reviews and inline comments, resumes pagination, and revisits
completed scans for edits. A review must fit the complete-group boundary before it
can dispatch: at most 400 comments within 40 pages, the configured
`maxCommentCharacters` across its authored prose, and 64,000 characters of projected
diff context. Each diff hunk is limited to 8,000 characters with explicit truncation
metadata. Oversized or incomplete groups are not executed as partial instructions.
The existing 400-revision conversation limit remains; capacity exhaustion reports
`github-notification-feedback-capacity-exceeded` without consuming the new source.

Replies remain top-level comments on the source PR, with exact-source
reauthorization and durable publication receipts. Inline reply publication,
automatic thread resolution, and independent review-assignment sessions are not
implemented.

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
