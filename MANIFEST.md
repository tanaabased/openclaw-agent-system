# Manifest Reference

Configure an agent workspace through `agent.yaml`. Start with the
[README](./README.md#usage) for the common workflow; use [Global Configuration](./CONFIG.md)
for operator-owned OpenClaw settings and [CLI Reference](./CLI.md) to apply or inspect declarations.

- [Discovery](#discovery)
- [Configuration](#configuration)
  - [Components](#components)
  - [`agent`](#agent)
  - [`automations`](#automations)
  - [`backup`](#backup)
  - [`debug`](#debug)
  - [`environment`](#environment)
  - [`memory`](#memory)
  - [`models`](#models)
  - [`schema-version`](#schema-version)
  - [Setup](#setup)
- [Skill and guidance values](#skill-and-guidance-values)
- [Environment resolution](#environment-resolution)
- [Path projection](#path)
- [Machine-local overrides](#machine-local-overrides)

## Discovery

Agent System discovers one manifest from an agent workspace:

```text
.agent-system/agent.yaml   # preferred
agent.yaml                 # shorthand
```

If both base files exist, Agent System uses the preferred file without merging them.
Loading a manifest checks its structure without resolving environment values or changing state.
The strict loader rejects unknown or incorrectly cased keys, unsafe symlinks, files
larger than 1 MiB, invalid UTF-8, duplicate keys, and unsupported YAML features such as
anchors, aliases, and explicit tags.

A minimal manifest binds one workspace to one agent:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot

environment:
  set:
    NODE_ENV: development
```

## Configuration

`install` applies declared state to owned OpenClaw settings; credentials remain
outside `openclaw.json`. Standalone Codex applies only its supported settings through
the [Codex setup flow](./CODEX.md#workspace-setup).

<a id="component-configuration"></a>

<a id="githubnotifications"></a>
<a id="version-3-fields"></a>
<a id="pull-request-recipients"></a>
<a id="issue-modes"></a>
<a id="feedback-permissions"></a>
<a id="assessment-selection"></a>
<a id="implementation-and-review-selection"></a>
<a id="issue-only-profile-example"></a>
<a id="activation"></a>
<a id="github-workflows"></a>
<a id="github"></a>

### Components

Use these guides for component-specific configuration and operation. Shared manifest
fields are documented below; a tool without its own key does not need another section
in `agent.yaml`.

| Component         | Manifest configuration                                 | Guide                                                                               |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Assignment Intake | `github` workflow fields                               | [Intake](./tools/intake/README.md#configuration)                                    |
| Doctor            | Shared manifest; no separate key                       | [Doctor](./tools/doctor/README.md#configuration)                                    |
| Git               | `git`                                                  | [Git configuration](./tools/git/README.md#configuration-reference)                  |
| Git worktrees     | `git.worktrees`                                        | [Worktree configuration](./tools/git/worktree/README.md#gitworktrees)               |
| GitHub CLI        | `github` account, credential, and policy fields        | [GitHub CLI configuration](./tools/github/README.md#configuration-reference)        |
| GitHub workflows  | `github` with `github.schema-version: 3`               | [Setup](./channels/github/README.md) · [Configuration](./channels/github/CONFIG.md) |
| Google            | `google`                                               | [Google configuration](./tools/google/README.md#configuration)                      |
| Install           | Shared manifest; no separate key                       | [Install](./tools/install/README.md#configuration)                                  |
| Issue Dispatch    | `github` workflow fields and `models`; no separate key | [Dispatch](./tools/dispatch/README.md#configuration)                                |
| Model Routing     | `models` and `models.routing`                          | [Model routing](./tools/model-routing/README.md#configuration)                      |

<a id="core-configuration-example"></a>

See the [README example](./README.md#usage) for a complete manifest.

### `agent`

| Field         | Type                               | Required      | Default                  | Behavior                                                         |
| ------------- | ---------------------------------- | ------------- | ------------------------ | ---------------------------------------------------------------- |
| `avatar`      | string                             | no            | installed value retained | Applied by `install`; an undeclared OpenClaw avatar is retained. |
| `description` | string                             | no            | none                     | Agent description retained for configured consumers.             |
| `email`       | string or `from-environment` value | no            | none                     | Agent email available to configured consumers.                   |
| `emoji`       | string                             | no            | installed value retained | Applied by `install`; an undeclared OpenClaw emoji is retained.  |
| `id`          | string                             | yes           | none                     | Literal lowercase id matching `^[a-z0-9][a-z0-9-]*$`.            |
| `name`        | string or `from-environment` value | for `install` | none                     | Agent display name applied to OpenClaw by `install`.             |
| `runtime`     | `codex`                            | no            | none                     | Selects the Codex prerequisite and declared model runtime.       |

`name` and `email` accept a literal or an explicit reference to the completed
Agent System environment:

```yaml
agent:
  name:
    from-environment: AGENT_NAME
```

A missing or empty referenced value fails the action that consumes it. A
dollar-prefixed scalar in these fields remains literal.

Identity fields do not configure tools by themselves; a tool may explicitly use
them as defaults.

Set `agent.runtime: codex` to select the shared Codex prerequisite. With `models`
declared, `install` also creates agent-scoped Codex bindings for those profiles
without an existing route or workspace routing patch. Without `models`, existing
model bindings remain untouched. The declaration does not pin a plugin version.
Existing agent-specific or inherited `agentRuntime` bindings also select the
prerequisite. An `openai/*` model name alone does not.

### `automations`

Declare an inline list or `{ file: ./automations.yaml }`; omission and `[]` declare
no jobs. OpenClaw operator Install reconciles jobs through the running Gateway.
Standalone Codex Install plans recurring prompt jobs and applies authorized native
actions. Doctor inspects without running or changing jobs. See the
[Codex support matrix](#codex-execution-and-ownership) for supported schedules and targets.
Operator [list](./CLI.md#openclaw-agent-system-automations-list),
[sync](./CLI.md#openclaw-agent-system-automations-sync),
[run](./CLI.md#openclaw-agent-system-automations-run), and
[history](./CLI.md#openclaw-agent-system-automations-runs) use these same declarations.

| Field             | Type                                                                                      | Required         | Default                                            | Description                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `display-name`    | nonblank single-line string, up to 200 UTF-16 code units                                  | no               | runtime-owned                                      | Automation label; independent of the persistent conversation name.             |
| `effort`          | `none`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `adaptive`, `max`, or `ultra` | no               | selected profile effort, otherwise native          | Conversation effort; the selected runtime/model must support it.               |
| `enabled`         | boolean                                                                                   | no               | `true`                                             | Desired enabled state.                                                         |
| `group`           | nonblank string                                                                           | no               | `AGENT SYSTEM` for persistent chats                | Sidebar destination; normalized to uppercase.                                  |
| `id`              | lowercase kebab-case string                                                               | yes              | none                                               | Stable unique ID within the workspace.                                         |
| `model`           | provider-qualified model or `default`, `low`, `medium`, `high`                            | no               | `models.default` when configured, otherwise native | Prompt or command-report conversation model.                                   |
| `overrides`       | runtime mapping                                                                           | no               | none                                               | Runtime conversation settings below.                                           |
| `payload`         | command or prompt object                                                                  | one payload form | none                                               | `{ kind: command, run: ..., shell?: ... }` or `{ kind: prompt, prompt: ... }`. |
| `prompt`          | nonblank string or `{ file: relative-path }`                                              | one payload form | none                                               | Inline text or UTF-8 prompt file.                                              |
| `run`             | nonblank shell string, argv array, or `{ command, args? }`                                | one payload form | none                                               | Command; argv stays literal and ordered.                                       |
| `runtimes`        | unique list of `openclaw` / `codex`                                                       | no               | both                                               | Runtime applicability.                                                         |
| `schedule`        | string or object                                                                          | yes              | none                                               | Schedule forms below.                                                          |
| `shell`           | `sh`, `bash`, or `zsh`                                                                    | no               | `sh`                                               | Shell strings only; place inside `payload` for long-form commands.             |
| `thread`          | null, nonblank string, or `{ id?: string, name?: string }`                                | no               | independent                                        | Persistent conversation; enables OpenClaw command reports.                     |
| `timeout-seconds` | integer, 1–3600                                                                           | no               | runtime-owned                                      | Job-level only. OpenClaw projection: 1800 seconds; Codex: native default.      |

Use exactly one of `run`, `prompt`, or `payload`. Commands reuse
[setup command syntax](#syntax), without setup checks, steps, or timeout defaults.

Set `display-name` to give the automation a readable label, including emoji. Outer
whitespace is trimmed; NUL and line breaks are rejected. Codex uses the label as its
native automation `name`; OpenClaw uses native `displayName`, retaining its stable
job `name`. Without a label, Codex uses `<agent-id>: <automation-id>` and OpenClaw
uses `<UPPERCASE-AGENT-ID>: <automation-id>` (`AGENT SYSTEM` for built-in jobs).
Changing or removing the label through normal synchronization updates the existing
job or restores that default; it does not
replace the job, change its schedule, or rename its chat.

```yaml
automations:
  - id: nightly-refresh
    display-name: '🔄 NIGHTLY REFRESH'
    schedule: every 24 hours
    prompt: Refresh the workspace summary.
    thread: { name: NIGHTLY REFRESH }
```

Model selection is shared by both runtimes. A named [model profile](#models) supplies
model and effort; a missing requested profile is an error. An explicit model inherits
`models.default.effort` when available. An explicit automation effort replaces the
inherited effort. Finally, runtime overrides replace model and effort independently.
Codex shared models must use the `openai/` provider; Codex runtime overrides may still
use unqualified native model IDs.

Install applies these settings to new and existing managed chats and verifies saved
readback. The same resolved pair feeds independent jobs and schedule drift detection.
Jobs sharing an OpenClaw chat must agree on settings. Explicit runtime targets are
not owned chats: they keep their native settings and do not inherit `models.default`.
Explicit automation or runtime model/effort settings are rejected for those targets.
Command jobs accept model and effort only with a persistent reporting chat. These
settings configure later conversation, never command execution or report delivery.

> [!IMPORTANT]
> Workspaces declaring `models` now use `models.default` for prompt automations that
> omit `model`, except unowned runtime targets. Review this before Install: it can change cost or availability.
> Without shared or runtime settings and without `models`, native inheritance remains.
> Removing a desired field stops managing it; it does not reset the chat's saved native setting.

Each `overrides.openclaw` or `overrides.codex` object accepts only:

| Field    | Type                                              | Required | Default                                |
| -------- | ------------------------------------------------- | -------- | -------------------------------------- |
| `effort` | nonblank string                                   | no       | adapter-resolved                       |
| `model`  | nonblank string                                   | no       | adapter-resolved                       |
| `target` | `independent` or `{ thread: existing-native-id }` | no       | shared `thread`, otherwise independent |

```yaml
# .agent-system/agent.yaml
automations:
  file: ./automations.yaml
```

```yaml
# .agent-system/automations.yaml
- id: review
  schedule: every 1 hour
  prompt:
    file: ../prompts/review.md
- id: github-check
  runtimes: [openclaw]
  schedule: '0 9 * * 1-5'
  run: [gh, api, user, --jq, .login]
```

File references resolve relative to the file that contains them. Commands still run from
the workspace root. References stay within the workspace and follow the
[loader's size and encoding rules](#discovery). External YAML contains a list, without
recursive inclusion. Missing or invalid references fail validation rather than declaring
no jobs.

#### Persistent conversations

Set `group: operations` to place a persistent automation chat under `OPERATIONS` in either
runtime. Omission uses `AGENT SYSTEM`, including built-in coordinator chats. Group changes
move the same chat while preserving its title, history, schedule, permissions and project
membership. Effective independent targets cannot declare `group`.

Group names are trimmed and uppercased without changing chat titles or `display-name`.
Blank names and control characters are rejected. OpenClaw permits at most 512 Unicode
code points after normalization; Codex applies its native sidebar name validation.
Exact uppercase destinations are reused; differently cased groups stay untouched.
Ambiguous exact destinations or uncertain native creation block reconciliation until their
identity can be verified. Doctor reports drift without moving chats; Install applies it.

Omit `thread` or use `null` for independent prompt runs or commands without chat reports. A string or `{ name: "Activity" }`
keeps one named conversation per automation. Matching names never combine jobs.

```yaml
automations:
  - id: check-builds
    schedule: every 1 hour
    prompt: Review failed builds.
    thread: { id: project-activity, name: Project activity }
  - id: review-prs
    schedule: every 2 hours
    prompt: Review open pull requests.
    thread: { id: project-activity, name: Project activity }
```

| Runtime  | Result for these two jobs                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw | Two native schedules in one persistent conversation, with shared history.                                                                       |
| Codex    | Two native schedules in two persistent conversations, each retaining its own history. Codex permits only one active heartbeat per conversation. |

Saved conversation bindings are specific to the runtime profile, workspace, and agent. OpenClaw
shares an explicit `thread.id`; Codex also scopes it by automation ID. Names and
YAML order do not determine identity. Removing and reintroducing a job preserves
its conversation binding.

An explicit ID first reuses its saved binding, otherwise adopts an exact available
native conversation in the same workspace, otherwise creates one. Unknown IDs create new managed conversations.

> [!IMPORTANT]
> Check an explicit conversation ID before installing. Even a typo can create a new
> conversation instead of selecting the one you intended.

OpenClaw resolves native IDs to persistent session keys, not interchangeable transcript IDs.
Permission or lookup failures never count as absence. Missing or archived saved
conversations require recovery; synchronization will not silently replace them.

An explicit name sets the title; omission preserves it. Conflicting names for one
conversation are rejected. OpenClaw automatic titles need not be unique, but existing
explicitly titled chats retain native label-uniqueness rules. Automation names are separate.

An explicit runtime `target` overrides shared `thread` selection for that
runtime; `group` still controls placement. `independent` stays independent; `{ thread: existing-native-id }` requires
an exact existing target and never creates a replacement. Multiple active Codex jobs
explicitly targeting the same native conversation fail with a conflict.

Agent System records the creation attempt before asking the runtime to create a
conversation. OpenClaw can recover an interrupted attempt using its saved session key.
Codex saves the returned ID before completing setup. If that response is lost, creation
remains uncertain and another attempt is blocked. Keep the journal and resolve the
native identity before retrying.

OpenClaw changes routing on its existing native job. Codex changes between independent
and persistent routing by first pausing and retaining the old native schedule, then
creating its replacement. Old schedule history and conversation bindings remain.

For OpenClaw commands, choose a persistent destination once; reports from successive
runs go to that same chat. Multiple commands and prompts can share an explicit
`thread.id` when their names, groups, and resolved model/effort agree.

```yaml
automations:
  - id: update-agent
    runtimes: [openclaw]
    schedule: every 24 hours
    run: [sh, ./scripts/update-agent.sh]
    group: REPORTS
    thread: { id: updates, name: UPDATES }
  - id: backup-agent
    runtimes: [openclaw]
    schedule: every 24 hours
    run: [sh, ./scripts/backup-agent.sh]
    group: REPORTS
    thread: { id: backups, name: BACKUPS }
```

Install creates or reuses the chat and enrolls the existing shared session client
when needed, disclosing its `operator.read` and `operator.write` grants. Scripts
need no chat IDs, reporting helpers, credentials, or custom output envelope.
Each report identifies the job, wrapper execution ID, start time, and actual result.
Stdout is Markdown; stderr is fenced diagnostic text. Empty stdout still produces
a completion report. Each stream is sanitized and limited to a 16 KiB chat excerpt;
permitted native run output remains available separately. Appending invokes no model
and starts no agent turn. Later prompt turns can read the accumulated history.
OpenClaw-hosted Codex uses this path; standalone Codex command jobs remain unsupported.

#### OpenClaw execution and ownership

The operator needs a running Gateway and native cron read/administration permissions.
[Install](./CLI.md#openclaw-agent-system-install) may defer unavailable initial scheduler
discovery without changing jobs; explicit sync and incompatible RPCs still fail.
Run scheduler synchronization from the operator CLI. Install and Doctor in an agent
chat report when this step is needed; they do not acquire operator permissions.

Command jobs run without a model. Before starting, Agent System verifies the workspace,
job ownership, enabled state, and that the saved job matches its declaration. It then
grants temporary authority for that run. Plain `git` and `gh` use the agent's managed
launchers, which check tool policy before loading credentials. Other executables run
as host commands under the same [containment limits](./CLI.md#trust-boundary) as setup.
Rerun Install after changing a command declaration.

Activating an owned automation authorizes same-agent Install and Doctor calls for
that run. Command jobs use `openclaw agent-system install` and `doctor` (or `status`);
prompt jobs use native lifecycle tools. The job cannot select another agent or
workspace, and later interactive turns retain their normal approval requirements.
Provider permissions, enrollment, and prerequisites still apply; native prompt tools
cannot synchronize schedules. Standalone Codex retains its
[native approval boundary](#codex-execution-and-ownership).

Prompt jobs normally start a separate session for the configured agent. They use its
resolved shared model and effort, then runtime overrides; absent settings inherit
native defaults. Persistent jobs reuse their verified session and conversation history.
Results stay in native run history; commands with a reporting chat also append there.
Command runs retain
bounded stdout and stderr, even without delivery. Authorized Gateway operators can
inspect output and truncation in run details; setup output stays private. Agent System
inherits OpenClaw capture defaults and forwards captured output without another cap.
Install and automation sync update existing managed command jobs with an explicit
`outputMaxBytes` to 16 MiB per stream; new jobs inherit OpenClaw defaults.

Command timeouts range from 1 to 3600 seconds (default 1800). Reporting commands
reserve an additional 35 seconds in the native deadline for process termination and
a separate 30-second delivery attempt. Delivery does not change the command result
and is not automatically retried; inspect native run details if a report is missing.
For jobs without reporting, the native timeout also includes wrapper startup. OpenClaw
controls overlapping runs of the same job, retries, recovery, and daylight saving time;
Agent System does not add another retry loop. Completion, cancellation, and timeout
revoke temporary authority and release managed resources. A forced process termination
can prevent immediate filesystem cleanup.

Agent System saves job ownership outside the repository, scoped to the OpenClaw
profile, workspace, agent ID, and manifest ID. Install leaves unchanged jobs alone.
Removing a declaration disables the job but keeps its mapping and history; restoring
the same ID reuses the job while it exists.

Once both the declaration and native job are gone, synchronization retires ownership
after complete operator inspection with no unresolved writes. Doctor treats the saved
retirement record as history. Reusing a retired ID requires explicit recovery; use a
new ID for a new automation.

Relative one-shot anchors survive payload edits, pause/resume, and removal. A completed
one-shot runs again only if you change its manifest trigger. A job disabled by native
safety controls requires operator recovery.

If you edit managed settings in the native UI, Doctor reports drift. Install restores
the declaration after checking for concurrent edits. A missing declared job, missing
ownership record, uncertain recovery, or concurrent change stops the update and reports
what completed. A matching name alone is not enough to adopt or recreate a job.
Doctor reports execution and delivery failures separately without running the job again;
missing run data does not prove delivery.

#### Codex execution and ownership

Use `$agent-system-install` in the Codex desktop app to apply repository automations;
Doctor compares desired and saved settings without running jobs. A compatible `codex`
executable must be on `PATH`. Headless Install returns `requires-native-app-sync` when
app actions remain. Codex uses host credentials and permissions, not OpenClaw credentials.

Codex supports this subset of the shared declarations:

| Manifest field                                    | Codex behavior                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overrides.codex.effort`, `overrides.codex.model` | Override shared model and effort independently. Remaining omissions on independent jobs inherit the ambient Codex home's top-level configuration. Native model catalog support is checked for managed chats.                                                                                                |
| `overrides.codex.target`                          | Defaults to an independent job in the one saved local project matching the bound workspace. `{ thread: existing-id }` selects an existing local chat there; model and effort overrides are rejected for these explicit chat targets.                                                                        |
| `prompt`, `payload`                               | Recurring prompts, including prompts asking a model to run a script.                                                                                                                                                                                                                                        |
| `run`                                             | Zero-model commands are unsupported, including `payload.kind: command`.                                                                                                                                                                                                                                     |
| `schedule`                                        | Whole-minute intervals from 1 to 1440 or whole-hour intervals from 1 to 999. Cron supports one minute every hour, or one daily time with daily, weekday, or month-day selection across all months. Multiple-job expressions and unsupported day-field combinations are rejected; one-shots are unsupported. |
| `schedule.timezone`                               | Omit or use `null` for native local time. Named IANA zones map directly to native `DTSTART;TZID=…` recurrence rules; UTC uses a UTC start. Available for every supported cron shape, including hourly. `native` is not accepted.                                                                            |
| `thread`                                          | Creates a persistent conversation per automation. Resolved model and effort apply at creation and through later Install updates, preserving the chat and its permissions.                                                                                                                                   |
| `timeout-seconds`                                 | Unsupported. Native timeout, concurrency, retry, and catch-up rules apply.                                                                                                                                                                                                                                  |

Independent jobs require one saved local project matching the bound workspace;
worktree bindings do not select its parent checkout. Explicit chat targets must be
available in that project and are never replaced or rebound to the installer's chat.

New automation chats use native `auto_review`, `workspace-write`, and `on-request`
approvals. Install verifies saved permissions; existing ready chats keep theirs.
Native review may still deny an action. Install does not add global approval rules.

Install opens a native review card only when creating a new timezone-qualified
schedule. Review and save the card to preserve the requested timezone; Install waits
for verified saved settings before proceeding. Other creates and all updates, including
timezone changes, use direct writes. Codex controls timezones, daylight saving time,
and missed runs.

> [!WARNING]
> In Codex desktop version 26.1021.22027 (21747), named-zone scheduling can use the
> scheduler host's timezone and run at the wrong wall-clock time. Agent System saves
> the requested zone without compensating for this defect. Verify an actual run;
> saving the zone does not prove correct timing.

Verify a real scheduled run to check execution. The adapter can inspect saved settings
but does not expose run-now controls, run history, or execution and delivery results.
A separately requested manual task does not verify the schedule.

Agent System tracks owned jobs privately. Native edits to managed fields are drift;
notification preferences remain native-owned. Install leaves unchanged jobs alone.
Removed declarations pause jobs and retain history; reintroduced IDs reuse them.
Unrelated jobs are not adopted by name. Unknown saved schemas stop inspection.

For `automation-thread-model-drift`, rerun Install to reconcile the existing managed
chat. Doctor reports requested and observed values without applying changes. Codex
settings updates require CLI `0.160.1` or newer and its experimental settings API;
unsupported native operations remain explicit errors. Settings-only updates never
create a replacement chat or generate a model turn.

`automation-thread-settings-busy` means Codex still owns the chat's writer, which can
include an idle desktop-loaded chat. Release that chat in the native app and rerun
Install. Agent System does not interrupt it or schedule an automatic idle retry.
In either runtime, `automation-thread-settings-denied` or
`automation-thread-settings-uncertain` retains the attempt without replay. Inspect
native settings and, if needed, apply the retained request shown by Doctor through
supported native controls. Matching saved values clear the receipt on a later Install. Correcting
authorization alone does not replay a denied attempt; do not delete ownership records.
If you withdraw a denied change and the declaration matches the same chat's current
settings, rerun Install to clear the obsolete request without changing the chat.
Reverting a declaration does not clear an uncertain update whose outcome is still unknown.
A conflict or missing chat stops the update; earlier verified changes remain applied.

For `automation-journal-busy`, confirm no installation or synchronization is running
before removing only the stale Agent System `.lock` directory. Never edit native
scheduler files or delete Agent System's ownership records.

#### Schedules

| Form               | Example                                                           | Meaning                                |
| ------------------ | ----------------------------------------------------------------- | -------------------------------------- |
| Absolute one-shot  | `'2026-10-01T09:00:00-04:00'` or `{ at: '2026-10-01T13:00:00Z' }` | RFC 3339 timestamp, normalized to UTC. |
| Cron               | `'0 9 * * 1-5'` or `{ cron: '0 9 * * 1-5' }`                      | Numeric five-field calendar schedule.  |
| Recurring interval | `every 1 hour` or `{ every: 60 minutes }`                         | Elapsed-time recurrence.               |
| Relative one-shot  | `in 1 hour` or `{ in: 60 minutes }`                               | Delay from initial activation.         |

Durations use positive integers with matching singular/plural seconds, minutes,
hours, or days (86,400 seconds). Timestamps require seconds and an explicit offset,
with at most millisecond precision and no leap seconds.

Cron fields are minute 0–59, hour 0–23, day 1–31, month 1–12, and weekday 0–6.
Use `*`, numbers, ascending ranges, lists, and positive steps on `*` or ranges.
Day-of-month and day-of-week use OR when both are restricted.

Schedule objects accept exactly one trigger key, plus:

| Field        | Type                | Required | Default  | Description                                                             |
| ------------ | ------------------- | -------- | -------- | ----------------------------------------------------------------------- |
| `missed-run` | `native`            | no       | `native` | Native catch-up behavior.                                               |
| `timezone`   | IANA zone or `null` | no       | local    | Cron only. Omitted or `null` uses local time; `native` is not accepted. |

#### Effective content and trigger identity

Formatting-only edits do not cause drift; prompt/script content and argv order do.
Only the selected runtime's overrides apply. Executable dependencies are not
recursively hashed. Payload, timeout, and enabled-state edits preserve one-shot
trigger identity; activation and completion state belong to reconciliation.

### `backup`

Defaults for [workspace backup commands](./CLI.md#openclaw-agent-system-backup-create).
Loading the manifest creates no backups.

| Field                   | Type                         | Required | Default                 | Description                                                      |
| ----------------------- | ---------------------------- | -------- | ----------------------- | ---------------------------------------------------------------- |
| `backup.exclude`        | string array                 | no       | `[]`                    | Workspace-relative glob patterns applied last; exclusions win.   |
| `backup.git-ignore`     | boolean                      | no       | `false`                 | Apply local Git-ignore rules before restoring includes.          |
| `backup.include`        | string array                 | no       | `[]`                    | Workspace-relative glob patterns that restore filtered entries.  |
| `backup.openclaw-state` | `auto`, `required`, or `off` | no       | `auto`                  | Capture an existing agent database, require it, or omit it.      |
| `backup.output`         | string                       | no       | `.agent-system/backups` | Local destination; relative paths resolve against the workspace. |

```yaml
backup:
  output: .agent-system/backups
  git-ignore: true
  openclaw-state: auto
  include:
    - MEMORY.md
    - memory/**
    - DREAMS.md
    - GOALS.md
  exclude:
    - scratch/**
    - previous-backups/**
```

CLI options override manifest fields, which override defaults; there is no
backup-specific environment layer. Include/exclude options replace their manifest
lists; `--include=` and `--exclude=` clear them. Includes cannot override mandatory
exclusions. Exclude previous custom destinations explicitly.

See the [backup command](./CLI.md#openclaw-agent-system-backup-create) for coverage,
destination restrictions, and sensitive-archive handling.

### `debug`

| Type    | Required | Default |
| ------- | -------- | ------- |
| boolean | no       | `false` |

Set `debug: true` at the top level to show private **🔬 Debug** cards: selected
skills (including defaults), guidance sources, retained inline guidance, historical
missing cleanup evidence, and successful no-action delivery recovery details.
Codex and OpenClaw read the current bound manifest for visibility; omitted or false
hides these details, including on repeated reports. Historical detail does not
trigger notifications by itself or establish that resources remain or cleanup
succeeded. Unchanged healthy OpenClaw intake stays silent, even with debug enabled.
Errors, blockers, responses, and publication outcomes remain visible. It does not change permissions or the skill or guidance applied to a turn.

In standalone Codex, `debug` also enables the size-limited `permission-request.jsonl`
log in plugin data. It records invocation/session IDs, command hashes, timing, and
`allow` or `abstain` decisions, without command text or stdin. Changes apply on the
next invocation. Disabling debug preserves existing records; logging failures do not
block approval, and a logged `allow` does not prove command success.

Inline guidance links to its verified manifest source when available. The text
shown is the retained snapshot, while the linked file may have changed since then.
Only inline guidance text is expanded; file guidance retains its source link.

### `environment`

| Field          | Type                    | Required | Default | Behavior                                                              |
| -------------- | ----------------------- | -------- | ------- | --------------------------------------------------------------------- |
| `dotenv`       | string or string list   | no       | none    | Ordered workspace-relative dotenv files.                              |
| `op`           | string or string list   | no       | none    | Ordered 1Password Environment IDs merged after `set`.                 |
| `path-prepend` | string or string list   | no       | none    | Ordered workspace-relative executable directories.                    |
| `required`     | string list             | no       | none    | Names that fail complete environment resolution when absent or empty. |
| `set`          | string or `from-op` map | no       | none    | Explicit values merged over dotenv values.                            |

Schema-owned YAML keys use kebab-case. Environment names and user-defined
identifiers remain literal and are never casing-converted. See
[Environment Resolution](#environment-resolution) for source precedence and resolution behavior, and
[Path](#path) for executable projection.

### `memory`

`memory` is optional. Omitting it leaves the bound agent's existing OpenClaw
memory search configuration untouched. When present, `search.provider` is
required:

| Field      | Type                      | Required | Default | Behavior                                                                  |
| ---------- | ------------------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `api-key`  | environment name          | no       | none    | Reads one declared Agent System environment binding; valid with `openai`. |
| `model`    | string                    | no       | none    | Overrides OpenClaw's embedding model; valid only with `openai`.           |
| `provider` | `none`, `local`, `openai` | yes      | none    | Selects keyword-only, local embedding, or OpenAI embedding search.        |

`install` sets the bound agent's provider and fallback, plus the optional model
and API-key reference, while preserving other memory settings and agents. The
`none` provider retains keyword search. Configure `local` through OpenClaw before
expecting semantic search:

```sh
openclaw models --agent tanaabot auth login --provider llama-cpp --method local
```

An OpenAI `api-key` becomes an agent-and-binding-scoped `SecretRef`. Use a
declared dotenv file or stored 1Password credential so it survives restarts.
Agent System resolves only that reference when OpenClaw loads its secret snapshot.

An operator who can rewrite `openclaw.json` can copy the reference. For linked
checkouts, follow the [source-install rebuild and restart steps](./DEVELOPMENT.md#install-from-source)
after changing the provider form or binding.

Doctor preserves the memory database and checks readiness by provider:

- `none`: keyword index.
- `local`: local provider availability.
- `openai`: the configured credential and one bounded embedding probe; an unrelated fallback credential cannot establish readiness.

Authentication, permission, billing/quota, and transport failures omit upstream
error bodies. Index identity and synchronization drift are separate findings.

Use OpenClaw's explicit memory commands when you intend to mutate the index:

```sh
# inspect the bound agent without rebuilding its index.
openclaw memory status --agent tanaabot --deep --json

# rebuild only when doctor reports index drift and you intend the write.
openclaw memory status --index --agent tanaabot
```

### `models`

`models` is optional. Omitting it leaves the agent's existing model configuration
untouched. When present, `default` is required; `low`, `medium`, and `high` are an
additive work-tier group and must be declared together or omitted together.

Each profile requires both fields:

| Field    | Type                         | Required | Default | Behavior                                                      |
| -------- | ---------------------------- | -------- | ------- | ------------------------------------------------------------- |
| `effort` | `medium`, `high`, or `xhigh` | yes      | none    | Explicit profile effort, intersected with runtime support.    |
| `model`  | provider-qualified model ref | yes      | none    | Exact `provider/model` reference; no model value is built in. |

The [routing helper](./tools/model-routing/README.md) validates assessments and
explicit selections against these profiles; it has no built-in model or effort
defaults. Configuration generators can read `profiles.default` from `inspect`.

`models.routing` optionally customizes **initial** routing for direct calls, manual
issue launch, and scheduled admission in OpenClaw and standalone Codex:

| Field              | Type                       | Required | Default                                   | Behavior                                                                                           |
| ------------------ | -------------------------- | -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `routing.guidance` | string or `{file: string}` | no       | none                                      | Additional inline/multiline guidance or a UTF-8 file relative to the stable bound agent workspace. |
| `routing.skill`    | skill ID                   | no       | `agent-system:agent-system-model-routing` | Replacement judgment method, discovered through the calling runtime.                               |

```yaml
models:
  default: { model: openai/example-default, effort: high }
  low: { model: openai/example-small, effort: medium }
  medium: { model: openai/example-medium, effort: high }
  high: { model: openai/example-large, effort: high }
  routing:
    skill: company:task-routing
    guidance:
      file: guidance/model-routing.md
```

The example model IDs are placeholders. Omission or `routing: {}` keeps the default
rubric; guidance supplements it. The selected skill runs once, without another
classifier. Shared [skill and guidance rules](#skill-and-guidance-values) cover the
32 KiB limit, file checks, and instruction updates. Passive discovery validates shape
without reading guidance files.

Explicit operator model and effort choices each override their configured field.
Explicit user or verified structured Complexity fixes the tier; otherwise the selected
method assesses `low`, `medium`, `high`, or `unset`. Profiles supply model and effort,
subject to native availability and application checks. Guidance cannot change verified
Complexity, add operator overrides, or select models outside the configured profiles. Default fallback must be
explicit and keeps the unresolved status.

Edits affect new selections. If instructions change before they are used, the agent
must assess the selection again. Saved creation attempts keep their selection. Follow-ups, resume, compaction, and
implementation preserve saved choices unless the operator changes native settings;
there is no automatic model switch between planning and implementation.

Model refs cannot select an authentication profile. Credential configuration
remains outside the manifest.

OpenClaw's `agents.entries.<id>.models` map stores per-model metadata such as
`agentRuntime`; it does not authorize selection. Selection is governed by the
agent's effective `modelPolicy.allow`, which may come from the agent entry or
`agents.defaults`.

`install` applies declared models to the bound agent:

- Sets the primary model and thinking effort from `default`.
- Binds declared models to `agent.runtime` when present, otherwise to the agent's established runtime route, without resolving credentials.
- Extends a restrictive per-agent `modelPolicy.allow` only as needed, preserving inherited permissions. Unrestricted or matching wildcard policies need no repair.
- Preserves global defaults, fallbacks, other agents, unrelated model settings, and existing sessions.

> [!NOTE]
> An incompatible or ambiguous runtime binding blocks installation. Removing
> profiles later does not undo defaults or policy entries.

`doctor` checks configuration, selection policy, model presence, and effort
support without authentication or inference. OpenClaw owns runtime health.
Explicit unavailability produces a warning; unknown availability is not failure.
Inspection errors remain distinct from known unsupported models or efforts.

Complete work tiers enable [GitHub issue model routing](./tools/model-routing/README.md)
for new issue conversations. A default-only manifest keeps ordinary model behavior.

For standalone Codex task selection, see [Codex model routing](./tools/model-routing/README.md#agent_system_model_routing).

### `schema-version`

| Type    | Required | Default |
| ------- | -------- | ------- |
| integer | yes      | `1`     |

Identifies the manifest schema. Version `1` is the only accepted value.

<a id="setup-host-setup-agent-and-setup"></a>

### Setup

Use `setup-host` to install dependencies before Agent System configures the agent
and tools. Use `setup-agent` for commands that need that configured identity and tools.
Install runs both phases. Optional checks support repeat installation and Doctor.
The deprecated `setup` key supplies `setup-agent` only when it is absent;
an unused `setup` declaration is still validated.

Omit setup already handled by first-party configuration. Keep checks read-only and
apply commands safe to repeat: scripts can change files and external services.

| Top-level key | Type              | Required | Default | Behavior                                                                  |
| ------------- | ----------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `setup`       | setup declaration | no       | none    | Deprecated fallback for `setup-agent`; ignored when `setup-agent` exists. |
| `setup-agent` | setup declaration | no       | none    | Runs after managed-tool prerequisites.                                    |
| `setup-host`  | setup declaration | no       | none    | Runs before agent and managed-tool reconciliation.                        |

#### Syntax

Use the short mapping for one checked operation:

```yaml
setup-agent:
  shell: zsh
  check: test -d repos
  apply: mkdir -p repos
```

Either top-level key may use `file` to name one YAML file relative to the
containing `agent.yaml`. The file contains the setup value itself, without a
second wrapper:

```yaml
# agent.yaml
setup-agent:
  file: ./setup.yaml
```

```yaml
# setup.yaml
shell: bash
steps:
  - id: directories
    check: test -d repos
    apply: mkdir -p repos
```

The referenced file may use any inline setup form shown below: a scalar script,
a short mapping, or named steps. `file` cannot be combined with inline fields or
another file reference. Absolute paths, URLs, and paths escaping the workspace
(including through symlinks) are rejected. Commands still run from the bound
workspace, not from the setup file's directory.

| Form                                                                | Meaning                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `setup-agent: mkdir -p repos` or a YAML block scalar                | One unchecked `apply` script using `sh`                                       |
| `check: test -d repos` / `apply: mkdir -p repos`                    | Script using the selected shell                                               |
| `check: [test, -d, repos]` / `apply: [mkdir, -p, repos]`            | Literal argument array, without shell parsing or expansion                    |
| `apply: { command: mkdir, args: [-p, repos], timeout-seconds: 60 }` | Direct executable with optional arguments and timeout; also valid for `check` |

Use `steps` for ordered operations. Strings inherit the section's shell unless a
step overrides it; direct commands ignore shell selection. The manifest is
validated before either phase runs. This example requires `./scripts/dependencies`:

```yaml
setup-host:
  shell: bash
  steps:
    - id: host-tools
      check: brew bundle check --file=Brewfile
      apply: brew bundle --file=Brewfile

setup-agent:
  shell: bash
  steps:
    - id: directories
      check: test -d repos && test -d artifacts
      apply: |
        mkdir -p repos
        mkdir -p artifacts
    - id: dependencies
      runtimes: [openclaw]
      check: [./scripts/dependencies, check]
      apply:
        command: ./scripts/dependencies
        args: [install]
        timeout-seconds: 600
```

Strings, block scalars, and the short mapping normalize to one step named
`default`. Named steps require a unique lowercase kebab-case `id` and an `apply`;
`check` is optional. `steps: []` clears the phase; `steps` cannot mix with
short-mapping fields. Bare arrays and command objects are not setup shorthand: place them
under `check` or `apply`.

#### Shells, executables, and limits

`shell` accepts only `sh`, `bash`, or `zsh`; the default is `sh` on every platform,
including macOS. The selected shell must already be installed. Strings are
written to private temporary scripts, run with these fixed arguments, and
removed afterward:

| Shell  | Invocation                                        |
| ------ | ------------------------------------------------- |
| `bash` | `bash --noprofile --norc -e -o pipefail <script>` |
| `sh`   | `sh -e <script>`                                  |
| `zsh`  | `zsh -f -e -o PIPE_FAIL <script>`                 |

There are no custom shell wrappers or automatic login-shell selection. Every
command defaults to a 600-second timeout. Only the direct command object accepts
`timeout-seconds`, an integer from `1` through `3600`; strings and arrays retain
the default.

Commands start in the bound workspace with closed stdin. OpenClaw owns command
capture defaults. Standalone Codex has no host capture API, so its process adapter
retains the last 512 KiB per stream independently (at most 1 MiB of raw output),
with truncation counts. Timeouts terminate the command's process tree. Ordinary
runs report step ids, setup owner (`setup-host` or `setup-agent`), check/apply
phase (including checks after apply), and known exit codes, timeouts, signals, or
execution failures. Unavailable termination details stay unknown; command
declarations, environment values, and raw command output remain excluded. When
GitHub Actions runner debug is enabled, setup commands receive only the exact
`RUNNER_DEBUG=1` signal. Standalone Codex relays bounded `debug: ` lines from
captured standard error to its own standard error. Standard output, other
standard-error lines, command declarations, arguments, and unrelated environment
values remain private. The interactive confirmation deliberately shows the
declared commands, so keep secrets out of declarations.

`setup-host` receives a minimal host environment for home, locale, and temporary
paths, using trusted host executables without managed launchers, agent credentials,
or resolved manifest secrets. It runs from the bound workspace before OpenClaw agent
and tool reconciliation. It still has the installing OS user's filesystem access;
the shell and package manager must already be available on the host.

`setup-agent` under OpenClaw receives a minimal host environment for home, locale,
temporary paths, and OpenClaw profile selection, plus managed command bindings.
Its `PATH` places managed launchers before trusted host executable directories.
Bare `git` and `gh`
use host executables when a descendant leaves agent scope; see the
[command-routing contract](./CLI.md#trust-boundary). The completed
Agent System environment and operator provider tokens are not copied into the
setup shell. Managed tools resolve their own declared environment and credentials
after binding the target agent and applying policy.

Direct workspace executables such as `./scripts/dependencies` must be executable
regular files within the workspace, with no symlinks or group/world-writable
path segments. Direct executable declarations reject `..` traversal. These
checks and the command limits do not sandbox arbitrary shell code or isolate
processes sharing the same OS user.

#### Runtime applicability

An optional `runtimes` list selects `openclaw`, `codex`, or both. Omission means
both, including bare strings and blocks. Put the filter on the short mapping or
individual named steps, never the `steps` container:

```yaml
setup-agent:
  runtimes: [openclaw]
  check: test -d repos
  apply: mkdir -p repos
```

Lists require unique supported values; `[]` selects none. The host determines the
runtime: OpenClaw, including OpenClaw-hosted Codex, uses `openclaw`; the
[standalone Codex adapter](./CODEX.md#skills) uses `codex`. Models, installed binaries,
and manifest prose cannot override it.

All declarations are validated. Nonmatching steps run neither command and report
`status: skipped`, `code: setup-not-applicable`, and their `stepId`, not drift or failure.
With no matching agent-bound steps, setup-only tool prerequisites are skipped too.
Other components run normally; matching steps retain their order within each phase.
There is no skip exit code or `when` expression.

#### Checks, installation, and retries

| Applicable step                                     | Doctor    | Install                                          |
| --------------------------------------------------- | --------- | ------------------------------------------------ |
| Check exits `0`                                     | `healthy` | Leaves the step `unchanged`.                     |
| Check exits `1`                                     | `drift`   | Runs apply, then requires the check to exit `0`. |
| Check exits otherwise, cannot execute, or times out | `blocked` | Stops without applying the step.                 |
| No check                                            | `manual`  | Runs apply on every installation.                |

Apply must exit `0`. A failed apply, blocked check, or check that still reports
drift after apply stops later steps and dependent lifecycle work. Earlier
changes remain in place; Install does not roll back setup commands. On retry, healthy checked steps are skipped and
unchecked steps run again. Coordinate host-wide or shared-resource changes
outside this per-agent mechanism.

Write checks so that `1` means expected drift and other nonzero exits mean an
inspection failure. The runner cannot distinguish intended drift from an
unhandled command error that also returns `1`. Doctor runs applicable checks
without prompting, applying setup, or repairing prerequisites, and aggregates
their findings. A check is trusted code: its read-only behavior is the author's
responsibility. `validate` only validates declarations and never executes them.

#### Agent identity and repository cloning

OpenClaw installation checks stored 1Password access, runs `setup-host`, registers
the agent and managed tools, then runs `setup-agent`. Missing managed-tool
prerequisites block agent setup; remaining lifecycle components follow it.

To clone as the agent, first declare its [Git identity and SSH
keys](./tools/git/README.md#configuration-reference) and [GitHub username, token,
and public keys](./tools/github/README.md#configuration-reference). Supply host
executables directly or install them in `setup-host`; credential sources and
key files must be available before agent-bound setup. The
[tools example](https://github.com/tanaabased/openclaw-agent-system/blob/main/examples/openclaw-tools/README.md)
exercises agent-bound setup commands; the
[worktree example](https://github.com/tanaabased/openclaw-agent-system/blob/main/examples/openclaw-worktree/README.md)
exercises declared SSH checkout with OpenClaw's managed tools. They use the declared
agent identities without operator-identity fallback; the process still runs as
the installing OS user.

## Skill and Guidance Values

`models.routing` and GitHub workflow stage customizations accept the same object:

| Field      | Type                         | Required | Default                  | Description                                                                |
| ---------- | ---------------------------- | -------- | ------------------------ | -------------------------------------------------------------------------- |
| `guidance` | string or `{ file: string }` | no       | none                     | Nonempty single-line or multiline text, or one UTF-8 file; at most 32 KiB. |
| `skill`    | string                       | no       | consumer's default skill | ID of one enabled, host-discoverable skill.                                |

Omit the object or use `{}` to keep that operation's default skill without extra guidance. Guidance
alone supplements that default; a replacement skill runs alone, with guidance when
supplied. These fields select instructions; they do not authorize execution or
publication.

Skill IDs accept `skill-name`, `$skill-name`, `plugin:skill-name`, and
`$plugin:skill-name`. Surrounding spaces and the optional `$` are removed; case is
preserved. An unqualified name must identify exactly one enabled skill. Use its
plugin-qualified name to disambiguate. Paths, URLs, inline workflows, and automatic
skill installation are unsupported. Repository-owned skills are eligible when the
host discovers them; a skill file path is not a manifest selection mechanism.
OpenClaw matches exact catalog names or skill keys, plus built-in Agent System
aliases; qualified IDs must be exposed by that catalog, never inferred from paths.
Current resolution supports host-discovered local `SKILL.md` sources.

With `guidance: { file: guidance/assessment.md }`, the path resolves from the stable
bound agent workspace, not the issue worktree or manifest directory. Absolute paths,
traversal, symlinks, nonregular files, invalid UTF-8, empty text, and NULs are rejected.
Inline and file forms are mutually exclusive. Guidance files contain instructions,
not secrets. Agent System saves the instructions used by each operation privately.

If an explicitly selected skill is missing, disabled, ambiguous, or unreadable, or
its guidance is invalid, the operation stops rather than choosing a replacement.
You do not need Install to apply instruction edits to new or refreshed work that
has not been submitted. Submitted work keeps the instructions it used for recovery. See [model routing](#models) and
[GitHub stage selection](./channels/github/CONFIG.md#assessment-selection) for
their defaults, examples, and supported behavior.

## Environment Resolution

Source precedence is fixed:

```text
environment.dotenv[0] < later dotenv files < environment.set < environment.op[0] < later 1Password Environments
```

Variable names match `^[A-Za-z_][A-Za-z0-9_]*$`; values are YAML strings or
`from-op` objects. Dotenv files must be distinct regular files inside the
workspace. They accept comments, optional `export`, and quoted or unquoted
`NAME=value` entries without interpolation or shell execution.

`environment.set` strings expand uppercase `$NAME` and `${NAME}` references
once; `$$` emits `$`. Lookups use the process environment and ordered external
sources, never sibling `set` values. Host values are lookup-only.

A `from-op` object resolves a secret directly:

```yaml
environment:
  set:
    SSH_KEY:
      from-op: 'op://vault/item/private key?ssh-format=openssh'
```

These values are always sensitive; diagnostics omit the reference itself.
A plain `op://` string stays literal. `environment.op` takes opaque
[1Password Environment IDs](https://www.1password.dev/sdks/environments#appendix-get-an-environments-id),
not display names, and loads them in order through the SDK.

Dotenv and 1Password values load only when an operation needs them; passive discovery
never loads them. `environment.required` applies to complete environment resolution, not
unrelated actions. [Credential storage](./CLI.md#credential-storage) defines lookup
order. Install requires a persistent credential; the bootstrap token is never exported,
required, or interpolated by the manifest.

Agent System tools resolve declared values after trusted binding and authorization.
Generic OpenClaw, Codex, ACP, MCP, and third-party tools do not receive the completed
Agent System environment. The separate [Path](#path) settings below control executable
lookup.

## Path

Installation builds one deterministic managed prefix followed by a saved Codex
baseline:

```text
<workspace>/bin
<workspace>/<environment.path-prepend[0]>
<workspace>/<later declared entries>
<agent-system-package>/bin
<saved Codex baseline>
```

Declared entries are literal workspace-relative directories. They must exist,
remain inside the canonical workspace without traversing symlinks, and need not
repeat the automatically managed workspace or package `bin` directories.

The first installation saves the invoking process PATH as its baseline. Later
installs preserve its exact order and append caller directories not already
saved. Exact duplicates are removed; distinct path aliases are retained.
Managed workspace, declared, and package entries remain authoritative at the
front; Install removes obsolete entries that it previously managed.

Agent System projects the managed prefix into the selected agent's OpenClaw
`tools.exec.pathPrepend`. For local Codex native shell commands, it writes an
equivalent machine-specific `<workspace>/.codex/config.toml` and adds that path to
the root `.gitignore`.

Agent System owns the Codex file only when it contains
`# agent-system: managed-path-v1`. An existing unmarked file or one containing
`# agent-system: manual-path-v1` remains user-managed. Add the equivalent settings
to a user-managed file without duplicating existing TOML tables:

```toml
# agent-system: manual-path-v1

allow_login_shell = false

[features]
shell_snapshot = true

[shell_environment_policy.set]
PATH = "/absolute/workspace/bin:/absolute/agent-system/bin:/base/path"
```

Rerun `install` when the workspace, package location, declared paths, or host PATH
changes. Use `openclaw agent-system install --rebuild-codex-path` only when the
saved baseline should be replaced by that CLI environment. Native chat Install
offers the equivalent approved `rebuildCodexPath` option. Both report baseline
changes; neither modifies user-managed Codex configuration.

> [!NOTE]
> Existing baseline order wins; stale paths can accumulate. Doctor reports caller
> directories that Install would append, but extra, reordered, or nonexistent
> baseline entries alone are not drift. PATH health does not prove executable availability.

Start a new Codex session after PATH changes; existing sessions do not hot-reload
the workspace configuration. Agent System disables login-shell
execution and sets the deterministic PATH without otherwise changing Codex's
inherited-environment policy. Remote, sandboxed, ACP, MCP, and third-party
surfaces retain their own path and mount contracts.

## Machine-local Overrides

Add an optional `agent.local.yaml` beside the [selected base manifest](#discovery):
`.agent-system/agent.local.yaml` or root `agent.local.yaml`. A local file elsewhere
is ignored, and an override cannot replace the base manifest.

Keep the base tracked. Before creating the local file, add these missing entries
to `.gitignore` without replacing existing content or an existing local file:

```gitignore
/agent.local.yaml
/.agent-system/agent.local.yaml
```

Only include settings that differ on this machine; required base fields do not
need repeating. For example:

```yaml
models:
  default:
    effort: medium
```

Mappings merge recursively; scalars and whole arrays replace inherited values.
`[]` clears a list where the schema permits it, while `{}` retains inherited mapping
entries. `null` is not deletion and is valid only where the field allows it.

The merged manifest must pass validation. Both runtimes read it, each applying only
supported settings; use the owning runtime to apply changes. Relative paths keep
their normal manifest-directory or workspace base, regardless of which file declares them.
