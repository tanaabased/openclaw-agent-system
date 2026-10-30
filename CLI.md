# CLI Reference

Commands for validating, installing, and inspecting agent workspaces. Start with
[README](./README.md#usage) for the common workflow and [Manifest Reference](./MANIFEST.md)
for declarations. `openclaw as` aliases `openclaw agent-system`; either bare
namespace prints help. Agent System human summaries honor `NO_COLOR` and
`FORCE_COLOR=0`; failed operations return nonzero.

Interactive prompts ask only for missing inputs. If a supported command option or
environment value already supplies an answer, the command uses it without asking again.
Separate decisions, such as confirmation, may still require a prompt.

**Core commands**

- [`openclaw agent-system automations list`](#openclaw-agent-system-automations-list) — Inspect saved automations and configuration drift.
- [`openclaw agent-system automations run`](#openclaw-agent-system-automations-run) — Queue one synchronized automation through the native scheduler.
- [`openclaw agent-system automations runs`](#openclaw-agent-system-automations-runs) — Read automation execution and delivery history.
- [`openclaw agent-system automations sync`](#openclaw-agent-system-automations-sync) — Reconcile declared automations with the native scheduler.
- [`openclaw agent-system backup cleanup`](#openclaw-agent-system-backup-cleanup) — Preview or remove abandoned temporary backup artifacts.
- [`openclaw agent-system backup create`](#openclaw-agent-system-backup-create) — Create a verified workspace and agent database archive.
- [`openclaw agent-system backup prune`](#openclaw-agent-system-backup-prune) — Remove older local archives according to retention settings.
- [`openclaw agent-system backup restore`](#openclaw-agent-system-backup-restore) — Recover an archive into a fresh directory for inspection.
- [`openclaw agent-system backup verify`](#openclaw-agent-system-backup-verify) — Verify an archive without extracting it.
- [`openclaw agent-system credentials cache flush`](#openclaw-agent-system-credentials-cache-flush) — Clear retained 1Password state in the Gateway.
- [`openclaw agent-system credentials cache status`](#openclaw-agent-system-credentials-cache-status) — Inspect the Gateway’s 1Password cache.
- [`openclaw agent-system credentials set op`](#openclaw-agent-system-credentials-set-op) — Verify and store the agent’s 1Password bootstrap credential.
- [`openclaw agent-system credentials unset op`](#openclaw-agent-system-credentials-unset-op) — Remove the agent’s stored 1Password bootstrap credential.
- [`openclaw agent-system credentials validate op`](#openclaw-agent-system-credentials-validate-op) — Check access to declared 1Password resources.
- [`openclaw agent-system doctor`](#openclaw-agent-system-doctor) — Inspect readiness and drift without applying repairs.
- [`openclaw agent-system env`](#openclaw-agent-system-env) — Inspect the resolved environment without printing values.
- [`openclaw agent-system install`](#openclaw-agent-system-install) — Reconcile the workspace’s declared configuration and setup.
- [`openclaw agent-system instance inspect`](#openclaw-agent-system-instance-inspect) — Inspect the installation UUID and readable name.
- [`openclaw agent-system instance rename`](#openclaw-agent-system-instance-rename) — Change the readable name while preserving the UUID.
- [`openclaw agent-system instance rotate`](#openclaw-agent-system-instance-rotate) — Replace the UUID and detach old assignment claims.
- [`openclaw agent-system tool`](#openclaw-agent-system-tool) — Run a registered command as the selected agent.
- [`openclaw agent-system validate`](#openclaw-agent-system-validate) — Validate a manifest without changing installed state.

<a id="openclaw-agent-system-notifications"></a>

**Component commands**

- [`openclaw agent-system notifications refresh`](./channels/github/CLI.md#openclaw-agent-system-notifications-refresh) — Request a run of the installed workflow.
- [`openclaw agent-system notifications reset`](./channels/github/CLI.md#openclaw-agent-system-notifications-reset) — Reset tracking, optionally purging managed resources.
- [`openclaw agent-system notifications status`](./channels/github/CLI.md#openclaw-agent-system-notifications-status) — Inspect retained workflow state.
- [`openclaw agent-system notifications wait`](./channels/github/CLI.md#openclaw-agent-system-notifications-wait) — Wait for a workflow checkpoint.
- [`openclaw agent-system tool gh`](./tools/github/README.md#cli) — GitHub CLI commands.
- [`openclaw agent-system tool git`](./tools/git/README.md#cli) — Run Git commands.
- [`openclaw agent-system tool gog`](./tools/google/README.md#openclaw-agent-system-tool-gog) — Google commands.
- [`openclaw agent-system tool worktree`](./tools/git/worktree/README.md#openclaw-agent-system-tool-worktree----list) — List, prepare, or remove managed worktrees.

**Execution reference**

- [Credential storage](#credential-storage)
- [Trust boundary](#trust-boundary)
- [Scheduler callback](#scheduler-callback)

## `openclaw agent-system automations list`

Compare declared and saved native settings, including disabled jobs, and report drift
without changing anything.

### Options

| Option or argument | Required | Default             | Description                                |
| ------------------ | -------- | ------------------- | ------------------------------------------ |
| `--agent <id>`     | no       | workspace discovery | Select an installed agent; operators only. |
| `--json`           | no       | off                 | Write one structured result to stdout.     |

### Usage

```text
openclaw agent-system automations list [--agent <id>] [--json]
```

```sh
openclaw agent-system automations list --json
```

The command exits zero when saved jobs match the manifest. Drift, unsupported settings, or execution and delivery warnings return `attention` and exit 1. Jobs excluded from this runtime appear as inapplicable. Results include native IDs and enabled state, without payloads or provider error text.

## `openclaw agent-system automations run`

Queue one enabled, synchronized owned job by manifest ID through the native scheduler.

### Options

| Option or argument | Required | Default             | Description                                          |
| ------------------ | -------- | ------------------- | ---------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Select an installed agent; operators only.           |
| `--json`           | no       | off                 | Write one structured result to stdout.               |
| `<id>`             | yes      | none                | Manifest automation ID, never a native scheduler ID. |

### Usage

```text
openclaw agent-system automations run <id> [--agent <id>] [--json]
```

```sh
openclaw agent-system automations run review --json
```

`queued` exits zero and returns `runId`: the scheduler accepted the request, but the
run may still be pending. Inspect it with `runs --run-id`. Missing, disabled, already
consumed, drifted, or unowned jobs are rejected; native skips exit 1. The command does
not sync or retry automatically. A native UI edit after the preflight check can still
change what runs.

## `openclaw agent-system automations runs`

Read execution and delivery history by manifest ID, including saved history for removed jobs.

### Options

| Option or argument | Required | Default             | Description                                          |
| ------------------ | -------- | ------------------- | ---------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Select an installed agent; operators only.           |
| `--json`           | no       | off                 | Write one structured result to stdout.               |
| `--limit <count>`  | no       | `50`                | Maximum entries, from 1 to 200.                      |
| `--offset <count>` | no       | `0`                 | Nonnegative history offset.                          |
| `--run-id <id>`    | no       | none                | Filter the exact native occurrence.                  |
| `<id>`             | yes      | none                | Manifest automation ID, never a native scheduler ID. |

### Usage

```text
openclaw agent-system automations runs <id> [--agent <id>] [--json] [--limit <count>] [--offset <count>] [--run-id <id>]
```

```sh
openclaw agent-system automations runs review --limit 20 --json
```

Command-report status is separate in `reports`, with count `reportsTotal`.
`--offset` and `--limit` page both lists; `--run-id` filters native entries only.
Observed model settings may be absent. History reads never retry work; completion
snapshots may still say pending after delivery. See [reporting and recovery](./MANIFEST.md#openclaw-execution-and-ownership).

Each entry reports execution and delivery independently. Missing telemetry is `unavailable`; raw output and errors are omitted. The result includes `total`, `offset`, `limit`, `hasMore`, and `nextOffset`. Pass `nextOffset` to read another page. Native history clamps an offset beyond the result count to that count.

## `openclaw agent-system automations sync`

Update Agent System-owned automations through the same service as operator Install.

### Options

| Option or argument | Required | Default             | Description                                |
| ------------------ | -------- | ------------------- | ------------------------------------------ |
| `--agent <id>`     | no       | workspace discovery | Select an installed agent; operators only. |
| `--json`           | no       | off                 | Write one structured result to stdout.     |

### Usage

```text
openclaw agent-system automations sync [--agent <id>] [--json]
```

```sh
openclaw agent-system automations sync --json
```

Sync leaves unchanged jobs alone and follows the
[automation ownership and recovery rules](./MANIFEST.md#openclaw-execution-and-ownership).
A failed sync exits 1 and retains verified progress and pending recovery. This command
does not run unrelated install or setup steps.

### Repository examples

A prompt review can apply to both runtimes where the schedule is supported:

```yaml
automations:
  - id: review
    schedule: every 24 hours
    prompt: Review the latest repository changes and report actionable findings.
```

For a deterministic backup, declare an OpenClaw command:

```yaml
automations:
  - id: backup
    runtimes: [openclaw]
    schedule: every 24 hours
    run: [openclaw, agent-system, backup, create, --json]
```

Configure [backup selection](./MANIFEST.md#backup), then use the
[backup commands](#openclaw-agent-system-backup-create) for verification and
retention. For Codex automation support, see the [supported fields](./MANIFEST.md#codex-execution-and-ownership).

## `openclaw agent-system backup cleanup`

Preview abandoned temporary backup artifacts. Deletion requires an explicit operator
request and proof that each artifact belongs to the backup process, is inactive, and is
incomplete.

### Options

| Option or argument | Required | Default             | Description                                 |
| ------------------ | -------- | ------------------- | ------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Select an installed agent (operators only). |
| `--apply`          | no       | off                 | Apply eligible cleanup; operator-only.      |
| `--json`           | no       | off                 | Write one structured result to stdout.      |

### Usage

```text
openclaw agent-system backup cleanup [--agent <id>] [--apply] [--json]
```

```sh
# inspect one agent without changing files or acquiring a lock.
openclaw agent-system backup cleanup --agent emori --json

# explicitly remove only that agent's eligible incomplete artifacts.
openclaw agent-system backup cleanup --agent emori --apply --json
```

Results identify `wouldDelete`, `deleted`, and `preserved` paths with refusal reasons.
If cleanup partially fails, results identify what was removed and what remains.
Cleanup and capture cannot run concurrently; cleanup rechecks ownership and file
identity before deleting anything.

Completed or plausibly complete archives, unknown contents, active or uncertain writers,
and legacy artifacts without ownership records are preserved. Snapshot-command failures
may leave writer activity uncertain even after the parent exits; age alone never permits
cleanup. Bound agent commands may preview only their own workspace, without `--agent`.

Cleanup does not resume backups, reset wrapper locks or journals, inspect providers, or
prune published archives. It is separate from running a backup and does not establish
backup success. For failed automation execution, inspect its owned history with
`openclaw agent-system automations runs <id> --agent <id> --json`.

## `openclaw agent-system backup create`

Capture selected workspace files and, by default, the selected agent's OpenClaw
SQLite database in a private, verified `.tar.gz`.

> [!WARNING]
> Backups can contain credentials and session data. If the destination is inside
> your workspace, add it to `.gitignore`—for the default, use `.agent-system/backups/`.
> Creation adds a local `.git/info/exclude` rule when needed; a committed
> `.gitignore` rule also protects future clones.

### Options

| Option or argument           | Required | Default                             | Description                                                                                    |
| ---------------------------- | -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--agent <id>`               | no       | workspace discovery                 | Select an installed agent; operators only.                                                     |
| `--dry-run`                  | no       | off                                 | Report settings and selection without writing any files, ignore rules, locks, or staging.      |
| `--exclude <patterns...>`    | no       | manifest or `[]`                    | Repeatable globs applied last; replace the manifest list. `--exclude=` clears it.              |
| `--git-ignore[=true\|false]` | no       | manifest or `false`                 | Bare flag means `true`; omission inherits the manifest.                                        |
| `--include <patterns...>`    | no       | manifest or `[]`                    | Repeatable quoted workspace-relative globs; replace the manifest list. `--include=` clears it. |
| `--json`                     | no       | off                                 | Write one structured result, including failures.                                               |
| `--openclaw-state <mode>`    | no       | manifest or `auto`                  | `auto` captures an existing agent database; `required` also fails if absent; `off` omits it.   |
| `--output <directory>`       | no       | manifest or `.agent-system/backups` | Resolve relative destinations against the discovered workspace.                                |

### Usage

```text
openclaw agent-system backup create [--agent <id>] [--output <directory>]
  [--openclaw-state <auto|required|off>]
  [--git-ignore[=true|false]] [--include <patterns...>] [--exclude <patterns...>]
  [--dry-run] [--json]
```

```sh
# inspect selected private memory before capturing it.
openclaw as backup create --dry-run --json --git-ignore \
  --include 'MEMORY.md' 'memory/**' --include 'DREAMS.md' 'GOALS.md' \
  --exclude 'scratch/**'

# capture workspace files and any existing agent database.
openclaw agent-system backup create --json

# clear configured exclusions and turn off git-ignore filtering.
openclaw as backup create --exclude= --git-ignore=false
```

Selection skips `**/node_modules/**`, `**/.npm/_cacache/**`, and
`**/.eslintcache` unless explicitly included. Optional Git-ignore filtering runs before includes; excludes
run last. Git-ignore requires a repository and retains tracked files. Includes
can recover ignored files but cannot override mandatory exclusions. Use safe
workspace-relative patterns with `/`: exact paths must exist, provably unmatched globs
produce diagnostics, and selected special files fail.

Default and selected destinations and `.agent-system/backup-staging` are always
excluded, including path aliases. Exclude previous custom destinations explicitly.
Only relative links to selected targets are archived.

Operators may choose local destinations. Bound callers cannot set `--agent` and
may use only their workspace or configured external destination. Host-resolved
workspaces inside OpenClaw state are supported, but destinations cannot contain
the workspace or use runtime-only state or Git metadata. Git destinations must
be untracked and ignored.

Verified archives use mode `0600` and contain `manifest.json`, `workspace/`,
and, when captured, `openclaw-state/manifest.json` and
`openclaw-state/database.sqlite`. The database snapshot includes committed WAL
data, memory indexes, and embeddings. Capture or verification failures abort
publication; `auto` records an absent database, while `off` records an omission.
Inspect the root manifest for coverage, versions, and snapshot details.

Workspace and database capture are not atomic together. Other OpenClaw state,
out-of-workspace sources, and external memory backends are excluded. Setup
applies may create backups; checks may only preview or verify. Uploads and
scheduling are not provided.

## `openclaw agent-system backup prune`

Keep the newest local archives for the selected agent by embedded capture time.
Run only after the exact archive returned by creation has been verified and
successfully uploaded; this command does not upload or schedule backups.

### Options

| Option or argument     | Required | Default                             | Description                                                   |
| ---------------------- | -------- | ----------------------------------- | ------------------------------------------------------------- |
| `--agent <id>`         | no       | workspace discovery                 | Select an installed agent; operators only.                    |
| `--dry-run`            | no       | off                                 | Report the same retention decision without writing any state. |
| `--json`               | no       | off                                 | Write one structured result, including failures.              |
| `--keep <count>`       | yes      | none                                | Positive integer number of eligible archives to retain.       |
| `--output <directory>` | no       | manifest or `.agent-system/backups` | Resolve relative destinations against the selected workspace. |

### Usage

```text
openclaw agent-system backup prune --keep <positive-integer>
  [--agent <id>] [--output <directory>] [--dry-run] [--json]
```

```sh
# preview local retention after a successful backup upload.
openclaw as backup prune --keep 3 --dry-run --json

# remove only eligible older local archives.
openclaw as backup prune --keep 3 --json
```

Only immediate regular `.tar.gz` files with valid embedded v1/v2 metadata for
the selected agent are eligible. Ties use filename order. Unreadable or unrelated
entries, subdirectories, links, and pending writes are skipped with reasons.
Retention checks archive identity and capture metadata, not payload integrity or
compatibility with the installed OpenClaw database schema.

> [!WARNING]
> A `kept` archive can still have a damaged payload. Run `backup verify` to check
> integrity and `backup restore` to check recovery before relying on it.

Historical database schemas alone do not block pruning, and archived databases are never migrated. Apply coordinates
with creation and stops if the candidate set changes.
JSON reports `kept`, `deleted`, `wouldDelete`, and `skipped`; failures
return nonzero and include any deletions already completed. Bound callers keep
the same destination and agent restrictions as creation. Setup checks allow only
`--dry-run`.

## `openclaw agent-system backup restore`

Verify and recover one agent archive into a fresh private directory for operator
inspection. Recovery does not register or activate the agent.

### Options

| Option or argument     | Required | Default | Description                                                    |
| ---------------------- | -------- | ------- | -------------------------------------------------------------- |
| `--agent <id>`         | no       | none    | Require this recorded agent identity.                          |
| `--json`               | no       | off     | Write one structured result, including failures.               |
| `--target <directory>` | yes      | none    | Absent or empty private recovery directory outside live state. |
| `<archive>`            | yes      | none    | Local backup archive path.                                     |

### Usage

```text
openclaw agent-system backup restore <archive> --target <fresh-directory>
  [--agent <id>] [--json]
```

```sh
# stage one verified backup for inspection without changing the running agent.
openclaw as backup restore /private/backups/agent-backup.tar.gz \
  --target /private/recovery/agent-review --json
```

The target must have an existing parent and must be absent or an empty private
directory. Live agent workspaces and OpenClaw state paths are refused, including
path aliases; there is no overwrite or in-place mode. The restored layout is
`manifest.json`, `workspace/`, and, when captured,
`openclaw-state/openclaw-agent.sqlite`. Workspace file permissions and safe
relative links are retained. OpenClaw verifies and restores its database
snapshot through its supported SQLite restore command. Version 1 and other
workspace-only archives produce no database; output reports coverage and
omissions. Failed recovery removes only content created by the current attempt,
preserving the source archive and any pre-existing empty target. Only operators
may restore; agent and setup descendants cannot invoke this command.

Activation is a separate offline operator action. Stop the relevant runtime
before moving recovered data into place, and review restored authentication and
session state before starting it again.

## `openclaw agent-system backup verify`

Read and verify a workspace archive without extracting it or changing a live
workspace. Operators can verify an archive without an installed workspace.

### Options

| Option or argument | Required | Default | Description                                                   |
| ------------------ | -------- | ------- | ------------------------------------------------------------- |
| `--agent <id>`     | no       | none    | Require this recorded agent identity; operators only.         |
| `--json`           | no       | off     | Write one structured verification result, including failures. |
| `<archive>`        | yes      | none    | Local `.tar.gz` path, relative to the current directory.      |

### Usage

```text
openclaw agent-system backup verify <archive> [--agent <id>] [--json]
```

```sh
# verify a private per-agent artifact without restoring it.
openclaw as backup verify /private/backups/agent-backup.tar.gz --json
```

Verification checks versions, manifests, paths, links, entry types, inventory,
permissions, and checksums. Selection supports 100,000 selected workspace entries,
including structural parent directories; the root manifest
is limited to 16 MiB. Bound callers may verify only their agent's archives within
their workspace or configured destination. Success returns `status: verified`;
failure returns `status: failed` and nonzero exit.
When an archive contains `openclaw-state/`, verification checks its strict
layout, checksums, and OpenClaw's database integrity and owner contract from a
private temporary copy. Older workspace-only archives remain verifiable.
Checksums verify internal integrity, not authenticity or completeness of omitted
state. Inspect the root manifest's coverage before relying on the artifact.

## `openclaw agent-system credentials cache flush`

Clear the running Gateway's cached 1Password clients and values.

### Options

| Option or argument | Required | Default    | Description                                        |
| ------------------ | -------- | ---------- | -------------------------------------------------- |
| `--agent <id>`     | no       | all agents | Limit invalidation to one agent.                   |
| `--json`           | no       | off        | Write one undecorated structured result to stdout. |

### Usage

```text
openclaw agent-system credentials cache flush [--agent <id>] [--json]
```

```sh
# invalidate one agent’s cached values.
openclaw agent-system credentials cache flush --agent tanaabot --json
```

Requires `operator.admin`. An unreachable or unauthorized Gateway fails; a
local clear is not Gateway success. Flush does not reset provider backoff or
quota. See [cache configuration](./CONFIG.md#opcache).

## `openclaw agent-system credentials cache status`

Inspect the running Gateway’s 1Password cache without reading 1Password.

### Options

| Option or argument | Required | Default | Description                                        |
| ------------------ | -------- | ------- | -------------------------------------------------- |
| `--json`           | no       | off     | Write one undecorated structured result to stdout. |

### Usage

```text
openclaw agent-system credentials cache status [--json]
```

```sh
# inspect cache policy, occupancy, expiry, backoff, and counters.
openclaw agent-system credentials cache status --json
```

Requires `operator.read`. Status always covers the Gateway; it has no agent
selector and returns no secrets. An unreachable or unauthorized Gateway fails.

## `openclaw agent-system credentials set op`

Verify and store the agent-scoped credential for declared 1Password resources.

### Options

| Option or argument | Required | Default             | Description                                                                         |
| ------------------ | -------- | ------------------- | ----------------------------------------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Use the exact configured workspace for an installed OpenClaw agent.                 |
| `--from-env`       | no       | off                 | Read `OP_SERVICE_ACCOUNT_TOKEN`; mutually exclusive with `--stdin`.                 |
| `--stdin`          | no       | off                 | Read redirected input without exposing it in arguments.                             |
| `--store <id>`     | no       | automatic           | Select `keychain`, `secret-service`, or `file`; see [storage](#credential-storage). |

### Usage

```text
openclaw agent-system credentials set op [--agent <id>] [--from-env | --stdin] [--store <id>]
```

```sh
# verify and persist the current bootstrap token for this agent.
openclaw agent-system credentials set op --from-env
```

Without an input option, `set` uses a masked interactive prompt and fails with
guidance in a noninteractive session. Tokens are never accepted as command
arguments. Every set path verifies access to all declared 1Password resources
before storage.

## `openclaw agent-system credentials unset op`

Remove the agent’s persisted 1Password bootstrap credential.

### Options

| Option or argument | Required | Default               | Description                                                                         |
| ------------------ | -------- | --------------------- | ----------------------------------------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery   | Use the exact configured workspace for an installed OpenClaw agent.                 |
| `--store <id>`     | no       | all persistent stores | Select `keychain`, `secret-service`, or `file`; see [storage](#credential-storage). |

### Usage

```text
openclaw agent-system credentials unset op [--agent <id>] [--store <id>]
```

```sh
# remove this agent’s saved credential and request cache invalidation.
openclaw agent-system credentials unset op
```

Removing an already-absent credential is safe. Removal also asks the Gateway to clear its cache. It does not
change the process-environment fallback. See [cache configuration](./CONFIG.md#opcache)
for pending invalidation and flush behavior.

## `openclaw agent-system credentials validate op`

Check the agent’s credential against every 1Password resource declared in its manifest.

### Options

| Option or argument | Required | Default             | Description                                                                         |
| ------------------ | -------- | ------------------- | ----------------------------------------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Use the exact configured workspace for an installed OpenClaw agent.                 |
| `--from-env`       | no       | off                 | Validate only `OP_SERVICE_ACCOUNT_TOKEN` from the process environment.              |
| `--store <id>`     | no       | automatic           | Select `keychain`, `secret-service`, or `file`; see [storage](#credential-storage). |

### Usage

```text
openclaw agent-system credentials validate op [--agent <id>] [--from-env | --store <id>]
```

```sh
# check the stored credential without replacing it.
openclaw agent-system credentials validate op
```

Validation checks the persistent stores in [storage order](#credential-storage),
then the process fallback. An exact `--store` or `--from-env` disables fallback.

## `openclaw agent-system doctor`

Inspect registration, identity, models, memory, paths, and configured capabilities
without applying repairs. `openclaw agent-system status` is an alias.

Doctor also reports automation drift, disabled or completed jobs, unsupported targets,
and execution or delivery failures. Managed-chat model drift includes requested and
observed model/effort; denied or uncertain updates retain their recovery state.
Doctor never applies those changes. Scheduler inspection requires the operator's
native read permission; it does not change or run jobs.

When Codex is required, the `codex-plugin` component reports the shared
prerequisite as ready, missing, disabled, incompatible, or conflicting. It uses
metadata-only OpenClaw inspection without installing, enabling, or loading the
Codex runtime. Otherwise Doctor omits the component and leaves an unrelated
shared installation untouched.

### Options

| Option or argument | Required | Default             | Description                                                         |
| ------------------ | -------- | ------------------- | ------------------------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Use the exact configured workspace for an installed OpenClaw agent. |
| `--json`           | no       | off                 | Write one undecorated structured result to stdout.                  |

### Usage

```text
openclaw agent-system doctor [--agent <id>] [--json]
```

```sh
# inspect an installed agent and its declared setup checks.
openclaw agent-system doctor --agent tanaabot --json
```

Ordinary Doctor also inspects collaboration membership, effective entries, and
configuration drift without repairing state.

Doctor reports all findings and returns nonzero for failing drift. It recommends
`install` for settings Agent System owns; you must repair manually managed settings
separately.
Tool-specific checks live in the respective guides.

For [setup](./MANIFEST.md#setup), Doctor runs applicable checks without consent or repairs,
marks unchecked steps as manual, and skips other runtimes.

> [!NOTE]
> OpenAI memory inspection makes one bounded embedding request, which may incur
> a small provider charge. Other providers are inspected without a live probe.

## `openclaw agent-system env`

Inspect the resolved Agent System environment without printing values or predicting another tool’s environment.

### Options

| Option or argument | Required | Default             | Description                                                         |
| ------------------ | -------- | ------------------- | ------------------------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Use the exact configured workspace for an installed OpenClaw agent. |
| `--json`           | no       | off                 | Write one undecorated structured result to stdout.                  |

### Usage

```text
openclaw agent-system env [--agent <id>] [--json]
```

```sh
# inspect variable names and sources for one installed agent.
openclaw agent-system env --agent tanaabot --json
```

Output lists variable names, sources, required state, and override counts; values stay private.

## `openclaw agent-system install`

Apply the workspace agent's identity, models, memory, paths, capabilities, and setup.
Install also updates repository [automations](./MANIFEST.md#automations). Use [`automations sync`](#openclaw-agent-system-automations-sync)
to reconcile automation jobs alone, including saved model/effort on existing managed
chats. Busy chats may need a later Install; denied or uncertain attempts are not
replayed. See [model settings and recovery](./MANIFEST.md#automations).
Automation reconciliation requires a running
Gateway. If initial scheduler discovery cannot reach it, Install continues with
an `automation-sync-deferred` warning and skipped outcome; scheduler state remains
unverified and unchanged. Rerun Install or `automations sync` when the Gateway is available. Explicit sync, invalid declarations, authorization and
ownership failures, and failed read-back remain errors. Completed one-shots and
native safety disable remain protected; failed synchronization reports partial results.

### Options

| Option or argument          | Required | Default | Description                                                                                          |
| --------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `--json`                    | no       | off     | Write one undecorated structured result to stdout.                                                   |
| `--non-interactive`         | no       | off     | Run without prompts, implying setup consent.                                                         |
| `--rebuild-codex-path`      | no       | off     | Replace the saved Codex PATH baseline with this process environment; see [Path](./MANIFEST.md#path). |
| `--manual-session-dispatch` | no       | off     | Enroll session access for manual issue launch with explicit consent, without enabling intake.        |
| `--skip-setup`              | no       | off     | Skip all setup checks and applies; other components still install.                                   |
| `--skip-setup-agent`        | no       | off     | Skip agent setup checks and applies; other components still install.                                 |
| `--skip-setup-host`         | no       | off     | Skip host setup checks and applies; other components still install.                                  |
| `--yes`                     | no       | off     | Accept installation, including required session dispatch enrollment, without prompting.              |

### Usage

```text
openclaw agent-system install [--yes] [--non-interactive] [--manual-session-dispatch] [--skip-setup] [--skip-setup-host] [--skip-setup-agent] [--rebuild-codex-path] [--json]
```

```sh
# review and apply the current workspace configuration.
openclaw agent-system install

# explicitly consent to installation and required enrollment without prompts.
openclaw agent-system install --yes --json
```

Ordinary installs reconcile [collaboration](./CONFIG.md#collaboration), preserving
operator grants while enabling selected participants as needed. Re-run install
from a managed workspace after selection or registration changes. See the
configuration reference for cleanup before deleting the final managed agent.

Before applying setup or agent settings, Install checks the OpenClaw host and shared
Codex prerequisite only when the workspace declares
[`agent.runtime: codex`](./MANIFEST.md#agent) or this agent has an effective
Codex runtime binding. The plugin version is pinned in Agent System's
`package.json#openclaw.agentSystem.codexPlugin`. It installs a missing plugin,
enables a matching disabled installation, and reuses a matching installation across
agents in the same profile. Codex remains a separate OpenClaw-managed
package and owns its app-server dependency. Setup-skip flags do not skip this
prerequisite. Standalone Codex installation does not provision it.

If the shared plugin's version or source conflicts, Install stops and shows the expected
and actual versions. Inspect it with `openclaw plugins inspect codex --json`, then update
the shared plugin through OpenClaw before retrying. Installing another agent does not
silently replace it. Failures report exit details and a failure category without raw
upstream output.

After reviewing the shared installation, an operator can explicitly select the
declared release through OpenClaw:

```sh
openclaw plugins inspect codex --json
openclaw plugins install npm:@openclaw/codex@2026.10.6 --force --pin --accept-capabilities
```

`--skip-setup` skips both phases regardless of consent; combining the two phase
flags has the same effect. Other components still reconcile and enforce their
executable, credential, and identity checks.

Interactive installation previews applicable commands, shells, and timeouts on stderr.
Declining or cancelling stops before any changes. No applicable setup means no setup
prompt; required session dispatch enrollment has its own consent preview.

Unattended setup consent comes from `--yes`, `--non-interactive`, noninteractive stdin,
or a truthy `CI` or `NONINTERACTIVE` value. `--json` alone grants no consent; prompts
and warning diagnostics stay on stderr. Consent is not saved for later runs.

When enabled OpenClaw issue-assignment or review-request policies require session
dispatch, Install lists those consumers and discloses `operator.read` and
`operator.write` before enrollment. These grants are broader than sessions-only
access. Explicit `--yes` accepts enrollment; `--non-interactive`, CI, or missing
stdin alone do not. The UI uses the existing Install Allow once approval and
requires a verified owner. A missing or unusable credential blocks enrollment-
dependent installation; unsupported review execution remains a separate finding.

Install saves one device identity for the Gateway in macOS Keychain or Linux Secret
Service, with no file-store fallback. Enrollment supports a local, non-TLS Gateway.
If manual pairing is required, approve the exact request in Devices or with
`openclaw devices approve <requestId>`, then rerun Install. Later installs reuse the
credential, and disabling one workflow keeps it available to other agents.
Doctor checks enrollment without issuing credentials.
For revoked credentials, remove the retained device and any pending request in
Devices, then rerun Install with enrollment consent to replace the retained
identity. There is no separate session-dispatch reset command. Credential
readiness alone does not establish end-to-end issue or review dispatch.

For enrollment connection failures, check Gateway availability and rerun Install to
resume with the same device identity. A connection failure does not require replacing
it. Gateway rejection or pending pairing needs the reported recovery action, including
approval of the exact device request. Install waits for Gateway startup or reload, not
unrelated channel health. It does not retry authentication rejection or uncertain writes.

Human diagnostics and `blocked.sessionDispatchDiagnostic` in JSON include the failure
category, phase, and reason code when known. `unknown` means the evidence is unavailable.
`gateway-readiness-deadline` means the readiness wait expired; `gateway-reload-failed`
means plugin replacement failed. Both include available startup or reload details in
`readinessEvidence`, without raw responses, errors, or credentials. Use that evidence
to investigate rather than assuming a timeout cause. See the
[enrollment verification example](./examples/os-dispatch-enrollment/README.md).

If installation fails, the command exits nonzero and reports what completed, what
blocked it, and what has not been attempted. Earlier changes remain applied. Fix the
reported blocker, then rerun Install. With `--json`, stdout contains one
failure object with `status: "failed"`, `outcomes`, `blocked`, and `unattempted`.
Automation Gateway failures also report allowlisted evidence in
`blocked.automationGatewayDiagnostic` and the human diagnostic: the failed method,
failure category, Gateway or close code, and whether the request was dispatched.
Unavailable values remain `null` or `unknown`; dispatch does not prove an operation
completed. Raw upstream errors and connection details are excluded.

> [!NOTE]
> Environment flags accept trimmed, case-insensitive `1`, `true`, `yes`, or `on`.
> Other values do not enable consent or cancel another enabling source.
> Unattended runs trust the current declarations, including changes since the last run.

Installation:

- Validates declarations and requires persistent credentials for declared 1Password resources before mutation.
- Verifies owned state, reporting already reconciled components as unchanged. Setup follows its [check and retry rules](./MANIFEST.md#checks-installation-and-retries).
- Rejects an agent id already bound to another workspace.
- Reconciles manifest-selected Git, worktree, GitHub, and Google tool grants while preserving unrelated grants.
- Reconciles an agent-scoped GitHub managed profile when account and credential bindings are explicit.

Operator-owned tool denials and unmarked conflicting profiles block reconciliation.

## `openclaw agent-system instance inspect`

Inspect this installation's persisted UUID and readable name without changing state.
Install creates them once and preserves them on later runs; Doctor reports missing
or invalid identity. Identity belongs to the runtime installation, outside `agent.yaml`.

### Options

| Option or argument | Required | Default | Description                                                          |
| ------------------ | -------- | ------- | -------------------------------------------------------------------- |
| `--json`           | no       | off     | Return the full UUID and readable name. Human output masks the UUID. |

### Usage

```sh
openclaw agent-system instance inspect --json
```

## `openclaw agent-system instance rename`

Customize the readable name while preserving the UUID and existing ownership.
Names normalize to lowercase hyphenated text, up to 48 characters. Generated names
use an adjective and animal; names need not be unique because the UUID selects ownership.

### Options

| Option or argument | Required | Default | Description                          |
| ------------------ | -------- | ------- | ------------------------------------ |
| `<name>`           | yes      | none    | Readable instance name.              |
| `--json`           | no       | off     | Write the complete identity receipt. |

### Usage

```sh
openclaw agent-system instance rename 'Office Laptop' --json
```

## `openclaw agent-system instance rotate`

Explicitly replace the UUID, preserving the readable name and detaching old claim
receipts. Use this after copying an installation onto another machine. Rotation
neither transfers active work nor edits existing GitHub claims; the original owner
keeps its work. A repeated request using the old UUID fails as stale.

### Options

| Option or argument   | Required | Default | Description                                       |
| -------------------- | -------- | ------- | ------------------------------------------------- |
| `--expected-id <id>` | yes      | none    | Full current UUID from `instance inspect --json`. |
| `--json`             | no       | off     | Write the new complete identity receipt.          |

### Usage

```sh
current_id=$(openclaw agent-system instance inspect --json | jq -r .instanceId)
openclaw agent-system instance rotate --expected-id "$current_id" --json
```

## `openclaw agent-system tool`

Run a registered command as the selected agent. This is an operator interface;
agents use the corresponding native `agent_system_*` tool.

### Options

| Option or argument  | Required | Default             | Description                                                         |
| ------------------- | -------- | ------------------- | ------------------------------------------------------------------- |
| `-- <arguments...>` | yes      | none                | Pass the remaining arguments to the selected command.               |
| `--agent <id>`      | no       | workspace discovery | Use the exact configured workspace for an installed OpenClaw agent. |
| `<command>`         | yes      | none                | Use a **Command** value from the table below.                       |

### Usage

```text
openclaw agent-system tool <command> [--agent <id>] -- <arguments...>
```

```sh
# verify the configured github identity of one installed agent.
openclaw agent-system tool gh --agent tanaabot -- api user --jq .login
```

| ID                          | Command    | CLI                                                              | Shim                                                               |
| --------------------------- | ---------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `agent_system_git`          | `git`      | [Usage](./tools/git/README.md#cli)                               | [Packaged shim](./tools/git/README.md#shim)                        |
| `agent_system_git_worktree` | `worktree` | [Usage](./tools/git/worktree/README.md#cli)                      | none                                                               |
| `agent_system_github`       | `gh`       | [Usage](./tools/github/README.md#cli)                            | [Packaged shim](./tools/github/README.md#shim)                     |
| `agent_system_google`       | `gog`      | [Usage](./tools/google/README.md#openclaw-agent-system-tool-gog) | [Packaged shim](./tools/google/README.md#gog-and-agent_system_gog) |

## `openclaw agent-system validate`

Discover and validate a manifest without resolving credentials, inspecting installed or remote state, or applying changes.

### Options

| Option or argument | Required | Default             | Description                                                         |
| ------------------ | -------- | ------------------- | ------------------------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Use the exact configured workspace for an installed OpenClaw agent. |
| `--json`           | no       | off                 | Write one undecorated structured result to stdout.                  |

### Usage

```text
openclaw agent-system validate [--agent <id>] [--json]
```

```sh
# validate the current workspace manifest without changing state.
openclaw agent-system validate --json
```

## Credential Storage

Automatic persistent selection prefers Keychain then file on macOS and Secret
Service then file on Linux. An explicit `--store` selects only that store.

The file fallback lives at
`$XDG_CONFIG_HOME/tanaab/agent-system/<agent-id>/op-token`, or under
`$HOME/.config` when `XDG_CONFIG_HOME` is unset. Agent System requires owner-only
directories, mode `0600`, and a regular non-symlinked credential file.

## Trust Boundary

Model-facing `agent_system_*` tools bind the manifest and credentials to trusted
OpenClaw agent context. They remain the preferred direct execution path for
agents.

Packaged `git` and `gh` automatically use managed execution when the working
directory resolves to a valid installed agent; an active session is not required.
When an active agent supplies command authority, its identity takes precedence
and cannot change through directory changes. Host fallback applies when no agent
manifest is found or a valid active-agent command leaves its admitted directories.
Another known agent's workspace remains denied for that active agent.

Managed setup and command automations pass their remaining configured execution
budget to CLI descendants, including time already spent preparing the request.
Direct Git metadata probes have a 30-second allowance, local repository work two
minutes, and transfers ten minutes. Direct GitHub and Google data commands use
the existing ten-minute command allowance; identity preflights remain bounded to
30 seconds. Process termination allows five seconds for cleanup. A timeout does
not prove that a remote write was rejected; reconcile the original operation
before attempting another write.

Host fallback removes agent credentials, authority, and configuration overrides;
host tools may use their normal configuration files. Invalid authority, invalid
agent configuration, and managed command failures remain errors. Explicit managed
launchers and Agent System's `worktree` route never fall back. Direct `tool` and
`credentials` commands remain trusted operator interfaces and may select an
installed agent explicitly.

Strict launcher bindings exist only in Agent System-owned child environments,
not login shells, repository config, or manifest environment output. They are
executable paths, not credentials or authority capabilities, and require valid
active-agent authority. Classification, policy, credential, containment, and audit
checks still apply. See the [Git](./tools/git/README.md#launcher-bindings) and
[GitHub](./tools/github/README.md#launcher-bindings) guides for variables and usage.

> [!IMPORTANT]
> Agent System does not isolate processes sharing an OS user. Absolute binaries,
> replaced `PATH` values, direct HTTP, SDKs, and unrelated host processes can bypass
> these guardrails. Use OpenClaw's [security model](https://docs.openclaw.ai/gateway/security)
> and [sandboxing](https://docs.openclaw.ai/gateway/sandboxing) for host-level protection.

### Chat Approval

Interactive agents use the native [Install](./tools/install/README.md) or
[Doctor](./tools/doctor/README.md) tool. The CLI routes remain unavailable to
ordinary agent and setup descendants. An admitted, activated same-agent command
automation can use `install`, `doctor`, or `status` through its managed descendant;
its target cannot be overridden. Verified owned prompt automations use the native
tools without recurring approval. See [automation authorization](./MANIFEST.md#openclaw-execution-and-ownership).
CLI consent flags, a missing TTY, skill prose, and earlier approvals do not grant
this authority or substitute for interactive **Allow once**.

OpenClaw displays the operation, agent, workspace, manifest digest, and setup
scope before inspection, commands, or credential resolution. Select **Allow
once** or **Deny**. OpenClaw owns approval delivery and approver authorization;
Agent System adds no operator identity or persistent trust store.

Consent covers one matching call. The approval window is two minutes for Doctor and
ordinary Install, or ten minutes when Install includes session enrollment for issue
assignments or manual issue launch. The tool's `timeoutMs` parameter does not change
this window. Changed operation, options, workspace binding, or manifest requires
new approval.
Denial, timeout, cancellation while waiting, missing hooks, or an unavailable
approval route execute nothing. Nested lifecycle consumers cannot reload a
different manifest under the approved operation.

The native OpenClaw harness and OpenClaw-hosted Codex use this route; standalone
Codex uses its [standalone adapter](./CODEX.md#skills).
Control UI chat is the tested approval surface; other chat channels depend on
their OpenClaw plugin approval support. See [approval validation](./DEVELOPMENT.md#lifecycle-approval).

## Scheduler Callback

### `openclaw agent-system automation-execute`

Execute one synchronized command automation. This is the scheduler's operator-only
entrypoint, hidden from ordinary help. Use [automations run](#openclaw-agent-system-automations-run)
to request a tracked occurrence; Install reconciles declarations.

#### Options

| Option or argument | Required | Default | Description                                                           |
| ------------------ | -------- | ------- | --------------------------------------------------------------------- |
| `--hash <hash>`    | yes      | none    | Require the synchronized effective SHA-256 hash.                      |
| `--id <id>`        | yes      | none    | Select the manifest automation ID in the current installed workspace. |

#### Usage

```text
openclaw agent-system automation-execute --id <id> --hash <hash>
```

The native scheduler supplies the exact arguments, fixed executable, profile, and
workspace. This entrypoint accepts no agent selector. Agent descendants and invalid
inherited authority are rejected before execution. Stale, disabled, removed, or
native-drifted jobs fail before temporary authority or tool credentials are issued.
It returns one bounded JSON status and a nonzero exit status on failure. Direct
operator invocation is a manual command execution and does not create a native
scheduled occurrence or update its history.
