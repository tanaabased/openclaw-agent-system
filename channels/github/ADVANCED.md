# GitHub Notification Reference

## Configuration Reference

`github.schema-version: 3` is required for V3 workflows; issue assignment is
declared directly under `github`. See the
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
Direct invocation of `agent-system-feedback-reply` can draft for a selected GitHub
comment/review or a response with an exact issue/PR destination in the current
OpenClaw chat, without enabling scheduled intake. It resolves the invoking agent's
applicable `agent.yaml` reply skill/guidance and voice. Drafting does not post;
publication requires an explicit request through native approval. Existing managed
work retains its owner and receipts; invalid context must recover or fail, not
silently become manual work. See the [reply skill](../../skills/feedback-reply/SKILL.md).

Direct and GitHub follow-ups receive retained plan revisions, private responses,
and partial work before interpreting the new message; that history supplies context,
not new authority.
No separate repair policy or author list is required.

For an explicitly requested issue progress update, use [GitHub Update](../../skills/github-update/SKILL.md). It compares public facts with verified progress in this chat, uses the configured shared reply composer, and returns the full private answer plus the exact confirmed public quote. Already-current issues get no comment; unfinished original publications recover first. This does not start implementation or change mode.

Discovery retains bounded observations independently of reply eligibility.
Feedback authors are the union of configured allowed actors and reviewers. Activity observed while no authors are
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

V3 rejects `enabled`; use `paused`. Review-request declarations reserve the same
pause field but still have no execution adapter.

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

