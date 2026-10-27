# GitHub Notification Reference

Shared workflow behavior, operator commands, and recovery for OpenClaw and Codex.
Start with the [GitHub setup guide](./README.md). This guide owns workflow
configuration; the [manifest reference](../../MANIFEST.md) owns shared workspace
syntax and the [GitHub tool guide](../../tools/github/README.md#configuration-reference)
owns account, credential, and CLI settings.

## Configuration Reference

Declare `github.schema-version: 3` and configure `issue-assignment` directly under
`github`. Both runtimes support Plan, Work, and Auto issue assignment, with feedback
on retained issues and their linked delivery PRs. Independent review-request
execution remains unavailable; its declaration warns without blocking issue work.
See [Upgrading](../../UPGRADING.md) for retired configuration and reset requirements,
and [Codex setup](../../CODEX.md#github-notification-policy) for native workflow controls.

### Version 3 fields

All fields below are directly under `github`. Declare a literal `github.username`;
GitHub CLI-only configuration needs no workflow version. Unsupported keys and
workflow versions fail validation.

| Field                       | Type                                         | Required | Default             | Description                                                               |
| --------------------------- | -------------------------------------------- | -------- | ------------------- | ------------------------------------------------------------------------- |
| `allowed-repository-owners` | identity list                                | yes      | none                | Nonempty list of explicit user or organization identities.                |
| `interval-minutes`          | integer, 1–1440                              | no       | `5`                 | Scheduling and overdue detection cadence.                                 |
| `issue-assignment`          | object                                       | no       | absent              | Declares issue workflow machinery, even with an empty actor list.         |
| `max-concurrent-items`      | integer >= 1                                 | no       | `3`                 | Capacity within the owning intake scope, not a distributed account limit. |
| `review-request`            | object                                       | no       | absent              | Reserved shape; warns and activates no independent review machinery.      |
| `runtimes`                  | nonempty unique list of `openclaw` / `codex` | no       | `[openclaw, codex]` | Selects the runtime installations that reconcile this workflow.           |
| `schema-version`            | integer                                      | yes      | none                | Must be `3`; the outer workspace version remains `1`.                     |

Under `github.issue-assignment`:

| Field            | Type                      | Required | Default                      | Description                                                    |
| ---------------- | ------------------------- | -------- | ---------------------------- | -------------------------------------------------------------- |
| `allowed`        | identity list             | no       | `[]`                         | Approved assignment actors; also included in feedback authors. |
| `assessment`     | skill/guidance object     | no       | default assessment skill     | Customize issue investigation and planning.                    |
| `feedback`       | skill/guidance object     | no       | default reply skill          | Customize replies without changing approved authors.           |
| `implementation` | skill/guidance object     | no       | default implementation skill | Customize authorized implementation.                           |
| `mode`           | `plan`, `work`, or `auto` | no       | `auto`                       | Select the initial issue workflow.                             |
| `paused`         | boolean                   | no       | `false`                      | Desired scheduler pause, reconciled by Install.                |
| `reviewers`      | identity list             | no       | `[]`                         | Additional PR reviewers and approved feedback authors.         |

`github.review-request` reserves `allowed` (identity list, default `[]`), `paused`
(boolean, default `false`), and optional `review` and `feedback` skill/guidance
objects. All are optional; no independent review execution or default review skill
is available. Neither `enabled` nor separate feedback modes or author lists are
accepted.

### Identity lists

Identity lists accept quoted `"@name"`, a GitHub node-ID string, or an object with
`node-id` and exactly one of `login`, `name`, `owner`, or `org`. Object names omit
`@`; the aliases all describe the same name and grant no organization membership
or operator authority. Mixed, inline, and block lists are supported. Bare names,
numeric database IDs, incomplete objects, and conflicting pins are rejected.
Provider lookup verifies the identity and its type; actors and reviewers must be
users. Duplicate identities produce one effective grant or recipient.

Parsing and Validate are offline. Authorized connected consumers resolve identity
references into non-secret caches scoped to the runtime, workspace, agent, and host
namespace. Each operation refreshes the identities it uses. A previously resolved
`@name` stays pinned to its immutable node ID; refresh follows that ID through a
rename, so reuse of the old name cannot grant a different account authority. Use an
explicit new node ID to deliberately select another account. Object pins require
the configured name and ID to match; update their names after a rename. Provider
failures report a diagnostic rather than becoming empty allowlists. Passive hooks
may read existing metadata but never perform the lookup or resolve credentials.

Workflows require a literal `github.username`; native Codex host authorization
supplies GitHub access without consuming the manifest token or reconciling managed
OpenClaw credentials, keys, CLI configuration, or tool policy. Existing account and
tool configuration remains under its owning runtime.

### Pull request recipients

For assignment-started work, delivery assigns the original assignment actor, not
the issue author. Set `issue-assignment.reviewers` to request additional reviews.
Reviewers also join the workflow's feedback author set. GitHub UI changes and
CODEOWNERS requests do not grant Agent System feedback authority. Delivery adds
missing recipients without removing existing assignees or review requests;
completed reviews are not requested again. [Manual launch](#manual-issue-launch)
has no assignment actor and therefore no assigner-derived default assignee.

### Assessment selection

Each stage accepts the shared [skill and guidance values](../../MANIFEST.md#skill-and-guidance-values).
Omission or `{}` keeps its default skill without extra guidance:

| Configuration path                | Default skill                                                            |
| --------------------------------- | ------------------------------------------------------------------------ |
| `issue-assignment.assessment`     | `agent-system:agent-system-task-assessment`                              |
| `issue-assignment.feedback`       | `agent-system:agent-system-github-reply`                                 |
| `issue-assignment.implementation` | `agent-system:agent-system-task-implementation`                          |
| `review-request.feedback`         | `agent-system:agent-system-github-reply` (reserved; no review execution) |
| `review-request.review`           | none; review execution is unavailable                                    |

For example, add this under `github`:

```yaml
issue-assignment:
  mode: plan
  assessment:
    skill: $agent-system:agent-system-task-assessment
    guidance: |
      Challenge unnecessary scope.
      Prefer small, independently reviewable changes.
```

Alternatively, use `guidance: { file: guidance/assessment.md }`; paths resolve from
the stable bound agent workspace. A selected skill may return ordinary analysis
without Agent System commands or required headings. The workflow retains the
complete answer and adapts it for saving and display, preserving its evidence,
questions, uncertainty, and conditions. Customization never grants implementation
or publication authority. Invalid explicit selections block the affected operation;
correct them and refresh context in the same chat.

#### Implementation and review selection

Assessment is shared by Plan, Work, and Auto; Work and Auto Work use the configured
implementation skill. The same skill/guidance syntax applies to implementation and
the reserved review stage. Arbitrary stage graphs are unsupported. Declaring a
review customization does not enable independent review requests.

### Issue-only profile example

This standalone Codex declaration uses native host GitHub authorization. It assumes
[model profiles](../../MANIFEST.md#models), including `low`, are already configured:

```yaml
schema-version: 1
agent:
  id: pirog
github:
  schema-version: 3
  username: pirog
  runtimes: [codex]
  allowed-repository-owners: ['@tanaabased', '@pirog', '@lando']
  issue-assignment:
    mode: plan
    allowed: ['@pirog']
```

### Activation

The declared workflow and selected runtime determine what Install needs to set up. An
empty `allowed` list stops new assignments from being admitted, but Install still sets
up the channel, conversation, and schedule required by that runtime. Adding approved
actors later is a live-policy change. Omitted workflows and reserved review requests
activate no machinery.

Install reconciles the selected runtime's channel/session/scheduler prerequisites and
establishes the first-activation baseline. Reading the manifest alone never activates
work. `paused: true` is Install-reconciled desired state for future schedule
occurrences; accepted runs, existing issue work, and feedback authority retain their own
rules. Repeated Install reuses retained jobs, channels, and baseline evidence. See
[Codex intake](../../CODEX.md#github-notification-policy).

OpenClaw uses the native automation reconciler and the owning agent's `models.default`;
standalone Codex uses `models.low`. Both reserve the derived job ID
`github-issue-assignment`: do not also declare it under `automations`.
OpenClaw chat Install/Doctor report the need for operator scheduler synchronization;
use the operator CLI to reconcile or inspect that scheduler. Codex uses its native
app workflow. See [Install and Verify](./README.md#install-and-verify) for the
assignment conversation and readiness channel.

<a id="issue-modes"></a>

### Live policy and modes

The current bound `agent.yaml` governs the next automatic operation. Mode, approved
author, reviewer, guidance, and capacity changes apply without Install. Run Install when
changing the installed schedule, including its cadence or pause setting.

- **Plan** produces an assessment and waits for direction before implementation.
- **Work** continues an actionable plan through implementation and PR delivery.
- **Auto** chooses Plan or Work with a recorded decision; it is the default mode.

No mode grants merge, deployment, expanded repository scope, or permission to change
its own mode. Clarification pauses implementation without revoking its stage.

Work and Auto Work can continue in the same native turn. Intake recovers idle or
interrupted work in its existing issue chat. Once implementation has started, a
later default-mode change does not return the issue to planning. Policy edits do
not cancel running turns, revive retired work, or repeat uncertain publications.
GitHub credentials and repository protections still govern provider access.

<a id="feedback-permissions"></a>

### Feedback and public replies

Feedback authors are the union of `issue-assignment.allowed` and
`issue-assignment.reviewers`. Their verified comments are task direction, like
messages typed into the issue chat; authors need not also be assignees. An explicit
request to implement can move Plan or Auto work into implementation through the
same transition as direct input. Questions need not produce code, and quoted or
linked material cannot independently authorize work.

Omitted `feedback` and `feedback: {}` retain the same author set. There is no
independent feedback-off switch or replacement author list. Author and instruction
edits apply live; scheduler pause does not revoke feedback authority. Empty actor
and reviewer lists approve nobody while retaining the installed machinery.

Approved mentions in issue comments, linked PR conversation comments, submitted reviews,
and inline replies return to the original issue chat. Busy chats queue feedback within
shared capacity. Inline replies return to their review thread; other replies return to
the source issue or PR. Edited or removed sources, removed mentions, and changed
authority stop pending publication without erasing retained answers. Moving review code
coordinates alone does not create new feedback. When a send or publication has an
uncertain outcome, the workflow checks what happened before trying again.

The issue chat shows the complete private response; the configured reply skill
composes a separate public answer with its confirmed link. Feedback authored by
the publishing GitHub account receives a private response only. Confirmed runtime
replies are excluded from intake to prevent reply loops.

Follow-ups receive the current plan, recent responses, and unfinished work. They
update the existing PR where appropriate without replacing the original assessment.
Clarification pauses implementation until an answer arrives; it does not require
another handoff or approval.

When no authors are approved, observed activity stays in GitHub history rather than
becoming a backlog. After acceptance resumes, approved comments or revisions since
the previous policy check can be admitted; older history is not replayed. Work
already admitted remains recoverable under current policy. Reenabling acceptance
does not post a retrospective assessment.

For a direct reply without scheduled intake, use
[GitHub Reply](../../skills/github-reply/SKILL.md) with an exact comment, review,
issue, or PR destination. It uses the agent's configured reply skill, guidance, and
voice. Drafting does not publish; request publication through the owning runtime
and its approval flow. Existing managed work keeps its workflow context.

For an explicitly requested progress update, use
[Task Update](../../skills/task-update/SKILL.md). It compares verified progress with
the issue, posts only missing material facts, and returns the full private answer
with the confirmed public quote. It does not start implementation or change mode.

### Pause and resume

Set `issue-assignment.paused: true` and run Install to pause the native schedule;
set it to `false` and run Install to resume the same job and conversation. A native
UI pause also stops future occurrences, but an accepted occurrence and running issue
turns may finish. Eligible activity during the pause is discovered after resume.

Pause preserves authorization, pending work, and discovery progress. Install follows
the manifest and can reverse a UI-only pause. `enabled` is not supported; use
`paused`. The reserved review-request configuration has no execution adapter.

## Working History and Limits

Settled detail moves out of the working journal after **2 MiB**, or before its
**400-event** feedback limit. Unfinished work, current plans, publication holds,
and recovery evidence remain live. The working-content limit is **4 MiB** with a
separate **1 MiB** dispatch reporting reserve.

Historical snapshots expire **30 days** after settlement (or first offloading when
no settlement time exists), or sooner under a shared **64 MiB** budget per native
agent/workspace journal. Cleanup runs on saves; expired files may remain on disk
until the next save but are unavailable to readback.

Ask for the full assessment or historical evidence in the owning chat. Dispatch
`present` with `includeDetails: true` returns available detail, with a private file
path for large snapshots. Missing, expired, or corrupt detail is reported as
unavailable. History does not authorize work or automatically become agent memory.

Records used to identify completed work and prevent duplicates do not expire with
history. If required records fill the journal, the operation reports a capacity error
and preserves the file. Corrupt or oversized journals are not automatically reset.

## Assignment lifecycle

Intake moves work from **Active** to **Retirement pending** after verified issue
closure, manual chat archival, or unassignment by a current approved assignment
actor. New assessment, continuation, and feedback dispatch stop; running work still
occupies capacity until inactivity is verified.

If the unassignment actor is unapproved or cannot be verified, the chat and worktree
remain intact and inspection reports unresolved removal authority. Already admitted
work may continue within its existing permissions. Verified reassignment or recovered
provider evidence can resolve the warning; Agent System does not reassign the issue.

Automatic cleanup uses the [installation-wide grace period](../../CONFIG.md#shared-cleanup),
defaulting to **60 minutes** from first observation. There is no per-agent override
or disable switch. Restart preserves the deadline; new native activity defers cleanup.
Verified reassignment, or an admitted comment from an approved feedback author, can
reactivate an unarchived conversation before cleanup starts. A comment resumes
feedback, not implementation or a mode change. Reopening alone and the agent's own
replies do not reactivate work. Assignment after retirement can start a new attempt.

### Manual retirement

Use [Task Retirement](../../skills/task-retirement/SKILL.md) to preview and retire one
owned task. The explicit request skips scheduled eligibility and grace, but keeps
ownership, activity, and preservation checks. It does not close or unassign the
GitHub issue or change its branch. A task cannot archive its own active turn.
Repeat the same request or let intake finish pending cleanup.

### Cleanup and recovery

OpenClaw archives the idle session and removes its owned worktree after verifying
ownership and a retained branch or tag. For a freshly verified closed issue,
modified or untracked files may be discarded and a changed branch name does not
block cleanup. Other retirement triggers require a clean checkout and the expected
branch. Pins, automation owners, shared worktrees, unresolved activity, and
unreferenced commits remain protected.

Codex uses desktop archival and worktree preservation. Closed-issue checkout changes
do not block preparation; other triggers require a clean checkout. Retirement
completes only after both archival and removal are observed. If desktop settings
retain the checkout, cleanup stays pending without blocking unrelated intake.

Interrupted cleanup resumes from completed steps. Already-absent resources are
observed rather than removed again. OpenClaw can reconcile unavailable sessions
while retaining ownership and worktree checks; timeouts, conflicting identities,
and known active work remain blockers. Historical retirement without sufficient
native cleanup evidence remains pending. Branches and issue content are preserved;
assessment detail follows the [history limits](#working-history-and-limits).

`retirement-native-archive-denied` means the native archive call was rejected;
inspect the intake chat's approval result. `retirement-native-archive-unverified`
means the outcome is uncertain and intake is still reconciling it. An uncertain
outcome is not a reason to repeat the archive manually.

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
# request the installed native workflow now.
openclaw agent-system notifications refresh
```

`refresh` requests a run of the
already installed native OpenClaw issue automation. A successful request
reports `queued` and its native run ID; it does not claim the scan or assessment
has completed. Installation and workflow activation remain explicit. Disabled,
stale, or unreconciled workflows fail without enabling jobs.
Each scheduled or explicitly requested intake run can start several assessments,
bounded by the slots available when it begins. Already-started assessments keep
running; quick completions do not refill that run’s allowance. Excess assignments
wait for a later run. Item-specific failures do not stop unrelated eligible work.

The workflow checks uncertain creation and send attempts before trying again.
Capacity is released only after native inactivity is verified. Dispatch reports
`waiting` for unresolved evidence or setup, `retrying` for transient recovery, and
`blocked` for explicit stops such as denial, cancellation, or lost authority.
Recognized transport and rate-limit failures back off from five minutes up to an
hour, honoring longer provider cooldowns. They do not require a fresh stage approval.

Diagnostics retain the affected issue, operation, and available HTTP status;
unclassified failures do not establish a credential problem. A native approval
denial requires recovery for that exact call; reassignment does not erase it.
Retired history appears in routine reports only when it still consumes capacity
or prevents a new assignment. Closed fixtures need no repeated operator cleanup.

`feedback-discovery-no-progress` identifies a feedback operation that repeated
checks could not complete. Later checks retry automatically. If it persists,
inspect the reported operation and provider access or latency; preserve discovery
progress rather than resetting it.

With `--repository OWNER/REPO --kind issue --number NUMBER`, refresh performs one
immediate intake scan of that issue and reports `completed` when admission checking
finishes. It does not run or alter the recurring automation, dispatch work, or retain
the selector. It preserves the account-wide checkpoint and previously admitted work.
Pull-request selectors are unsupported; feedback remains owned by retained issue
conversations. Without selectors, refresh requests the installed native automation
as described above. An uncertain native enqueue is reported rather than retried.

### `openclaw agent-system notifications reset`

Reset notification management for selected agents. Explicit `--agent` or `--all`
supplies the target scope without opening the target picker; otherwise, the picker
lists individual agents only. The operator confirms the reset separately. The
command pauses intake, waits for managed turns, clears routing and feedback records,
establishes a fresh assignment baseline, archives the old intake chat, creates a
fresh coordinator, and restores the previous intake setting. Existing assignments
and comments do not replay; a new approved assignment after the baseline can start
new work.

**Options:**

| Option or argument        | Required | Default | Description                                                                                                        |
| ------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `--agent <id>`            | no       | none    | Select this agent; repeat to select multiple agents without reopening target selection.                            |
| `--all`                   | no       | false   | Select all configured agents with managed manifests without target selection; conflicts with `--agent`.            |
| `--confirmation <digest>` | no       | none    | Require the read-only preview to remain unchanged before starting.                                                 |
| `--fresh`                 | no       | false   | Start fresh reset checks while retaining the interrupted operation's cleanup inventory and native action receipts. |
| `--json`                  | no       | false   | Emit structured results; requires explicit targets and `--preview` or `--yes`.                                     |
| `--preview`               | no       | false   | Show the explicit selection and inventory without changing state or requiring confirmation.                        |
| `--purge`                 | no       | false   | Also archive managed issue chats and remove owned checkouts, including modified, untracked, and ignored files.     |
| `--yes`                   | no       | false   | Confirm explicit targets without prompting; does not override ownership or activity checks.                        |

**Usage:**

```sh
openclaw agent-system notifications reset [--agent <id> ... | --all] [--purge] [--fresh] [--preview] [--confirmation <digest>] [--yes] [--json]

# select agents interactively and confirm the reset
openclaw agent-system notifications reset

# select two agents explicitly and confirm the reset
openclaw agent-system notifications reset --agent agent-one --agent agent-two

# preview one agent without changing state
openclaw agent-system notifications reset --agent agent-one --preview --json

# reset all managed agents without prompting
openclaw agent-system notifications reset --all --yes

# review the destructive resource inventory before purging one agent
openclaw agent-system notifications reset --agent agent-one --purge

# restart checks for an interrupted purge without discarding its cleanup targets
openclaw agent-system notifications reset --agent agent-one --purge --fresh
```

Ordinary reset preserves issue conversations and checkouts while replacing the intake
conversation. Both modes leave GitHub issues, assignments, comments, and all pull
requests unchanged. Purge retains repositories, named and remote branches, and
protected or shared resources. It reports incomplete cleanup when
ownership, native activity, or an earlier creation cannot be verified.

A private recovery record retains the exact scope, resource inventory, and prior
intake setting before effects begin. Interactive recovery offers resume or start
fresh; unattended recovery resumes unless `--fresh` is supplied. Fresh rechecks
native activity and restarts local reset phases, preserving completed cleanup and
unverified native actions. Once fresh recovery begins, repeated calls resume it.
Changing `--purge` while an operation is unfinished is rejected.
The record is removed only after completion. Do not delete it to force a fresh
reset. If automatic pause fails, pause intake in the scheduler; the command waits
for that change and for managed turns to finish. It never aborts turns.

On OpenClaw, fresh recovery checks native sessions for old creation requests with
no recorded chat. An empty inventory permits cleanup. Existing conversations with
unproven ownership and their checkout are preserved and reported in warnings and
resource results; reset completion does not claim those resources were purged.

For an archived or missing intake chat without a tracking reset, run Doctor and
then Install. Doctor only reports the missing coordinator; Install creates a fresh
chat and retargets intake while preserving existing issue records and receipts.
`$agent-system-notifications-reset` guides the explicit reset and confirmation;
OpenClaw-hosted agents hand the operator the terminal command.

Selected agents run independently. A failure for one agent does not undo completed
resets for the others. This command covers the installed issue workflow; it does
not implement the future review workflow.

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

`status` reports baseline, capacity, preparation, and blockers. An item's optional
`workflow` includes its phase and conversation; a created chat is not a completed
plan. `workflowStatus` distinguishes `retirement-pending`, `retired`, `obsolete`,
and `partially-delivered` work whose PR exists but still needs linkage or presentation.
Only issue selectors and native OpenClaw Plan, Work, and Auto workflows are supported.
Observation performs no scan, credential resolution, scheduler writes, or chat creation.

Scheduled intake reports started issues and capacity, with new or changed blockers and
verified recovery. Healthy, unchanged checks stay silent. Automation drift directs the
operator to Install; checks do not repair schedules. A missing or disabled job cannot
report from its own run, so use Doctor to inspect it. An incomplete check does not
establish that a scan succeeded or found no work.

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
| `--refresh`                    | no                   | off                 | Request native workflow runs while waiting.                                  |
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

| Target           | Selector required | Meaning                                       |
| ---------------- | ----------------- | --------------------------------------------- |
| `baseline-ready` | no                | The first safe provider observation completed |
| `plan-ready`     | yes               | Native retained assessment is plan-ready      |
| `prepared`       | yes               | Lifecycle-owned intake resources are ready    |
| `worktree-ready` | yes               | The selected issue worktree is ready          |

Waits use the same native observation as `status`. `prepared` requires a
verified conversation binding and worktree; `plan-ready` requires the retained
assessment result. The wait command does not expose rejected assignments or lifecycle
retirement as targets. `assignment-rejected` and `retired` return
`github-notification-wait-target-unsupported` immediately without requesting a refresh.
With `--refresh` and an issue selector, each intake refresh is limited to that
issue. These one-off scans do not run dispatch; waits observe progress made by the
native coordinator. Without a selector, refresh requests the ordinary automation
and waits for its exact native run before requesting another cycle. Without
`--refresh`, selectors restrict observation only.

Terminal diagnostics fail immediately. A timed-out or otherwise incomplete wait
returns nonzero.

## Issue Implementation and PR Delivery

### Assessment and implementation

Use [Task Assessment](../../skills/task-assessment/SKILL.md) to assess an explicit
issue in an existing checkout without assignment or intake activation. It uses the
configured assessment skill/guidance and retains the complete plan, questions, or
blocker. Direct assessment stops before implementation or publication, even with
Work/Auto defaults. Answer questions or ask for the full assessment in the same chat.

Use [Task Implementation](../../skills/task-implementation/SKILL.md) with an authorized
actionable plan, issue URL, and existing checkout, or resume matching managed work.
Direct manual implementation defaults to local work; request a PR explicitly to
include publication. Neither skill creates a new managed workflow; use
[Manual Issue Launch](#manual-issue-launch) for that.

In a managed Plan-mode chat, request implementation when the plan is ready. Work or
an Auto Work decision already permits implementation and ordinary PR delivery.
Clarification pauses work until an answer arrives; scheduled intake does not replay
unanswered questions. Interrupted work resumes in the same chat without repeating
completed implementation. Invalid managed context needs recovery rather than a
second manual workflow.

You can change the model or reasoning effort through native controls without
recreating the task. Continuation respects that choice. Configured
[routing skills and guidance](../../MANIFEST.md#models) select the initial model;
they do not automatically switch models between planning and implementation.

### Delivery and follow-ups

Delivery requires committed work on the task branch. It assigns the PR to the
original issue assigner, requests configured `issue-assignment.reviewers`, verifies
the closing issue link, and posts a concise announcement on the issue. The
announcement uses the configured reply skill and voice and includes the PR link,
change description, and GitHub's draft/ready status. Native approval still applies.
The issue chat shows the PR card and confirmed public quote.

Authorized follow-up commits update the same PR after incorporating remote changes,
including collaborator commits. Pushes are non-force. Explicit title/body requests
update the PR; commit-only pushes preserve text edited on GitHub.

### Interrupted publication

Continue in the same issue chat to recover an assessment summary, reply, or PR
announcement. Agent System checks uncertain writes before posting again. If the PR
already exists, recovery finishes missing linkage, attachment, or announcement steps;
it does not push newer local or uncommitted work. Reconcile uncertain PR creation
before requesting another PR or editing its text.

Missing access, changed sources, edited posts, and native denials remain visible
obstacles. A denied assessment summary needs verified recovery or renewed
authorization, but does not itself block independently authorized implementation.
Cancellation and implementation-specific denials still stop that work. A stale
publication preview requires inspecting the refreshed operation and retrying within
the existing authorization; repeated staleness needs investigation.

In OpenClaw, after stopping a feedback turn, explicitly ask the owning chat to
finish its retained reply. It preserves the answer and pushed work while checking
what was already published. Stopping the turn alone does not restart it or override
a denial.

If a PR card is missing, ask the same chat to show it again. Saved plans and cards
remain readable without a fresh publication grant, matching checkout commit, or
GitHub access. They reflect retained evidence, not a fresh provider check, and
showing them does not push code or publish comments. A failed announcement does not
undo an existing PR; ask the same chat to recover only the missing announcement.

<a id="v1-retirement"></a>

## Channel readiness

The `agent-system-github` channel reports readiness; native automations run intake.
Install manages each agent's channel account from its declared OpenClaw workflows.
Removing workflow declarations requires Install to deactivate their accounts.
Other agents and operator-owned entries are preserved. With no declared accounts,
the channel is inactive but remains registered so existing configuration is valid.

Plain channel status reports saved configuration. Request a readiness probe with:

```sh
# inspect current channel readiness without starting work.
openclaw gateway call channels.status --params '{"probe":true}' --json
```

The probe reports setup and automation synchronization needs, unsupported workflows,
scheduler availability, execution/delivery failures, and the last successful scan.
Three missed scan intervals report overdue intake. Unavailable inspection reports
unknown; missing optional capabilities can report degraded status while ready intake
continues. Status does not resolve credentials or start work, and healthy status is
not a guarantee that the next dispatch will succeed.

Legacy polling and configuration do not activate intake. Use the current
[workflow configuration](#configuration-reference) and follow
[Upgrading](../../UPGRADING.md) before replacing an installation that still needs
an older workflow runtime.

## Installation identity and assignment claims

Install creates or preserves a UUID and readable name for each OpenClaw or standalone
Codex installation. Doctor inspects that identity without changing it. Use the
[OpenClaw instance commands](../../CLI.md#openclaw-agent-system-instance-inspect) or
[Codex identity actions](../../CODEX.md#workspace-setup) to inspect, rename, or explicitly
rotate it. Rotation does not transfer existing work.

Installation identity does not prevent two installations from starting the same
assignment: claim election is not active and has no configuration switch. Avoid
running duplicate intake for the same agent. If a saved pilot claim holds an
assignment, inspect the original owner before resolving it; rotating the installation
identity does not transfer that work.

## Manual Issue Launch

[Issue Dispatch](../../tools/dispatch/README.md#manual-issue-launch) starts the same managed
issue workflow by explicit operator request, without assignment or schedule activation.
The [installed launch scenario](../../examples/openclaw-issue-launch/README.md) owns its
OpenClaw CI journey; scheduled intake and direct assessment remain separate surfaces.
