# GitHub Notification Reference

## Configuration Reference

`github.notifications.schema-version` is optional and defaults to `2`; only
numeric `2` is supported when explicit. See the
[manifest reference](../../MANIFEST.md#githubnotifications) for fields, defaults,
authority, runtime selection, and current support. OpenClaw supports
Plan, Work, and Auto issue assignment with configured feedback
on retained issues and their linked delivery PRs. Independent review requests warn
without blocking those workflows.
Standalone Codex uses its [native workflow controls](../../CODEX.md#github-notification-policy).

Both runtimes save bounded discovery progress and resume on later polls. Ordinary
comments are fetched by update time; unchanged history does not trigger feedback.
OpenClaw keeps discovery inside one condition budget and wakes the coordinator for
saved actionable work or a one-time progress/recovery card. After upgrading, run
Install to reconcile the changed condition before relying on scheduled intake. Repeated
checks that cannot complete a required feedback operation report
`feedback-discovery-no-progress` with the affected issue or PR and pending operation.
Later bounded checks retry automatically; if the obstacle persists, inspect that
operation and provider access or latency. Preserve the checkpoint; no reset
or replay is needed.

The live bound `agent.yaml` governs the next automatic operation for every active
issue. Mode, author, feedback, recipient, and guidance edits take effect without
Install. Plan holds future implementation; Work permits an actionable plan to
continue; Auto additionally requires a Work decision. Existing Plan issues can become
eligible when the operator changes the mode to Work. Once implementation has
started, changing the default mode does not return the issue to planning. Both
runtimes retain this stage across restart and recover older implementation receipts
in place; existing lifecycle and native execution checks still apply.

Verified comments from approved feedback authors are task direction in Codex and
OpenClaw, like direct input in the issue chat. In Plan or Auto, an explicit request
to implement can enter Work through the same recorded transition without an
additional Work decision. Work permits appropriate implementation; autonomous Auto
selection still chooses Plan or Work with a reasoned decision. Authors need not also be
issue assignees. Quoted and linked material cannot independently direct the agent. Questions need not produce code.
Each feedback attempt retains its own outcome and commit without replacing the
original assessment or implementation. Finished work updates the existing PR;
uncertain pushes are reconciled, and the original announcement is reused. A
clarification request preserves implementation authority for the next admitted answer.
Direct and GitHub follow-ups receive retained plan revisions, private responses,
and partial work before interpreting the new message; that history supplies context,
not new authority.
No separate repair policy or author list is required.

Discovery retains bounded observations independently of reply eligibility.
Feedback follows its parent workflow and inherits approved assigners unless an
explicit author policy replaces them. Activity observed while no authors are
approved stays in GitHub history and is not queued for later dispatch. When the runtime observes acceptance resume, it saves an admission
cutoff for the issue and its PR using the previous policy-check time. Approved
comments or revisions after that cutoff become new feedback, including those
between the last check and reenabling. This overlap avoids missing comments posted
just after a configuration edit; a longer polling gap means a longer overlap.
Older records without a policy-check timestamp use their last saved scan time,
or the current check when neither timestamp is available. Work already admitted
before an author-policy change remains recoverable, and publication receipts
suppress duplicates. Reenabling sends no automatic retrospective assessment.

Set `paused: true` on `issue-assignment` and run Install to pause its native
schedule; `paused: false` resumes the same job and conversation. Native UI pause
has the same execution boundary: future occurrences stop, while an accepted
occurrence and running issue turns may finish. Pause does not change authorization,
feedback eligibility, discovery checkpoints, queues, or completed effect receipts.
Eligible activity arriving during the pause is discovered after resume. The
readiness account and dispatch enrollment remain configured. Install follows the
manifest, so it can reverse a UI-only pause when the manifest still requests an
active schedule.

The deprecated `enabled` alias is inverse: `enabled: false` means `paused: true`,
and `enabled: true` means `paused: false`. Validate, Doctor, and Install warn with
the exact replacement. Consistent pairs are accepted; contradictory pairs fail
validation. Omission keeps the existing scheduling default. `review-request`
accepts the same declaration but still has no execution adapter.

Install reconciles changes to installed scheduling machinery. Policy-only edits do
not change the orchestration definition. Native execution facts, explicit task
cancellation, lifecycle state, account/repository/chat identity, and exact submitted
requests remain distinct from mutable policy. A policy edit never repeats an
uncertain send or publication or automatically terminates a running native turn.

Git and GitHub enforce provider permissions. Managed workflow failures expose safe,
bounded provider detail and an HTTP status when supplied. Unsupported execution
capabilities are reported for their stage without disabling discovery.

## Assignment lifecycle

The existing intake run checks retained assignments in both runtimes. Verified issue
closure, removal of the receiving assignee by a live `issue-assignment.allowed` actor,
or manual chat archival moves work from
**Active** to **Retirement pending** immediately. This stops new assessment,
continuation, and feedback dispatch for that record. Native work already running
still occupies a slot until inactivity is verified.

When GitHub no longer shows the assignment but its removal actor is unapproved or
cannot be verified, inspection and issue context report unresolved removal authority.
The existing chat, worktree and implementation stage remain intact; already admitted
work may continue only within its existing mode and permissions. Plan stays Plan.
No automatic reassignment occurs. Verified reassignment clears the warning; recovered
provider evidence or a relevant live actor-list change can resolve removal authority.
Removal authority is checked again before cleanup. Completed or uncertain native
cleanup effects keep their receipts and are not automatically undone or repeated.

Automatic cleanup defaults to enabled, with a 60-minute grace period under
`github.notifications.cleanup`. The deadline starts when intake first observes the
change. Polling and restart preserve it; new native activity defers cleanup. Fresh,
verified reassignment before archival reactivates the existing conversation. A fresh
assignment after archival or retirement can start another attempt without erasing
prior receipts. An admitted new comment from a configured feedback author can also
reactivate an unarchived conversation before cleanup starts. This resumes feedback,
not implementation or a mode change. Reopening alone, incidental comments, and the
agent's own published replies do not reactivate work.

OpenClaw archives the exact idle session and removes its managed worktree after
verifying a clean checkout and retained branch or tag. It protects pinned sessions,
automation owners, shared worktrees, unresolved activity, and unpreserved changes.
Each successful cleanup step is retained so interrupted cleanup can reconcile on a
later poll. Branches, issue content, and assessment history are preserved. Older native creation receipts can establish session identity without replacing
them. If the managed inventory and recorded path both confirm an already-removed
worktree, retirement records observed external cleanup after its ownership checks;
this does not claim to have removed or preserved the missing checkout. For work
already pending retirement, a null session lookup, an explicit lookup access denial,
or a legacy creation attempt with no child identity can also proceed through the
same grace, ownership, and worktree preservation checks. This is an inferred
unavailable-session outcome, not proof of deletion or rejected creation; it is
recorded separately without inventing archival. Existing worktrees are removed only
when the normal checks pass; already-absent worktrees are observed, not removed again.
Timeouts, temporary read failures, conflicting identities, and known active work
remain blockers. Retirement retains the record and history; it does not reassign
the issue automatically.

Codex prepares archival through the desktop's native tools after checking pins,
automation ownership, shared use, and preserved work. The desktop owns worktree
snapshotting and reclamation; intake marks work retired only after observing both
archival and removal. If desktop settings retain the checkout, cleanup stays pending
without blocking other intake. Disabling cleanup preserves resources and marks
inactive work retired.
Run Install after an upgrade when Doctor reports changed automation machinery.
Policy-only edits apply live.

`retirement-native-archive-denied` means the exact native archive call was rejected;
inspect the intake chat's native approval result before taking operator action.
`retirement-native-archive-unverified` means submission or outcome is uncertain;
intake keeps reconciling native evidence. Neither result repeats the archive. A
fresh preparation is automatic only when native history proves no call was submitted.

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

Codex and OpenClaw retain uncertain creation and send attempts for reconciliation;
a newer assignment never authorizes a duplicate conversation. Capacity is released
when native evidence proves inactivity, not merely because an error occurred or a
record was retired. Dispatch reports use `waiting` for unresolved receipts or setup
requirements, `retrying` for scheduled transient recovery, and `blocked` for explicit
stops such as denial, cancellation, or lost authority. Recognized transport and
rate-limit failures back off across scheduled runs, from five minutes up to an hour,
honoring longer provider cooldowns. A prolonged outage needs no fresh stage approval;
it does not discard the request or replay an uncertain write. Inspection also exposes
`workflowStatus`: `retirement-pending` identifies work awaiting cleanup, `retired`
identifies completed lifecycle retirement, `obsolete` identifies other superseded intent, and
`partially-delivered` preserves a published PR while linkage, attachment, or its
announcement remains incomplete. These descriptions do not release capacity or grant
authority. Diagnostics identify the affected operation and issue, retaining successful
starts alongside failures. Provider errors keep their bounded structured evidence;
unclassified failures do not establish a credential problem.

Codex preserves the earlier retirement contract for historical records created before
reservation tracking: unresolved retired creations remain in inspectable history,
while any verified active native chat still occupies a slot. Their evidence remains
intact, and another creation for the same issue stays fenced until native inactivity
or non-submission is proved. New retirement never releases an uncertain reservation. Retired history appears in
routine reports only when it consumes capacity or prevents a newer assignment from
starting. Closed, retired fixtures do not need repeated operator cleanup.
The owning intake observes at most twelve recovery candidates per check and can use
`dispatch` action `reconcile` with a retired record's `id` to retry observation and
search native creation history when its receipt is missing. Ordinary polling avoids
repeating that broad search for retired records without a child ID. Native
terminal history remains readable for this purpose even when the chat is archived or
its worktree is gone. Missing resources alone prove nothing; inspection retains the
specific missing evidence in `capacityObservation`. Denial recovery reads native history from the retained preparation turn forward and
validates the latest admitted assignment. An automatic approval denial still needs
explicit operator recovery for its exact call; reassignment does not erase it.
Closed historical feedback with
no outstanding work stays quiet. Uncertain sends and publications remain visible.

With `--repository OWNER/REPO --kind issue --number NUMBER`, refresh performs one
immediate intake scan of that issue and reports `completed` when admission checking
finishes. It does not run or alter the recurring automation, dispatch work, or retain
the selector. It preserves the account-wide checkpoint and previously admitted work.
Pull-request selectors are unsupported; feedback remains owned by retained issue
conversations. Without selectors, refresh requests the installed native automation
as described above. An uncertain native enqueue is reported rather than retried.

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

Healthy, unchanged native checks stay silent. Intake reports link started issues to
their native conversations and show known managing, pending and slot counts. New or
materially changed blockers appear once; verified recovery appears once. Automation
drift directs you to supported Agent System Install; checks never repair schedules.
An absent or disabled job cannot warn from its own run: use explicit Doctor/Install.
Incomplete observations are not empty successful scans. Report preparation is retained
for same-run replay; it is not proof that the final card was visibly delivered.

`status` reads the native intake and dispatch records.
The existing table and JSON envelope report baseline, capacity, item preparation,
and blockers. An item's optional `workflow` contains its phase and bound
conversation: queued, routing, uncertain creation, created, assessing, or the
retained assessment outcome. A created conversation is not a completed plan.
Only issue selectors and the native OpenClaw Plan workflow are currently supported;
other runtime/workflow selections fail explicitly. Observation performs no scan,
credential resolution, scheduler writes, or conversation creation.

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
| `plan-ready`     | yes               | Native V2 retained assessment is plan-ready   |
| `prepared`       | yes               | Lifecycle-owned intake resources are ready    |
| `worktree-ready` | yes               | The selected issue worktree is ready          |

V2 waits use the same native observation as `status`. `prepared` requires a
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

An authenticated operator can continue a retained Plan-mode assessment in its
owning issue chat. An actionable Plan-mode issue needs human direction to enter implementation;
once there, ordinary PR delivery needs no separate publication grant. The agent retains the
complete plan and uses the existing chat, managed worktree, and model selection.

Work policy or an Auto Work decision lets the next intake pass continue an
actionable plan in the same issue chat, using shared capacity and its saved native
send receipt. An uncertain send is reconciled without sending again. Existing
implementation stages survive later default-mode edits.

Implementation may return `clarification-needed` with specific questions and a
complete account of partial work. The issue remains in implementation. Its chat
displays the questions and waits; a new answer resumes through verified context
without another handoff or approval. Scheduled intake does not replay the request.
A recorded `done` result can continue through PR delivery without repeating implementation.

Delivery requires committed work on the task branch. It applies configured
`issue-assignment.pull-request.recipients`, verifies GitHub's closing link, and
posts one concise announcement on the originating issue with the PR link, change
description, and GitHub's draft/ready status. It uses the configured reply skill and
voice guidance even when feedback intake is disabled. The private response retains
the complete quoted PR card, public quote, and publication outcome. Native approval
still applies to the comment. After an interrupted publication, ask the same
chat to reconcile the existing PR. A retained attempt with no verifiable PR remains
blocked rather than risking a second creation. Native denial, reassignment, or a
changed session/worktree stops the operation without discarding the work.

In Codex and OpenClaw, authorized follow-up commits can fast-forward the same PR
branch when the observed remote commits are incorporated locally, including collaborator updates. The same open PR, destination and ancestry are verified before a non-force push. The PR receipt and original announcement stay
with the delivery. Explicit title/body changes update that PR; commit-only pushes
preserve text edited on GitHub. Interrupted updates reconcile the same operation.
OpenClaw delivery reconciliation can finish incomplete provider checkpoints when the retained commit is already remote; a missing push requires the prepared publication path. Newer local or uncommitted work is not included by reconciliation.
If initial PR creation is still uncertain, reconcile it before changing its text.
Public assessment summaries, approved comment/review replies and PR announcements retain their drafts and attempted writes across interruptions. Continue in the same issue chat to finish only the missing response. An unconfirmed post is checked by its original marker and exact content, never blindly reposted. Missing access, changed sources, edited posts and native denials remain visible obstacles; the complete private result stays available. Pending assessment summaries can receive a response-only native continuation after the owner is idle. Implementation context also exposes pending summaries without moving work back to planning.

In OpenClaw, an explicit operator request in the owning chat can finish a retained feedback reply after its handler stops. The agent uses feedback context with `resume: true` to verify the current operator input and old terminal run, retaining the answer, pushed work and uncertain publication receipts. A manual stop alone never restarts work; real denials remain stops.

A stale publication preview returns a refreshed operation without writing. Inspect
it and retry once within the existing authorization; repeated staleness needs
investigation. Workflow activation or an operator request already covering that
effect needs no additional stage approval. Native approval denials remain terminal.

If showing an already-created PR is interrupted or temporarily busy, ask the same
issue chat to show its card again. Saved plans and PR cards remain readable in
the owning chat without fresh publication permission, a matching working commit,
or GitHub access. They show retained evidence, not a fresh provider verification.
Native chat identity is still checked. New assessments show a concise user-journey
review with documentation/test impact; the full assessment and engineering plan stay
saved for the agent. Ask for the full assessment, evidence, or investigation in that
same issue chat to inspect them. Older results without a separate review retain their
complete display. The bound `present` request accepts `includeDetails: true` in both runtimes.
Presentation does not push, create a PR, or post an announcement. In Codex, attachment reconciliation retries only attachment
inspection. Recipient identities remain pinned; GitHub authorizes recipient changes. If announcing fails, the PR
remains delivered. Ask the same chat to recover its announcement; uncertain writes
reconcile the saved text and receipt without posting a duplicate. Announcement
recovery uses the saved published commit, so newer local work does not require
another push. Recovery instructions skip confirmed attachments and announcements.

## V1 Retirement

Explicit notification version `1` and recognizable retired keys in unversioned
declarations are rejected with `github-notification-v1-retired`; current-format
declarations may omit the version and default to `2`. The polling channel, its Work/guided engine,
reply-staging tool, and task-PR tool have been removed. Independent review requests and custom assessment skills remain unavailable.
Retirement does not imply feature parity.

The channel id `agent-system-github` remains registered as a read-only readiness
surface. Existing accounts and bindings remain valid; the deprecated plugin
`githubNotifications` limits are accepted but unused. Legacy configuration never
activates V2 intake. Install adopts an old account only when its matching
Agent System-managed binding establishes ownership; conflicting accounts require
operator resolution. Historical receipts and grants remain untouched.

Install manages each agent's channel account from its declared OpenClaw notification
workflows. Removing or disabling those workflows requires another Install to disable
that account. Other agents and operator-owned entries are preserved. With no declared
accounts, the channel is inactive; its schema remains registered for compatibility.

The channel reports setup or synchronization needs, unsupported workflows, scheduler
availability, execution/delivery failures, and the last successful scan. Three missed
scan intervals report overdue intake. Status reads manifest and retained state plus
native scheduler observations; it never resolves credentials or starts work. If native
inspection is unavailable it reports unknown. Missing optional capabilities report
degraded status while ready intake keeps running. Healthy status describes these observations,
not a fresh credential probe or a guarantee that the next dispatch will succeed.

Declare V2 authority explicitly and run Install to reconcile its owning schedule.
Old checkpoints and conversations do not establish V2 activation or completion.
Keep the prior package and configuration backup if an old conversation still needs
its V1 runtime; this package does not resume V1 work.
