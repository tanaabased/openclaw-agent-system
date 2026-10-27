# Codex

The standalone Codex plugin provides workspace context, setup, model routing,
repository automations, and GitHub issue assessment, implementation, and PR delivery
from `agent.yaml`. OpenClaw remains the [primary integration](./README.md);
OpenClaw-hosted Codex uses that integration and its managed tools.

## Plugin Installation

Install through [Codex Tools](https://github.com/tanaabased/codex-tools) without a global CLI installation:

```sh
# preview registration and installation.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system --dry-run --json

# install the plugin.
npx --yes @tanaab/codex-tools install npm:@tanaab/openclaw-agent-system
```

## Workspace Setup

Clone the agent workspace you want to use; this example uses [Me](https://github.com/pirog/me).

```sh
# use your existing checkout if you already have one.
mkdir -p ~/tanaab
git clone https://github.com/pirog/me.git ~/tanaab/me
cd ~/tanaab/me

# copy the absolute path for the binding prompt.
pwd -P
```

Open the checkout as a local project in the Codex app, or run `codex` there.
Before binding, use `/hooks` in Codex CLI with the same profile to
[review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks) the
installed Agent System hooks:

- **SessionStart** loads the trusted workspace binding and runtime context when a
  chat starts or resumes.
- **PermissionRequest** is optional. Approving it delegates execution approval for
  recognized Agent System runtime calls; review the [approval boundary](#runtime-execution-approval)
  below before enabling it.

Open a new chat after approving the hooks. Plugin installation alone does not
replace native hook approval.

```text
Use $agent-system-codex-binding to bind this plugin to /absolute/path/to/tanaab/me.
```

Confirm the binding, then open a new chat and run:

```text
Use $agent-system-install to initialize this installation and apply declared setup.
Then use $agent-system-doctor to check readiness.
```

Install creates a persistent installation UUID and generated readable name. Reinstalling
or rebinding a workspace preserves them; Doctor only inspects them. Ask Codex to
“rename this instance to office-laptop” to customize the readable name. Even a
request to “change the instance ID” means renaming unless you explicitly ask to
**rotate the UUID**. Rotation detaches old claim receipts without transferring work;
use it for a copied installation. The trusted `instanceRuntime` exposes these
operator actions without reading OpenClaw state.

### Runtime Execution Approval

Trusting the optional PermissionRequest hook delegates native execution approval to this
installed Agent System runtime, including current and future commands and their stdin
request data. There is no separate consent store or operation whitelist. The runtime
still checks task authorization, operator-only requirements, and request validity, and
handles provider interactions. The hook does not independently assess those decisions.

Recognized direct runtime calls may be approved by the hook. Other commands,
including native Git, GitHub CLI, and app-tool calls, retain their native approval
behavior. Disable the hook through `/hooks` to restore ordinary approval. Calls
the hook cannot recognize also remain subject to ordinary approval. Existing workflow denials and provider protections
remain in their owning paths; trusting the hook does not override them.

With `debug: true` in the bound workspace's `agent.yaml`, the hook writes
`permission-request.jsonl` in its plugin data directory. Records contain invocation
and session IDs, a command hash, timing, and the `allow` or `abstain` decision,
without command text or stdin. Logging is off by default; changes apply on the next
invocation without changing approval behavior. The log is size-limited, and disabling
debug preserves existing records. Logging failures do not block approval, and a
logged `allow` does not prove the command succeeded.

Approving the hook means trusting the installed runtime and its later updates. See the
[native hook contract](https://learn.chatgpt.com/docs/hooks#permissionrequest) and
[installed verification example](./examples/codex-install/README.md).

## Skills

Standalone Codex supports workspace context, [applicable setup steps](./MANIFEST.md#setup), and [repository automations](#repository-automations).
Git and GitHub use native host commands and authorization. The managed GitHub
[self-unassignment guard](./tools/github/README.md#assignment-protection) does not
intercept standalone Codex's host `gh`, absolute binaries, HTTP/SDKs, or unrelated
integrations; it is not a universal GitHub restriction.

See the [complete shipped skill inventory](./README.md#skills). Each skill selects
the owning runtime; a shared skill does not enable OpenClaw-managed credentials or
tools in standalone Codex.

## Model Routing

Declare [model profiles and initial-routing customization](./MANIFEST.md#models)
in `agent.yaml`, then use the [model routing skill](./skills/model-routing/SKILL.md)
when starting new work. See the [routing reference](./tools/model-routing/README.md)
for selection and overrides.

Standalone Codex reads these profiles without changing OpenClaw configuration.
A mapped selection still needs native Codex support and application; it is not
proof that the model is available or that a task is using it. Issue workflows pass
the selected model and effort to native chat creation. Later changes through native
chat controls are preserved during continuation; routing does not automatically
switch models between planning and implementation.

## GitHub Notification Policy

<a id="issue-feedback"></a>
<a id="auto-mode"></a>
<a id="work-mode"></a>
<a id="pull-request-delivery"></a>

Use the [GitHub channel guide](./channels/github/README.md) for common setup and
[configuration reference](./channels/github/ADVANCED.md#configuration-reference)
for workflow fields. Both runtimes share [Plan, Work, and Auto behavior](./channels/github/ADVANCED.md#live-policy-and-modes),
[feedback permissions](./channels/github/ADVANCED.md#feedback-and-public-replies),
and [implementation and PR delivery](./channels/github/ADVANCED.md#issue-implementation-and-pr-delivery).
Independent review-request execution remains unavailable.

Use `$agent-system-install` to authorize and reconcile the native assignment chat
and schedule. The [derived assignment automation](./channels/github/ADVANCED.md#activation)
uses `models.low` in Codex. Find **📥 ISSUE ASSIGNMENTS** in native automations and
its **ISSUE ASSIGNMENTS** chat under **AGENT SYSTEM**. Follow intake and capacity
there; plans, questions, implementation progress, and publication outcomes belong
in each issue's chat.

Install verifies a new automation chat's saved approval settings and the saved
schedule. Native review can still deny an operation. Doctor inspects saved
definitions and local intake evidence without contacting GitHub; it cannot verify
current chat permissions or prove unattended execution. Verify execution separately
with a real scheduled occurrence. [Hook approval](#runtime-execution-approval) is a
separate native trust decision, not proof that the schedule has run.

Intake uses native host GitHub access. The authenticated account must match
`github.username` and applicable identity pins. Discovery needs repository read
access; implementation and publication require the corresponding Git and GitHub
permissions. The initial activation establishes a historical baseline; reinstall
and restart retain it.

Mode, author, reviewer, guidance, and capacity changes apply live. Run Install when
changing the installed schedule, including its cadence or pause setting, or when the
runtime reports that the schedule needs an update. See
[pause and resume](./channels/github/ADVANCED.md#pause-and-resume). Choose which machine
runs each workflow;
[installation identity](./channels/github/ADVANCED.md#installation-identity-and-assignment-claims)
does not coordinate or deduplicate work across machines.

### Issue Assessment

Dispatch verifies the repository's full GitHub identity before selecting a saved
local project. An explicit
`git.worktrees.repositories.local.github-<repository-database-id>` mapping wins;
otherwise, optional `git.worktrees.repositories.working-directory` selects
`<directory>/<repository-name>`. A matching normal checkout is reused without
resetting user work; a missing checkout is cloned with native host Git authorization.
See [Git repository locations](./tools/git/worktree/README.md#gitworktrees) for path rules.

Without either location, dispatch first reuses a matching saved project. If none
exists, it prepares the managed bare repository and one stable detached base
checkout beneath the configured worktree root. That base is the project folder;
native Codex creates a separate issue worktree. A configured path or clone failure
blocks preparation rather than choosing a different storage location.

The native interface has no supported saved-project registration action. When
registration is needed, add the exact prepared checkout reported by dispatch as
the primary folder of one saved local Codex project. The next scheduled occurrence
verifies it and resumes the assignment. Until that manual step, new-repository
dispatch is not unattended. Ambiguous projects, identity conflicts, and interrupted
clones retain actionable blockers rather than creating replacements.

New repository preparations read the current manifest locations without moving or
deleting earlier checkouts. An assignment already preparing a repository remains
pinned to its retained path: restore its explicit local mapping or previous
directory and roots before resuming. Interrupted clones also require recovery at
their original location before selecting another destination. After verifying the
saved project, dispatch refreshes the default branch and pins the starting commit.
Assessment leaves the issue checkout detached; implementation selects and retains
its task branch. Retries preserve that branch, including after an issue title change.

Codex resolves configured assessment and implementation skills through native skill
discovery. A missing or changed skill blocks the affected operation; restore it and
resume the retained chat rather than launching another. See [assessment selection](./channels/github/ADVANCED.md#assessment-selection)
and [implementation selection](./channels/github/ADVANCED.md#implementation-and-review-selection).
For direct work in an existing checkout without scheduled intake, use the shared
[assessment and implementation entry points](./channels/github/ADVANCED.md#assessment-and-implementation).

### Workflow Recovery

Continue in the existing issue chat with its work and evidence intact. The shared
[publication recovery guide](./channels/github/ADVANCED.md#interrupted-publication)
covers missing summaries, replies, PR attachments, and announcements. If the outcome of
a native creation, send, or publication is uncertain, use its recovery controls to check
what happened before trying again. An unresolved creation can still occupy capacity.
Never edit tracking files or create a replacement chat to clear a blocker.

Delivery requires the branch retained for the assignment. If another branch is
checked out, preserve local changes and return to the retained branch before
resuming. A matching branch name or historical comment does not establish ownership.
A closed PR on the selected branch blocks publication. Incomplete branch creation
resumes through implementation context in the existing chat.

For an interrupted assessment-to-implementation transition, ask the issue chat to
continue through its retained handoff. This preserves the chat, checkout, and
assessment. A `continuation-turn-state-unresolved` diagnostic requires a fresh
native thread observation through the returned instructions; it is not a reason
to force another coordinator message.

To stop further automatic work, request `continuationRuntime` action `cancel` in
the issue chat. Cancellation does not undo files or an already-started external
operation. A live policy hold preserves pending work; pausing future scheduled
occurrences follows the shared [pause controls](./channels/github/ADVANCED.md#pause-and-resume).

For `continuation-turn-ended` before an implementation result or delivery attempt,
an operator may request `continuationRuntime` action `retry` with the retained `id`,
then repeat it with the returned `digest`. This verifies the old turn has ended,
retains its evidence, and queues one handoff in the same chat on the next scheduled
turn. It cannot retry native denials, substantive results, or cancelled work.

An altered continuation prompt stops with `continuation-send-mismatch`. The same
operator retry can recover a verified, completed malformed send only before any
recorded implementation or delivery, with the original assessment checkout unchanged.
The preview binds the native send evidence and latest diagnostic turn; recovery
retains both before queuing one new handoff. Unknown or duplicate sends, changed
native settings, and approval denials remain blocked. Never edit tracking files or
manually resend the old request.

For an explicitly reapproved native send rejection before implementation, use
`continuationRuntime` action `retry-denied` from the operator chat with the retained
`id`. Inspect its rejection evidence, then apply its `digest` and the exact
`approvedCallId`. Recovery requires the original idle chat and unchanged assessment
checkout, retains the rejected attempt and reason, and queues one fresh handoff for
scheduled intake. Native approval still applies. Unknown send failures, later chat
turns, and denials during implementation or publication remain blocked.

An unfinished feedback publication stops instead of automatically resuming another
model turn. After explicit human approval, an operator chat may preview
`feedbackRuntime` with `{"action":"publish-approved","id":"...","eventId":"..."}`
and apply its returned `digest`. This retries only the exact retained reply,
rechecks its source and permissions, and reconciles any uncertain provider write.
Later follow-ups do not invalidate the retained reply; recovery verifies its original
completed feedback turn and waits if the owning chat is active.

#### Intake approval recovery

An `EPERM` or `EACCES` failure may mean the sandbox cannot write private tracking
files. The agent may retry the same command once through native host approval;
it must not change directory permissions or delete locks. An actual native denial
remains a stop for the denied action.

A verified issue-specific preparation or chat-creation denial is held across runs
and reassignment. Unrelated eligible assignments may continue when host authority
and capacity permit; shared refusals, ambiguous scope, or unavailable evidence
stop intake. The report identifies the issue, action, redacted reason, and recovery
identifiers.

For an operator-confirmed intake denial, pause the schedule and request
`dispatchRuntime` action `retry-denied` with the retained `id` from an operator
chat. Inspect the exact rejected call, then apply the preview's fresh `digest`.
An automatic-review rejection additionally requires renewed operator approval for
the exact failed call: supply its `approvedCallId` in preview and apply, and
communicate that authorization to the intake chat before resuming. This records
approval already given; it does not grant it. Recovery verifies non-execution and
current authority. Timeouts and unknown outcomes cannot use this path, and a new
attempt remains subject to native approval.

#### Reset and retirement

For a workspace-wide reset, use [Notifications Reset](./skills/notifications-reset/SKILL.md)
from an operator chat. It previews the inventory, replaces the intake coordinator,
and establishes a fresh assignment baseline. Existing issue chats and checkouts
remain unless purge was explicitly selected. Reset and purge never change GitHub
issues, assignments, comments, or PRs; `all` selects only the current binding.

Purge additionally prepares native chat archival and checkout cleanup. It waits for
active turns without aborting them, preserves pinned and shared resources, and
leaves worktree removal to Codex. If a checkout remains after archival, cleanup is
incomplete: use supported native worktree controls and resume the same reset to
verify completion. Keep its recovery record; never delete a checkout behind the
app or repeat an unverified native mutation. The skill owns preview, confirmation,
and interrupted-reset choices.

To repeat one assessment through assignment intake, use `dispatchRuntime` with
`{"action":"reset","id":"<assessment-receipt>"}` from an operator chat, then repeat
with the returned `digest`. Reset requires a completed assessment and native confirmation
that its recorded result turn completed, with no later turn. It freezes the previous
result while preserving its chat and worktree; only a
new assignment event after reset permits a fresh dispatch. Reassignment alone does
not create another chat, and reset never authorizes implementation.

Use [Task Retirement](./skills/task-retirement/SKILL.md) for one task. Shared
[assignment lifecycle and cleanup rules](./channels/github/ADVANCED.md#assignment-lifecycle)
own eligibility, grace periods, preservation, and reactivation. Codex retirement
completes only after native archival and checkout removal are observed; desktop
preservation settings can leave cleanup pending.

Removing or revoking policy stops admission. Use authorized Install to pause the
owned job, including when the manifest is missing or invalid. Retain ownership and
intake evidence for recovery. See [automation recovery](#ownership-and-recovery)
for native write failures. Packaged checks alone do not prove native rendering,
scheduled execution, or visible delivery.

## Repository Automations

Installer-created automation chats use native `auto_review` with the
`workspace-write` sandbox and `on-request` approvals. Setup verifies the returned
permissions and their persistence through a fresh native process before marking
the chat ready. Native policy remains authoritative; auto-review may deny an
action. Existing ready chats retain their selected permissions. Neither setup nor
the plugin writes global approval rules to enable auto-review.

Declare recurring work in `agent.yaml`:

```yaml
automations:
  - id: daily-review
    schedule: every 24 hours
    prompt: Review the repository for actionable maintenance work and report the highest-priority finding.
```

Use `$agent-system-install` in the desktop app to apply authorized native actions
and verify each saved definition. Doctor compares desired and saved settings
without changing or running jobs. Headless Install returns
`requires-native-app-sync` when native app work remains.

The shared [`thread` declaration](./MANIFEST.md#persistent-conversations) creates
stable **per-automation** conversations, even when jobs declare the same ID;
these chats do not share context. A compatible `codex` executable must be on
`PATH`; unsupported protocol methods fail closed. The desktop app owns every
schedule.

The [manifest reference](./MANIFEST.md#automations) owns shared syntax and
schedules. Codex supports this subset:

| Manifest field                                    | Codex behavior                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overrides.codex.effort`, `overrides.codex.model` | Independent jobs inherit omitted values from the ambient Codex home's top-level configuration at sync time. Named configuration profiles require explicit overrides. Later default changes appear as drift; native Codex decides model/effort availability.                                                 |
| `overrides.codex.target`                          | Defaults to an independent job in the one saved local project matching the bound workspace. `{ thread: existing-id }` selects an existing local chat there; model and effort overrides are rejected for these explicit chat targets.                                                                        |
| `prompt`, `payload`                               | Recurring prompts, including prompts asking a model to run a script.                                                                                                                                                                                                                                        |
| `run`                                             | Zero-model commands are unsupported, including `payload.kind: command`.                                                                                                                                                                                                                                     |
| `schedule`                                        | Whole-minute intervals from 1 to 1440 or whole-hour intervals from 1 to 999. Cron supports one minute every hour, or one daily time with daily, weekday, or month-day selection across all months. Multiple-job expressions and unsupported day-field combinations are rejected; one-shots are unsupported. |
| `schedule.timezone`                               | Omit or use `null` for native local time. Named IANA zones map directly to native `DTSTART;TZID=…` recurrence rules; UTC uses a UTC start. Available for every supported cron shape, including hourly. `native` is not accepted.                                                                            |
| `thread`                                          | Creates a persistent conversation per automation. Explicit model and effort overrides set initial native chat settings; later drift requires the native chat controls.                                                                                                                                      |
| `timeout-seconds`                                 | Unsupported. Native timeout, concurrency, retry, and catch-up rules apply.                                                                                                                                                                                                                                  |

Zoned creation and schedule edits require saving the native review card; a proposal
alone is not a synced automation. Unrelated edits preserve the saved recurrence.
Codex owns timezone evaluation, DST, and missed-run behavior. The adapter does not
expand calendars or translate named-zone clock times into UTC.

**Native timezone limitation:** in desktop version 26.1021.22027 (21747), the
inspected named-zone recurrence calculation depends on the scheduler host’s
timezone and can produce the wrong wall-clock time. Saving and retaining a zone
does not establish correct execution timing. This adapter preserves the requested
zone without compensating for that native defect or promising OpenClaw-identical
DST behavior.

Missing or ambiguous projects block planning; worktree bindings do not select the
parent checkout. Chat targets require a fresh native exact-chat read with active,
idle, running, or completed status. Explicit chat targets are not replaced or
rebound to the installer's conversation.

Codex uses ambient host credentials and native permissions; it does not resolve
OpenClaw credentials. Install selects the permissions described above for new
automation chats and preserves existing ready chats' permissions. Unavailable
models, accounts, app operations, or unattended permissions block completion. Saved definitions
prove persistence, not successful execution. Run-now, native occurrence history,
and execution/delivery telemetry are unavailable; a separately requested manual
task has its own history and does not prove native scheduling.

### Ownership and Recovery

Agent System owns jobs through markers and a private non-secret ledger. Native edits to
managed fields are drift; notification preferences remain native-owned. Unchanged jobs
receive no writes. Removed declarations pause jobs and retain history; reintroduced IDs
reuse them. Personal and Me jobs are not adopted by name. Inspection stops if the saved
data uses an unknown schema.

For `automation-thread-model-drift`, use the existing chat’s native controls to
apply the requested model and effort, then rerun Install. Settings-only app-server
updates do not persist across connections; Agent System does not claim success
from a transient update or replace the chat.

Interrupted writes require saved-state readback before retry; the install skill guides
recovery. Missing owned jobs or divergent state require investigation. Earlier verified
changes remain in place. Native UI edits made at the same time can conflict with
reconciliation; the two changes are not applied atomically. For
`automation-journal-busy`, confirm no reconciliation is running before removing only
the stale Agent System `.lock` directory. Never repair native scheduler files or delete
the ownership ledger.

See the [Codex automations example](https://github.com/tanaabased/openclaw-agent-system/blob/main/examples/codex-automations/README.md#automation-checks)
for conversation setup, headless planning, and recovery checks.

## Development

From a checkout with [locked dependencies installed](./DEVELOPMENT.md#requirements),
build and install through the pinned development dependency:

```sh
# build the runtime, then preview and install the local plugin.
bun run build
./node_modules/.bin/codex-tools install . --dry-run --json
./node_modules/.bin/codex-tools install .
```

Rebuild after changing the Codex runtime or its imports. For changes to
`.codex-plugin/`, `assets/`, `hooks/`, `package.json`, or `skills/`, sync the
installed cache directly:

```sh
bun run codex:sync
bun run codex:check
```

If a development build writes a changed persistent format, verify that any runtime
restored during cleanup can read the retained state. Cache equality alone does not
verify dispatch recovery.

Open a new chat to verify skill discovery. `package.json#codexTools.managedPaths`
selects the paths owned by cache synchronization and checks; it does not control
what native Codex copies during installation.

For packaged installation and discovery checks, run `bun run test:codex-plugin`
with `AGENT_SYSTEM_PACKAGE` set to a prepared npm tarball. The release-test
workflow runs this with an isolated Codex home. Other repository checks remain
in [Development](./DEVELOPMENT.md#testing).
