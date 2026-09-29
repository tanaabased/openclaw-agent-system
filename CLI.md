# CLI Reference

Commands for validating, installing, and inspecting agent workspaces. Start with
[README](./README.md#usage) for the common workflow and [Manifest Reference](./MANIFEST.md)
for declarations. `openclaw as` aliases `openclaw agent-system`; either bare
namespace prints help. Agent System human summaries honor `NO_COLOR` and
`FORCE_COLOR=0`; failed operations return nonzero.

**Core commands**

- [`openclaw agent-system backup create`](#openclaw-agent-system-backup-create)
- [`openclaw agent-system backup restore`](#openclaw-agent-system-backup-restore)
- [`openclaw agent-system backup verify`](#openclaw-agent-system-backup-verify)
- [`openclaw agent-system credentials cache flush`](#openclaw-agent-system-credentials-cache-flush)
- [`openclaw agent-system credentials cache status`](#openclaw-agent-system-credentials-cache-status)
- [`openclaw agent-system credentials set op`](#openclaw-agent-system-credentials-set-op)
- [`openclaw agent-system credentials unset op`](#openclaw-agent-system-credentials-unset-op)
- [`openclaw agent-system credentials validate op`](#openclaw-agent-system-credentials-validate-op)
- [`openclaw agent-system doctor`](#openclaw-agent-system-doctor)
- [`openclaw agent-system env`](#openclaw-agent-system-env)
- [`openclaw agent-system install`](#openclaw-agent-system-install)
- [`openclaw agent-system tool`](#openclaw-agent-system-tool)
- [`openclaw agent-system validate`](#openclaw-agent-system-validate)

**Component commands**

- [`openclaw agent-system notifications`](#openclaw-agent-system-notifications) — GitHub notifications.
- [`openclaw agent-system tool git`](./tools/git/README.md#cli) — Git commands and managed worktrees.
- [`openclaw agent-system tool gh`](./tools/github/README.md#cli) — GitHub CLI commands.
- [`openclaw agent-system tool gog`](./tools/google/README.md#agent_system_google) — Google commands.

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

## `openclaw agent-system backup create`

Capture selected workspace files and, by default, the selected agent's OpenClaw
SQLite database in a private, verified `.tar.gz`.

> [!TIP]
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
workspace-relative patterns with `/`: exact paths must exist, unmatched globs
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
applies may create backups; checks may only preview or verify. Retention,
uploads, and scheduling are not provided.

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
permissions, and checksums. Selection supports 100,000 entries; the root manifest
is limited to 16 MiB. Bound callers may verify only their agent's archives within
their workspace or configured destination. Success returns `status: verified`;
failure returns `status: failed` and nonzero exit.
When an archive contains `openclaw-state/`, verification checks its strict
layout, checksums, and OpenClaw's database integrity and owner contract from a
private temporary copy. Older workspace-only archives remain verifiable.
Checksums verify internal integrity, not authenticity or completeness of omitted
state. Inspect the root manifest's coverage before relying on the artifact.

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

Reconcile the workspace agent's identity, models, memory, paths, capabilities, and setup.

### Options

| Option or argument     | Required | Default | Description                                                                                          |
| ---------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `--json`               | no       | off     | Write one undecorated structured result to stdout.                                                   |
| `--non-interactive`    | no       | off     | Run without prompts, implying setup consent.                                                         |
| `--rebuild-codex-path` | no       | off     | Replace the saved Codex PATH baseline with this process environment; see [Path](./MANIFEST.md#path). |
| `--skip-setup`         | no       | off     | Skip all setup checks and applies; other components still install.                                   |
| `--skip-setup-agent`   | no       | off     | Skip agent setup checks and applies; other components still install.                                 |
| `--skip-setup-host`    | no       | off     | Skip host setup checks and applies; other components still install.                                  |
| `--yes`                | no       | off     | Consent to setup without prompting.                                                                  |

### Usage

```text
openclaw agent-system install [--yes] [--non-interactive] [--skip-setup] [--skip-setup-host] [--skip-setup-agent] [--rebuild-codex-path] [--json]
```

```sh
# review and apply the current workspace configuration.
openclaw agent-system install

# explicitly consent to setup for an unattended installation.
openclaw agent-system install --yes --json
```

`--skip-setup` skips both phases regardless of consent; combining the two phase
flags has the same effect. Other components still reconcile and enforce their
executable, credential, and identity checks.

Interactive installation previews applicable commands, shells, and timeouts on
stderr. Declining or cancelling stops before mutation. No applicable setup
means no prompt.

Unattended consent comes from `--yes`, `--non-interactive`, noninteractive stdin,
or a truthy `CI` or `NONINTERACTIVE` value. `--json` alone grants no consent;
prompts and warning diagnostics stay on stderr. Consent is not persisted.

If reconciliation fails, install exits nonzero and reports completed outcomes,
the blocking component, and unattempted work. Earlier changes remain applied;
rerun install after fixing the blocker. With `--json`, stdout contains one
failure object with `status: "failed"`, `outcomes`, `blocked`, and `unattempted`.

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
- Grants and verifies [conversation-hook access](./channels/github/ADVANCED.md#required-conversation-hook) when notifications are configured.

Operator-owned tool denials and unmarked conflicting profiles block reconciliation.

## `openclaw agent-system doctor`

Inspect registration, identity, models, memory, paths, and configured capabilities for drift without repairs. `openclaw agent-system status` is an alias.

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

Doctor reports all findings and returns nonzero for failing drift. It recommends
`install` for owned-state repairs; manual state remains the operator's responsibility.
Tool-specific checks live in the respective guides.

For [setup](./MANIFEST.md#setup), Doctor runs applicable checks without consent or repairs,
marks unchecked steps as manual, and skips other runtimes.

> [!NOTE]
> OpenAI memory inspection makes one bounded embedding request, which may incur
> a small provider charge. Other providers are inspected without a live probe.

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

Removal is idempotent and requests Gateway cache invalidation. It does not
change the process-environment fallback. See [cache configuration](./CONFIG.md#opcache)
for pending invalidation and flush behavior.

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

## `openclaw agent-system credentials cache flush`

Invalidate retained 1Password state in the running Gateway.

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

| ID                          | Command    | CLI                                                   | Shim                                                               |
| --------------------------- | ---------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `agent_system_git`          | `git`      | [Usage](./tools/git/README.md#cli)                    | [Packaged shim](./tools/git/README.md#shim)                        |
| `agent_system_git_worktree` | `worktree` | [Usage](./tools/git/README.md#cli)                    | none                                                               |
| `agent_system_github`       | `gh`       | [Usage](./tools/github/README.md#cli)                 | [Packaged shim](./tools/github/README.md#shim)                     |
| `agent_system_google`       | `gog`      | [Usage](./tools/google/README.md#agent_system_google) | [Packaged shim](./tools/google/README.md#gog-and-agent_system_gog) |

## `openclaw agent-system notifications`

Show help for the GitHub notification commands.

### Options

No command-specific options.

### Usage

```text
openclaw agent-system notifications
```

```sh
# list the available notification subcommands.
openclaw agent-system notifications
```

Subcommands:

- [`openclaw agent-system notifications refresh`](./channels/github/ADVANCED.md#openclaw-agent-system-notifications-refresh)
- [`openclaw agent-system notifications status`](./channels/github/ADVANCED.md#openclaw-agent-system-notifications-status)
- [`openclaw agent-system notifications wait`](./channels/github/ADVANCED.md#openclaw-agent-system-notifications-wait)

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

Host fallback removes agent credentials, authority, and configuration overrides;
host tools may use their normal configuration files. Invalid authority, invalid
agent configuration, and managed command failures remain errors. Explicit managed
launchers and Agent System's `worktree` route never fall back. Direct `tool` and
`credentials` commands remain trusted operator interfaces and may select an
installed agent explicitly.

Strict launcher bindings belong to the [Git tool](./tools/git/README.md#launcher-bindings)
and [GitHub tool](./tools/github/README.md#launcher-bindings) guides.

These are practical same-user guardrails, not process isolation. Absolute
binaries, replaced `PATH` values, direct HTTP, SDKs, and unrelated host
processes can bypass them. See OpenClaw's
[security model](https://docs.openclaw.ai/gateway/security) and
[sandboxing reference](https://docs.openclaw.ai/gateway/sandboxing) for the host
boundary beneath Agent System.

### Chat Approval

The `install`, `doctor`, and `status` CLI routes remain operator-only, including
setup descendants. Agents use the native [Install](./tools/install/README.md) or
[Doctor](./tools/doctor/README.md) tool. CLI consent flags, a missing TTY, skill
prose, and earlier approvals cannot substitute for native **Allow once**.

OpenClaw displays the operation, agent, workspace, manifest digest, and setup
scope before inspection, commands, or credential resolution. Select **Allow
once** or **Deny**. OpenClaw owns approval delivery and approver authorization;
Agent System adds no operator identity or persistent trust store.

Consent covers one matching call and expires after two minutes. Changed
operation, options, workspace binding, or manifest requires new approval.
Denial, timeout, cancellation while waiting, missing hooks, or an unavailable
approval route execute nothing. Nested lifecycle consumers cannot reload a
different manifest under the approved operation.

The native OpenClaw harness and OpenClaw-hosted Codex use this route; standalone
Codex uses its [setup-only adapter](./CODEX.md#skills).
Control UI chat is the tested approval surface; other chat channels depend on
their OpenClaw plugin approval support. See [approval validation](./DEVELOPMENT.md#lifecycle-approval).
