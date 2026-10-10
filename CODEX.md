# Codex

The standalone Codex plugin provides workspace context, setup, repository automations, and model routing
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
In Codex CLI with the same profile, use `/hooks` to [review and trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
the Agent System SessionStart hook, then start a fresh task.

```text
Use $agent-system-codex-binding to bind this plugin to /absolute/path/to/tanaab/me.
```

Confirm the binding, then start a fresh task and run:

```text
If the workspace declares setup, use $agent-system-install to install it.
Then use $agent-system-doctor to check readiness.
```

## Skills

Standalone Codex supports workspace context, [applicable setup steps](./MANIFEST.md#setup), and [repository automations](#repository-automations).
Git and GitHub use native host commands and authorization.

- [Codex binding](./skills/codex-binding/SKILL.md) — Bind the standalone plugin to one workspace.
- [Doctor](./skills/doctor/SKILL.md) — Inspect readiness without applying repairs.
- [Git CLI](./skills/git-cli/SKILL.md) — Guide native host Git operations.
- [GitHub CLI](./skills/github-cli/SKILL.md) — Guide native host GitHub operations.
- [Install](./skills/install/SKILL.md) — Apply Codex setup and synchronize declared automations through the native app.
- [Issue assessment](./skills/issue-assessment/SKILL.md) — Assess an admitted issue in its native worktree and retain a plan, questions, or a setup blocker.
- [Model routing](./skills/model-routing/SKILL.md) — Select model and effort candidates for new tasks.

## Model Routing

Declare model profiles in `agent.yaml`, then use
[the model routing skill](./skills/model-routing/SKILL.md) when starting new work:

```yaml
models:
  default: { model: openai/gpt-6-astra, effort: high }
  low: { model: openai/gpt-5.6-terra, effort: medium }
  medium: { model: openai/gpt-5.6-sol, effort: high }
  high: { model: openai/gpt-6-astra, effort: xhigh }
```

See [profile configuration](./MANIFEST.md#models) for field rules and
[model routing](./tools/model-routing/README.md) for selection and overrides.
Standalone Codex reads these profiles without changing OpenClaw configuration.
A mapped selection still needs native Codex support and application; it is not
proof that the model is available or that a task is using it.

## GitHub Notification Policy

Version 2 [notification policy](./MANIFEST.md#githubnotifications) supports issue-assignment
intake through one managed `github-issue-assignment` schedule and one retained chat,
`ISSUE ASSIGNMENTS`, displayed under `AGENT SYSTEM`. The automation is named
`📥 ISSUE ASSIGNMENTS` and uses the workspace’s `models.low` profile. Cadence follows
`interval-minutes`; the automation ID is reserved. Intake records eligible
assignments durably. After explicit reconciliation of the assessment-enabled
schedule, `plan` assignments can prepare repositories and create native issue chats
and worktrees in saved local Git-backed projects. Review requests, feedback, implementation, GitHub
publication, and OpenClaw v2 execution remain unavailable through this Codex path.

Use `$agent-system-install` to authorize and reconcile the chat and schedule in one
workflow. Install verifies a new chat's saved native approval settings and the saved
schedule; no global scanner allow rule or restart acknowledgment is required. Commands that need
approval still pass through native review, which can deny them.
Doctor verifies saved automation definitions; current chat permissions are not
exposed by the read-only native interface. Verify unattended execution separately
with a real scheduled poll. Intake uses
native host GitHub access; the authenticated account must match `github.username`
and applicable identity pins. Repository read access is sufficient. The first
successful activation establishes a historical baseline; reinstall and restart
retain it and deduplicate assignments by event identity.

Use `$agent-system-doctor` to inspect admitted issues, assigning actors, event IDs,
baseline, checkpoint, and blockers without contacting GitHub. Scheduled scans use
the trusted `intakeRuntime` from Agent System context. The assessment-enabled
schedule also revisits retained dispatch work through `dispatchRuntime`, even when
intake is unchanged. Unchanged combined results stay quiet. Records require fresh
authorization before execution; previous intake-only consent does not enable dispatch.

### Issue Assessment

Dispatch verifies the repository's full GitHub identity before selecting a saved
local project. An explicit
`git.worktrees.repositories.local.github-<repository-database-id>` mapping wins;
otherwise, optional `git.worktrees.repositories.working-directory` selects
`<directory>/<repository-name>`. A matching normal checkout is reused without
resetting user work; a missing checkout is cloned with native host Git authorization.
See [Git repository locations](./tools/git/README.md#gitworktrees) for path rules.

Without either location, dispatch first reuses a matching saved project. If none
exists, it prepares the managed bare repository and one stable detached base
checkout beneath the configured worktree root. That base is the project folder;
native Codex still creates the separate issue worktree. A configured path or clone
failure blocks preparation rather than choosing a different storage location.

The native interface currently has no supported saved-project registration action.
When registration is needed, dispatch reports the exact prepared checkout to add as
the primary folder of one saved local Codex project. The next scheduled occurrence
verifies it and resumes the retained assignment. Until that manual step, new-repository
dispatch is not unattended. Ambiguous projects, identity conflicts, and interrupted
clones retain actionable blockers rather than creating replacements.

Use Install to authorize and reconcile the repository-preparation schedule before
using this behavior; an older assessment schedule is insufficient. Changing repository
locations requires reconciliation again. Repository and checkout records survive
retries and restarts. Once the saved project is verified, dispatch refreshes the
default branch and pins the exact starting commit for the native issue worktree.

Bounded issue evidence and structured metadata inform the shared model router.
The saved model and effort are passed explicitly to native creation and retained
on continuation. Requested settings and verified effective settings remain distinct.
The issue chat performs read-only assessment and records one of three outcomes:
`plan-ready`, `clarification-needed`, or `operator-setup-blocker`, with evidence and
completed/remaining investigation. A user follow-up may revise the assessment in
the same chat. A result never authorizes implementation or publication.

Use [assessment selection](./MANIFEST.md#assessment-selection) under
`github.notifications.issue-assignment` to select an active skill and optional inline
or file guidance. Dispatch resolves the ID through native skill discovery and retains
the selected name, source path, instruction digest, and guidance snapshot. The child
verifies that same skill in its actual worktree before beginning. A missing or changed
skill blocks assessment; restore it and resume the retained chat rather than launching
another. The dispatch `context` response exposes the retained selection and guidance.
Replacement skills submit the same result contract and receive the same host-rendered
plan or questions. Guidance cannot widen the assessment's authority. Implementation
and review do not yet consume this selection.

Native creation receipts, chat identity, worktree, and results survive interrupted
polls. An uncertain creation is reconciled against native creation history; it is
never blindly repeated. Preserve the retained evidence when repairing access,
project setup, or host failures. Unresolved creations continue to consume capacity
until reconciled, preventing a succession of potentially live duplicate chats.
An unloaded app-server history is not live chat status. Dispatch retains pending
work rather than declaring a missing result from that history; it reports that
blocker only when native readback positively shows an idle chat with a terminal turn.
An abandoned chat whose live status is unavailable therefore needs operator inspection.
After verifying creation provenance, worktree,
and model settings, the runtime corrects a changed native title and verifies the rename
before assessment; the display title does not establish chat identity.

To repeat assessment through assignment intake, use `dispatchRuntime` with
`{"action":"reset","id":"<assessment-receipt>"}` from an operator chat, then repeat
with the returned `digest`. Reset requires a completed assessment and native confirmation
that its recorded result turn completed, with no later turn. It freezes the previous
result while preserving its chat and worktree; only a
new assignment event after reset permits a fresh dispatch. Reassignment alone does
not create another chat, and reset never authorizes implementation.

To remove a closed test issue from the queue, pause its schedule and send
`{"action":"retire","id":"<assessment-receipt>"}` from an operator chat. Repeat
with the returned `digest` to confirm. This preserves the launch and assessment
evidence, including failed launches. Archive the native chat and clean up its
worktree separately; retirement does neither. A fresh assessment requires a new
assignment event after retirement.

After an operator-confirmed denial, pause the schedule and use `dispatchRuntime`
with `{"action":"retry-denied","id":"<assessment-receipt>"}` from the operator chat.
The preview requires the exact native rejected call and no child or pending receipt.
Repeat with its returned `digest` to retain the denied attempt and permit fresh
preparation after resuming the schedule. Timeouts and unknown outcomes cannot use
this recovery path.
An automatic-review rejection additionally requires renewed operator approval for
the exact failed call. Supply its `approvedCallId` in both preview and apply, and
communicate that authorization to the intake chat before resuming. This field
records an approval already given; it does not grant one.
Packed/headless checks do not prove native desktop rendering or scheduled delivery;
those require a separately authorized installed-plugin occurrence.

Removing or revoking policy stops admission. Run authorized Install to pause the
owned job, including when the manifest is missing or invalid. Ownership and intake
evidence are retained for recovery; do not delete them to clear a blocker.
See [automation recovery](#ownership-and-recovery) for native write failures.

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
| `schedule.timezone`                               | `native` only. Native timing and DST behavior apply.                                                                                                                                                                                                                                                        |
| `thread`                                          | Creates a persistent conversation per automation. Explicit model and effort overrides set initial native chat settings; later drift requires the native chat controls.                                                                                                                                      |
| `timeout-seconds`                                 | Unsupported. Native timeout, concurrency, retry, and catch-up rules apply.                                                                                                                                                                                                                                  |

Missing or ambiguous projects block planning; worktree bindings do not select the
parent checkout. Chat targets require a fresh native exact-chat read with active,
idle, running, or completed status. Explicit chat targets are not replaced or
rebound to the installer's conversation.

Codex uses ambient host credentials and permissions; it does not resolve OpenClaw
credentials or change Codex permission settings. Unavailable models, accounts,
app operations, or unattended permissions block completion. Saved definitions
prove persistence, not successful execution. Run-now, native occurrence history,
and execution/delivery telemetry are unavailable; a separately requested manual
task has its own history and does not prove native scheduling.

### Ownership and Recovery

Agent System owns jobs through markers and a private non-secret ledger. Native
edits to managed fields are drift; notification preferences remain native-owned.
Unchanged jobs receive no writes. Removed declarations pause jobs and retain
history; reintroduced IDs reuse them. Personal and Me jobs are not adopted by name.
Unknown saved schemas stop inspection.

For `automation-thread-model-drift`, use the existing chat’s native controls to
apply the requested model and effort, then rerun Install. Settings-only app-server
updates do not persist across connections; Agent System does not claim success
from a transient update or replace the chat.

Interrupted writes require saved-state readback before retry; the install skill
guides recovery. Missing owned jobs or divergent state require investigation.
Earlier verified actions are not rolled back, and concurrent native UI edits are
not protected by atomic compare-and-swap. For `automation-journal-busy`, confirm
no reconciliation is running before removing only the stale Agent System `.lock`
directory. Never repair native scheduler files or delete the ownership ledger.

See the [Codex example](https://github.com/tanaabased/openclaw-agent-system/blob/main/examples/codex/README.md#automation-checks)
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

Start a fresh task to verify skill discovery. `package.json#codexTools.managedPaths`
selects the paths owned by cache synchronization and checks; it does not control
what native Codex copies during installation.

For packaged installation and discovery checks, run `bun run test:codex-plugin`
with `AGENT_SYSTEM_PACKAGE` set to a prepared npm tarball. The release-test
workflow runs this with an isolated Codex home. Other repository checks remain
in [Development](./DEVELOPMENT.md#testing).
