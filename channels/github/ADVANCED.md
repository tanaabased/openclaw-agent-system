# GitHub Notification Reference

## Configuration Reference

GitHub notifications require `github.notifications.schema-version: 2`. See the
[manifest reference](../../MANIFEST.md#githubnotifications) for fields, defaults,
authority, runtime selection, and current support. OpenClaw currently supports
Plan-mode issue assignment with the default assessment skill and configured feedback
on retained issues and their linked delivery PRs. Independent review requests warn
without blocking those workflows.
Standalone Codex uses its [native workflow controls](../../CODEX.md#github-notification-policy).

Both runtimes save bounded discovery progress and resume on later polls. Ordinary
comments are fetched by update time; unchanged history does not trigger feedback.
OpenClaw keeps discovery inside one condition budget and wakes the coordinator for
saved actionable work or a one-time progress/recovery card. After upgrading, run
Install to reconcile the changed condition before relying on scheduled intake.

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
already installed native OpenClaw issue-planning automation. A successful request
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
`workflowStatus`: `obsolete` identifies retired or superseded intent, and
`partially-delivered` preserves a published PR while linkage, attachment, or its
announcement remains incomplete. These descriptions do not release capacity or grant
authority. Diagnostics identify the affected operation and issue, retaining successful
starts alongside failures. Provider errors keep their bounded structured evidence;
unclassified failures do not establish a credential problem.

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
assessment result. Native OpenClaw notifications do not retain rejected assignments
or support assignment retirement. `assignment-rejected` and `retired` return
`github-notification-wait-target-unsupported` immediately without requesting a refresh.
With `--refresh` and an issue selector, each intake refresh is limited to that
issue. These one-off scans do not run dispatch; waits observe progress made by the
native coordinator. Without a selector, refresh requests the ordinary automation
and waits for its exact native run before requesting another cycle. Without
`--refresh`, selectors restrict observation only.

Terminal diagnostics fail immediately. A timed-out or otherwise incomplete wait
returns nonzero.

## Operator-Requested PR Delivery

An authenticated operator can continue a retained Plan-mode assessment in its
owning issue chat. Request implementation, PR publication, or both explicitly;
assignment and a completed plan alone authorize neither. The agent retains the
complete plan and uses the existing chat, managed worktree, and model selection.

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
branch from its last verified push. The PR receipt and original announcement stay
with the delivery. Explicit title/body changes update that PR; commit-only pushes
preserve text edited on GitHub. Interrupted updates reconcile the same operation.
If initial PR creation is still uncertain, reconcile it before changing its text.

If showing an already-created PR is interrupted or temporarily busy, ask the same
issue chat to show its card again. Presentation reuses the saved PR; it does not
push or create another one, or post an announcement. If announcing fails, the PR
remains delivered. Ask the same chat to recover its announcement; uncertain writes
reconcile the saved text and receipt without posting a duplicate.

## V1 Retirement

Unversioned notification declarations are rejected with
`github-notification-v1-retired`. The polling channel, its Work/guided engine,
reply-staging tool, and task-PR tool have been removed. Native OpenClaw Work/Auto,
independent review requests and custom assessment skills remain unavailable.
Retirement does not imply feature parity.

The channel id `agent-system-github` remains registered as a read-only readiness
surface. Existing accounts and bindings remain valid; the deprecated plugin
`githubNotifications` limits are accepted but unused. Legacy configuration never
activates V2 intake. Install adopts an old account only when its matching
Agent System-managed binding establishes ownership; conflicting accounts require
operator resolution. Historical receipts and grants remain untouched.

Install manages each agent's channel account from its enabled OpenClaw notification
workflows. Removing or disabling those workflows requires another Install to disable
that account. Other agents and operator-owned entries are preserved. With no enabled
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
