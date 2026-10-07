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

The [version 2 notification schema](./MANIFEST.md#githubnotifications) can be parsed
and bound for profile preparation. Execution is not implemented yet: Doctor reports
`github-notification-runtime-unsupported`, and Install blocks before applying setup.
No notification job, working chat, operator grant, or GitHub mutation is created.
The manifest reference owns the agreed modes and follow-up activation contract.

## Repository Automations

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

| Manifest field                                    | Codex behavior                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overrides.codex.effort`, `overrides.codex.model` | Independent jobs inherit omitted values from the ambient Codex home's top-level configuration at sync time. Named configuration profiles require explicit overrides. Later default changes appear as drift; native Codex decides model/effort availability.                        |
| `overrides.codex.target`                          | Defaults to an independent job in the one saved local project matching the bound workspace. `{ thread: existing-id }` selects an existing local chat there; model and effort overrides are rejected for chat targets.                                                              |
| `prompt`, `payload`                               | Recurring prompts, including prompts asking a model to run a script.                                                                                                                                                                                                               |
| `run`                                             | Zero-model commands are unsupported, including `payload.kind: command`.                                                                                                                                                                                                            |
| `schedule`                                        | Whole-minute or whole-hour intervals from 1 to 999. Cron supports one minute every hour, or one daily time with daily, weekday, or month-day selection across all months. Multiple-job expressions and unsupported day-field combinations are rejected; one-shots are unsupported. |
| `schedule.timezone`                               | `native` only. Native timing and DST behavior apply.                                                                                                                                                                                                                               |
| `thread`                                          | Creates a persistent conversation per automation. Model and effort overrides are rejected for persistent chat targets.                                                                                                                                                             |
| `timeout-seconds`                                 | Unsupported. Native timeout, concurrency, retry, and catch-up rules apply.                                                                                                                                                                                                         |

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