For an explicit operator request, use `$agent-system-task-retirement`. In OpenClaw,
`agent_system_dispatch` action `retire` previews one exact owned task by `id` (or
its current verified issue session); repeat with the returned `digest` to apply.
Standalone Codex uses the [native dispatch entry](../../CODEX.md#github-notification-policy).
The request records operator intent and attempts the existing safe cleanup now,
skipping only scheduled eligibility, observation cadence and grace. It leaves the
issue open/assigned and branch unchanged. Running work, pins, shared ownership,
unpreserved changes and unfinished native cleanup remain pending. A task cannot
archive its own active turn. Repeat the same operation or let intake reconcile it;
only verified native-session and checkout outcomes complete retirement. Stale or
invalid managed context must recover through its owner, never generic cleanup.

Automatic cleanup uses one [installation-wide grace period](../../CONFIG.md#shared-cleanup),
defaulting to 60 minutes for both runtimes. There is no disable switch or per-agent
override. The deadline starts when intake first observes the change. Polling and restart preserve it; new native activity defers cleanup. Fresh,
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
without blocking other intake. Unresolved cleanup remains pending, never complete.
Historical retirement without native cleanup evidence is reported and preserved,
not swept automatically.
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

### `openclaw agent-system notifications reset`

Reset notification management for selected agents. The operator sees the scope,
confirms once, and the command pauses intake, waits for managed turns, clears
routing and feedback records, establishes a fresh assignment baseline, archives
the old intake chat, creates a fresh coordinator, and restores the previous intake setting. Existing assignments and comments do not
replay; a new approved assignment after the baseline can start new work.

**Options:**

| Option or argument        | Required | Default | Description                                                                                                        |
| ------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `--agent <id>`            | no       | none    | Repeat to preselect multiple agents.                                                                               |
| `--all`                   | no       | false   | Select all configured agents with managed manifests; conflicts with `--agent`.                                     |
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

# preselect two agents while retaining the selection and confirmation prompts
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

For assessment without assignment or intake activation, invoke
`agent-system-issue-assessment` in the current chat with an explicit GitHub issue URL
and an existing checkout root allowed by the agent's Git containment. It uses the
current [assessment selection](../../MANIFEST.md#assessment-selection), retains the
complete plan/questions/blocker, and stops without implementation or publication,
even with Work/Auto defaults. Matching managed work reuses its context and results;
invalid ownership needs recovery through its owner, not a manual retry. Correct a
missing checkout or invalid explicit skill/guidance and retry in the same chat.
A later answer can revise the saved direct assessment; ask for the full assessment
for source readback. This does not launch the full issue workflow.

For direct implementation in the current chat, invoke
`$agent-system-issue-implementation` with an explicitly authorized actionable plan,
issue URL and existing checkout, or reuse matching retained work. The collector
uses the same configured implementation context as managed execution; no new
assessment, chat or notification setup is required. Manual entry defaults to local
work; only an explicit PR request selects publication. Resume its returned handoff
and original receipts; invalid managed ownership never falls back to manual work.

An authenticated operator can continue a retained Plan-mode assessment in its
owning issue chat. An actionable Plan-mode issue needs human direction to enter implementation;
once there, ordinary PR delivery needs no separate publication grant. The agent retains the
complete plan and uses the existing chat and managed worktree. In either runtime, an
operator may change the model or reasoning effort through native controls without
recreating the task. Original routing stays recorded separately from current
session settings; continuation respects the operator's choice. This does not
authorize the agent to change settings, and initial creation still verifies the
requested configuration.

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
Public assessment summaries, approved comment/review replies and PR announcements retain their drafts and attempted writes across interruptions. Continue in the same issue chat to finish only the missing response. An unconfirmed post is checked by its original marker and exact content, never blindly reposted. Missing access, changed sources, edited posts and native denials remain visible obstacles; the complete private result stays available. Pending assessment summaries can receive a response-only native continuation after the owner is idle. A denied summary instead retains its publication hold and diagnostic without automatic retry or another publication route; supported verified recovery or renewed authorization is required. Independently authorized implementation can still enter fresh native context in the same permitted turn. Cancellation, lost authority and broader or implementation-specific denials remain stops. Implementation context reports the summary hold separately without moving work back to planning.

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
reply-staging tool, and task-PR tool have been removed. Independent review requests remain unavailable. Assessment skills and optional inline/file
guidance use the shared [assessment selection](../../MANIFEST.md#assessment-selection) contract.
Retirement does not imply feature parity.

The channel id `agent-system-github` remains registered as a read-only readiness
surface. Existing accounts and bindings remain valid; the deprecated plugin
`githubNotifications` limits are accepted but unused. Legacy configuration never
activates workflow intake. Install adopts an old account only when its matching
Agent System-managed binding establishes ownership; conflicting accounts require
operator resolution. Historical receipts and grants remain untouched.

On OpenClaw 2026.10.6, plain channel status reports saved account configuration.
Use `openclaw gateway call channels.status --params '{"probe":true}' --json` for
the full readiness snapshot described below.

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

Declare V3 workflow authority explicitly and run Install to reconcile its owning schedule.
Old checkpoints and conversations do not establish workflow activation or completion.
Keep the prior package and configuration backup if an old conversation still needs
its V1 runtime; this package does not resume V1 work.

## Installation identity and assignment claims

Install creates or preserves a UUID and readable name for each OpenClaw or standalone
Codex installation. Doctor inspects that identity without changing it. Use the
[OpenClaw instance commands](../../CLI.md#openclaw-agent-system-instance-inspect) or
[Codex identity actions](../../CODEX.md#workspace-setup) to inspect, rename, or explicitly
rotate it. Rotation does not transfer existing work.

Assignment claim election is disabled internally in both runtimes. There is no
configuration switch to enable it, and installation identity alone does not prevent
two installations from starting the same assignment. Existing verified native work
keeps its retained custody. An assignment with a saved pilot claim is held before
new native work is prepared; preserve its receipts and inspect the original owner
before resolving it. The claim engine remains internal groundwork for a later
dispatcher integration.

## Manual Issue Launch

[Issue Dispatch](../../tools/dispatch/README.md#manual-issue-launch) starts the same managed
issue workflow by explicit operator request, without assignment or schedule activation.
The [installed launch scenario](../../examples/openclaw-issue-launch/README.md) owns its
OpenClaw CI journey; scheduled intake and direct assessment remain separate surfaces.
