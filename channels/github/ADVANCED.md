# GitHub Notification Reference

## Configuration Reference

GitHub notifications require `github.notifications.schema-version: 2`. See the
[manifest reference](../../MANIFEST.md#githubnotifications) for fields, defaults,
authority, runtime selection, and current support. OpenClaw currently supports
Plan-mode issue assignment with the default assessment skill. Unavailable feedback
and reviews warn without blocking that workflow.
Standalone Codex uses its [native workflow controls](../../CODEX.md#github-notification-policy).

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
Native refresh is agent-wide: item selectors return an unsupported diagnostic;
use scoped `status` or `wait` to observe one issue. An uncertain admission returns
a diagnostic rather than automatically submitting another run.

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
With `--refresh`, V2 requests the owning agent-wide workflow and observes its exact
native run receipt. It requests another cycle only after that run completes;
pending or uncertain execution never causes a blind resubmission. A scoped wait
still observes only the selected issue.

Terminal diagnostics fail immediately. A timed-out or otherwise incomplete wait
returns nonzero.

## V1 Retirement

Unversioned notification declarations are rejected with
`github-notification-v1-retired`. The polling channel, its Work/guided engine,
reply-staging tool, and task-PR tool have been removed. Native OpenClaw Work/Auto,
feedback, review requests, and custom assessment skills remain unavailable.
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
