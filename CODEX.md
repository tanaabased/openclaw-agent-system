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
- [Model routing](./skills/model-routing/SKILL.md) — Select model and effort candidates for new tasks.

## Model Routing

Configure models and efforts in [`agent.yaml`](./MANIFEST.md#models), then use the
[model routing skill](./skills/model-routing/SKILL.md) for new work. See the
[helper contract](./tools/model-routing/README.md) for runtime mappings, overrides,
and unresolved results.

## Repository Automations

Declare jobs in [`agent.yaml`](./MANIFEST.md#automations), then use
`$agent-system-install` in the desktop app. Install computes a deterministic plan,
applies authorized native automation actions one at a time, and verifies each saved
definition. Doctor compares desired and saved settings without changing or running
jobs. Headless Install returns `requires-native-app-sync` when app work remains;
it cannot complete native writes by itself.

Independent prompt jobs run in the one local saved project whose canonical path
matches the bound workspace. Missing or ambiguous projects block planning; a
worktree binding does not silently schedule in its parent checkout. An explicit
`overrides.codex.target: { thread: existing-id }` selects an existing local Codex
chat in that same workspace. Supply a fresh native exact-thread read; this adapter
accepts active, idle, running, or completed status and rejects other statuses.
It neither creates a replacement chat nor binds to the installer's conversation.

| Setting              | Supported behavior                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload              | Recurring prompts, including prompts explicitly asking a model to run a script. Zero-model command declarations are rejected.                                                                                                                                                                                                                           |
| Interval             | Whole minutes or hours with an interval from 1 to 999. Native timing and DST behavior apply.                                                                                                                                                                                                                                                            |
| Cron                 | One minute at every hour, or one daily time with daily, weekday, or month-day selection across all months. Expressions requiring multiple jobs or unsupported day-field combinations are rejected.                                                                                                                                                      |
| Timezone             | `native` only; explicit zones are unsupported. The adapter does not promise a timezone override.                                                                                                                                                                                                                                                        |
| One-shots            | Unsupported until native anchor and completion persistence are proven.                                                                                                                                                                                                                                                                                  |
| Model and effort     | Independent jobs copy omitted values from the ambient Codex home's top-level configuration at sync time. Named configuration profiles require explicit manifest overrides. Supported effort values are checked; the native app remains authoritative for model availability and valid model/effort combinations. Later default changes appear as drift. |
| Thread overrides     | Existing chats retain their model and effort; specifying either override on a heartbeat is rejected.                                                                                                                                                                                                                                                    |
| Limits and telemetry | Native concurrency, retry, catch-up, and timeout semantics; explicit `timeout-seconds` is rejected. Execution and delivery telemetry are reported as unavailable.                                                                                                                                                                                       |

The adapter uses ambient host credentials and permissions. It never resolves
OpenClaw credentials or changes Codex permission settings. An unavailable model,
account, app operation, or unattended permission blocks completion; fix the native
profile condition and inspect again. A saved definition proves persistence, not
that the app will be running or that a scheduled prompt can execute successfully.

An Agent System marker plus a private non-secret ledger owns each job. Native UI
edits to managed fields are drift. Notification preferences remain native-owned.
Unchanged jobs receive no native writes. Removed declarations pause their jobs and
retain mappings and history; reintroduced IDs reuse the same native job. Personal
and Me jobs are never adopted by name. Unknown saved schemas stop inspection.

The install skill owns the internal plan/prepare/acknowledge sequence through the
trusted `automationRuntime` context. Prepared writes retain a pending journal until
saved-state verification succeeds. If a native response is lost, acknowledgment
can recover the exact pending marker and definition without another create. A
failed write can be cancelled only while saved state still matches its pre-write
snapshot. Divergence or missing owned jobs requires operator investigation. There
is no rollback of earlier verified actions and no atomic compare-and-swap guarantee
against concurrent native UI edits. A process crash during a journal transition
may leave `automation-journal-busy`; first confirm no reconciliation is running,
then remove only that stale Agent System `.lock` directory. Never repair native
scheduler files or delete the ownership ledger to force a sync.

Native request/response and saved-state captures live in `fixtures/` with separate
provenance. Capture, comparison, and acceptance are explicit development work;
ordinary tests consume reviewed captures without contacting the app. Constructed
failure cases are identified in the tests. Installed desktop-tool verification is
separate from the GitHub Actions-only packed/headless Codex example.

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
