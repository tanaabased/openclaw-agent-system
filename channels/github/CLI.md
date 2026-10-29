# GitHub Notification CLI

OpenClaw operator commands for inspecting and controlling the installed GitHub
workflow. Start with [setup](./README.md); standalone Codex uses its
[native app workflow](../../CODEX.md#additional-usage).

- [`openclaw agent-system notifications refresh`](#openclaw-agent-system-notifications-refresh) — Request intake or scan one issue.
- [`openclaw agent-system notifications reset`](#openclaw-agent-system-notifications-reset) — Reset tracking, optionally purging managed resources.
- [`openclaw agent-system notifications status`](#openclaw-agent-system-notifications-status) — Inspect retained workflow state.
- [`openclaw agent-system notifications wait`](#openclaw-agent-system-notifications-wait) — Wait for a workflow checkpoint.

Invalid options return exit code `2`; failed, degraded, timed-out, or incomplete
operations return nonzero.

`openclaw as` aliases `openclaw agent-system`. Bare `notifications` prints help.

## `openclaw agent-system notifications refresh`

Request the installed intake automation, or scan one selected issue.

### Options

| Option or argument             | Required             | Default             | Description                                                                  |
| ------------------------------ | -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `--agent <id>`                 | no                   | workspace discovery | Use the exact configured workspace for an installed agent.                   |
| `--json`                       | no                   | off                 | Write one undecorated structured result to stdout.                           |
| `--kind <issue\|pull-request>` | with other selectors | none                | Select the item kind; provide `--repository` and `--number` together.        |
| `--number <number>`            | with other selectors | none                | Select a positive item number; provide `--repository` and `--kind` together. |
| `--repository <owner/name>`    | with other selectors | none                | Select a repository; provide `--kind` and `--number` together.               |
| `--timeout <seconds>`          | no                   | `300`               | Integer from `1` through `2147483` bounding the complete refresh cycle.      |

### Usage

```text
openclaw agent-system notifications refresh [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--timeout <seconds>] [--json]
```

```sh
# request the installed native workflow now.
openclaw agent-system notifications refresh
```

Without selectors, refresh returns `queued` and a native run ID. This confirms the
request, not scan or assessment completion. Disabled or stale workflows fail without
being enabled; an uncertain enqueue is reported rather than retried.

With all three selectors and `--kind issue`, refresh scans only that issue and
returns `completed` after checking whether the assignment qualifies. It does not start
work or change
the recurring schedule or account-wide checkpoint. Pull-request selectors are
unsupported. Use [`status`](#openclaw-agent-system-notifications-status) to inspect results.

## `openclaw agent-system notifications reset`

Reset tracking and replace the intake chat for selected agents. The command pauses
intake, waits for managed turns, establishes a new assignment baseline, and restores
the prior intake setting. Existing assignments and comments do not replay.
Without explicit targets, select agents interactively; confirmation follows selection.

### Options

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

### Usage

```text
openclaw agent-system notifications reset [--agent <id> ... | --all] [--purge] [--fresh] [--preview] [--confirmation <digest>] [--yes] [--json]
```

```sh
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

Ordinary reset preserves issue chats and checkouts. `--purge` also archives managed
issue chats and removes owned checkouts, including modified, untracked, and ignored
files. Both leave GitHub content, repositories, named and remote branches, and
protected or shared resources intact. Unverified ownership or activity leaves resources
in place and reports incomplete cleanup or warnings; inspect those results.

Interrupted resets resume. `--fresh` restarts checks while retaining cleanup targets,
completed actions, and uncertain outcomes. Keep the same `--purge` setting until
completion, and do not delete recovery records to force a reset. If automatic pause
fails, pause intake in the scheduler; reset waits for managed turns and never aborts
them. A failure for one selected agent does not undo resets completed for others.

For a missing intake chat that does not need a tracking reset, run Doctor and Install.
Install replaces the coordinator while preserving issue records. The
[Notifications Reset skill](../../skills/notifications-reset/SKILL.md) guides operators
through reset; OpenClaw-hosted agents hand off the terminal command.

## `openclaw agent-system notifications status`

Inspect saved notification state without starting work.

### Options

| Option or argument             | Required             | Default             | Description                                                                  |
| ------------------------------ | -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `--agent <id>`                 | no                   | workspace discovery | Use the exact configured workspace for an installed agent.                   |
| `--json`                       | no                   | off                 | Write one undecorated structured result to stdout.                           |
| `--kind <issue\|pull-request>` | with other selectors | none                | Select the item kind; provide `--repository` and `--number` together.        |
| `--number <number>`            | with other selectors | none                | Select a positive item number; provide `--repository` and `--kind` together. |
| `--repository <owner/name>`    | with other selectors | none                | Select a repository; provide `--kind` and `--number` together.               |

### Usage

```text
openclaw agent-system notifications status [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] [--json]
```

```sh
# inspect redacted state for the workspace agent.
openclaw agent-system notifications status --json
```

`status` reports baseline, capacity, preparation, and blockers without advancing work.
The optional `workflow` identifies the phase and chat; `workflowStatus` distinguishes
`retirement-pending`, `retired`, `obsolete`, and `partially-delivered` work. Partial
delivery means the PR exists but still needs linkage or presentation. Only issue
selectors are supported.

`waiting` means setup or evidence is needed, `retrying` indicates a transient failure,
and `blocked` indicates denial, cancellation, or lost authority. Follow the reported
diagnostic. An incomplete check does not prove a successful scan or absence of work.
Use Doctor for missing or disabled schedules and Install to reconcile drift. Resume
interrupted work in its [existing chat](./README.md#chatting), rather than resetting
tracking to force a retry.

Doctor, notification status, and intake reports show journal content size, thresholds,
bytes reclaimed by the last offload, and reasons records remain protected. Both runtimes
warn at 16 MiB and pause new scheduled or manual tasks at 32 MiB. Intake reports notify
on pressure transitions or substantial growth, not every scan. Existing tasks can
continue within the 64 MiB content ceiling, with 1 MiB of additional reporting space.
These limits are fixed; raising them is not a supported recovery setting.

Normal dispatch reconciliation offloads verified retired detail, including failed tasks
and stale historical turns, before new work. Retry context and the complete assessment
in the same chat after reconciliation. Admission resumes below 32 MiB with room for the
proposed task. Oversized saves preserve the committed journal; active work may still
exhaust the finite emergency budget. Do not delete state or mark work successful to
free space. Cold detail expires after 30 days or eviction from its 64 MiB budget;
compact terminal identity and effect receipts remain and never restore authority.

For an OpenClaw readiness probe, use:

```sh
# inspect channel health without starting work.
openclaw gateway call channels.status --params '{"probe":true}' --json
```

The probe reports setup, scheduler synchronization, recent failures, and the last
successful scan. Three missed intervals report overdue intake; unavailable inspection
reports unknown. It does not start work.

## `openclaw agent-system notifications wait`

Wait for a retained workflow checkpoint.

### Options

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

### Usage

```text
openclaw agent-system notifications wait [--agent <id>] [--repository <owner/name> --kind <issue|pull-request> --number <number>] --for <target> [--refresh] [--timeout <seconds>] [--json]
```

```sh
# scan and wait for the coordinator to prepare one issue worktree.
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
| `plan-ready`     | yes               | The retained assessment is ready              |
| `prepared`       | yes               | The conversation and worktree are verified    |
| `worktree-ready` | yes               | The selected issue worktree is ready          |

Only the listed targets are supported; rejection and retirement are not wait targets.
Without `--refresh`, wait observes state without advancing intake.

With `--refresh` and an issue selector, wait scans that issue but does not dispatch
work; the native coordinator must make progress. Without a selector, it requests the
ordinary automation and waits for that run before requesting another cycle.

Terminal diagnostics fail immediately; timeout or an incomplete wait returns nonzero.
