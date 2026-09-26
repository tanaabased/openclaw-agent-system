# CLI Reference

Commands for validating, installing, and inspecting agent workspaces. Start with
[README](./README.md#usage) for the common workflow and [Manifest Reference](./MANIFEST.md)
for declarations. `openclaw as` aliases `openclaw agent-system`; either bare
namespace prints help. Agent System human summaries honor `NO_COLOR` and
`FORCE_COLOR=0`; failed operations return nonzero.

- [`openclaw agent-system validate`](#openclaw-agent-system-validate)
- [`openclaw agent-system backup create`](#openclaw-agent-system-backup-create)
- [`openclaw agent-system backup verify`](#openclaw-agent-system-backup-verify)
- [`openclaw agent-system env`](#openclaw-agent-system-env)
- [`openclaw agent-system install`](#openclaw-agent-system-install)
- [`openclaw agent-system doctor`](#openclaw-agent-system-doctor)
- [`openclaw agent-system credentials set op`](#openclaw-agent-system-credentials-set-op)
- [`openclaw agent-system credentials validate op`](#openclaw-agent-system-credentials-validate-op)
- [`openclaw agent-system credentials unset op`](#openclaw-agent-system-credentials-unset-op)
- [`openclaw agent-system credentials cache status`](#openclaw-agent-system-credentials-cache-status)
- [`openclaw agent-system credentials cache flush`](#openclaw-agent-system-credentials-cache-flush)
- [`openclaw agent-system notifications`](#openclaw-agent-system-notifications)
- [`openclaw agent-system tool`](#openclaw-agent-system-tool)

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

The result identifies the selected agent and workspace and reports the core and
configured capability declarations that passed validation.

## `openclaw agent-system backup create`

Capture selected workspace files in a private, verified `.tar.gz`. This stage is
workspace-only: OpenClaw databases, sessions, runtime state, out-of-workspace
sources, and external memory backends are not captured.

### Options

| Option or argument           | Required | Default                             | Description                                                                                    |
| ---------------------------- | -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| `--agent <id>`               | no       | workspace discovery                 | Select an installed agent; operators only.                                                     |
| `--output <directory>`       | no       | manifest or `.agent-system/backups` | Resolve relative destinations against the discovered workspace.                                |
| `--git-ignore[=true\|false]` | no       | manifest or `false`                 | Bare flag means `true`; omission inherits the manifest.                                        |
| `--include <patterns...>`    | no       | manifest or `[]`                    | Repeatable quoted workspace-relative globs; replace the manifest list. `--include=` clears it. |
| `--exclude <patterns...>`    | no       | manifest or `[]`                    | Repeatable globs applied last; replace the manifest list. `--exclude=` clears it.              |
| `--dry-run`                  | no       | off                                 | Report settings and selection without writing any files, ignore rules, locks, or staging.      |
| `--json`                     | no       | off                                 | Write one structured result, including failures.                                               |

### Usage

```text
openclaw agent-system backup create [--agent <id>] [--output <directory>]
  [--git-ignore[=true|false]] [--include <patterns...>] [--exclude <patterns...>]
  [--dry-run] [--json]
```

```sh
# inspect selected private memory before capturing it.
openclaw as backup create --dry-run --json --git-ignore \
  --include 'MEMORY.md' 'memory/**' --include 'DREAMS.md' 'GOALS.md' \
  --exclude 'scratch/**'

# capture with the manifest defaults.
openclaw agent-system backup create --json

# clear configured exclusions and turn off git-ignore filtering.
openclaw as backup create --exclude= --git-ignore=false
```

Selection starts with workspace entries, removes the small regenerable filter
(`**/node_modules/**`, `**/.npm/_cacache/**`, `**/.eslintcache`), optionally applies
Git-ignore, restores includes, then applies excludes. Includes can recover files
under ignored parents; excludes win. Build outputs and worktrees are not blanket
excluded. Exact include paths must exist; unmatched globs produce diagnostics.
Git-ignore requires a Git repository and keeps tracked files. Paths use `/`;
absolute patterns, traversal, backslashes, and control characters are unsupported.

The default backup destination, effective destination, and
`.agent-system/backup-staging` are always excluded, including aliases and explicit
includes. Add previous custom backup destinations to `exclude` yourself; archives
are not excluded merely by extension. Relative links are preserved only when their
target belongs to the selected payload; escaping, absolute, and broken links are
omitted with diagnostics. Known live OpenClaw state and database sidecars are
protected independently of selection patterns.

Operators may choose local destinations. Bound callers cannot supply `--agent`
and may use only contained workspace destinations or the manifest-configured
external directory. Locations belonging to another or invalid agent workspace are
rejected. Destinations cannot equal or contain the workspace, or reside
in live OpenClaw state or Git metadata. Inside Git repositories, creation reuses
an effective ignore rule or appends a narrow directory rule to local
`info/exclude`; unrelated rules and the rest of `.agent-system/` remain intact.
Tracked destinations and overriding ignore rules fail with diagnostics.

Archives contain root `manifest.json` and `workspace/`. Version `1` records agent
identity, capture time, effective settings, coverage, diagnostics, inventory,
permissions, safe link targets, and SHA-256 checksums. Files are staged privately;
concurrent captures for the same workspace/agent serialize. An exclusive final
name appears only after verification. Archives have mode `0600`; staging has mode
`0700`. Failed capture or verification publishes no archive. Changed or vanished
files detected during capture fail explicitly; files can still change before or
after their individual capture. This is not an atomic workspace snapshot.

Setup `apply` steps may create backups; checks may only use `--dry-run` or verify
existing archives. Creation is noninteractive and installs no scheduler. A preview
returns `status: preview`, creation `status: created`, and failures `status: failed`
with nonzero exit and diagnostic codes. Sensitive local files can be included;
keep archives private. Restore, retention, uploads, scheduling, and database
snapshot capture are separate features.

## `openclaw agent-system backup verify`

Read and verify a workspace archive without extracting it or changing a live
workspace. Operators can verify an archive without an installed workspace.

### Options

| Option or argument | Required | Default | Description                                                   |
| ------------------ | -------- | ------- | ------------------------------------------------------------- |
| `<archive>`        | yes      | none    | Local `.tar.gz` path, relative to the current directory.      |
| `--agent <id>`     | no       | none    | Require this recorded agent identity; operators only.         |
| `--json`           | no       | off     | Write one structured verification result, including failures. |

### Usage

```text
openclaw agent-system backup verify <archive> [--agent <id>] [--json]
```

```sh
# verify a workspace-only artifact without restoring it.
openclaw as backup verify /private/backups/agent-backup.tar.gz --json
```

Verification rejects unsupported versions, invalid manifests, duplicate or unsafe
paths, unsafe links, unsupported entry types, missing/extra inventory entries,
permission mismatches, and checksum failures. Selection scans up to 100,000
workspace entries; the root manifest supports up to 16 MiB. Bound callers may verify only their
own identity's archives inside their workspace or configured destination. Success
returns `status: verified`; failures return `status: failed` and nonzero exit.
Checksums verify internal integrity, not authenticity or completeness of omitted
state. Verification does not imply OpenClaw database coverage.

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

The result reports each variable’s name, winning source, required state, and
override count without printing values.

## `openclaw agent-system install`

Install the current workspace agent and reconcile its identity, models, memory, paths, configured capabilities, and setup steps for dependency installation and configuration.

### Options

| Option or argument     | Required | Default | Description                                                                                          |
| ---------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `--yes`                | no       | off     | Consent to setup without prompting.                                                                  |
| `--non-interactive`    | no       | off     | Run without prompts, implying setup consent.                                                         |
| `--skip-setup`         | no       | off     | Skip all setup checks and applies; other components still install.                                   |
| `--rebuild-codex-path` | no       | off     | Replace the saved Codex PATH baseline with this process environment; see [Path](./MANIFEST.md#path). |
| `--json`               | no       | off     | Write one undecorated structured result to stdout.                                                   |

### Usage

```text
openclaw agent-system install [--yes] [--non-interactive] [--skip-setup] [--rebuild-codex-path] [--json]
```

```sh
# review and apply the current workspace configuration.
openclaw agent-system install

# explicitly consent to setup for an unattended installation.
openclaw agent-system install --yes --json
```

All switches are boolean; `--skip-setup` takes precedence over consent.
Interactive installation previews applicable commands, shells, and timeouts on
stderr. Declining or cancelling stops before any mutation. No applicable setup
means no prompt.

Unattended consent comes from `--yes`, `--non-interactive`, noninteractive stdin,
or a truthy `CI` or `NONINTERACTIVE` value. `--json` alone grants no consent;
prompts and warnings never enter stdout JSON. Consent is not persisted.

> [!NOTE]
> Environment flags accept trimmed, case-insensitive `1`, `true`, `yes`, or `on`.
> Other values do not enable consent or cancel another enabling source.
> Unattended runs trust the current declarations, including changes since the last run.

Installation:

- Validates declarations and requires persistent credentials for declared 1Password resources before mutation.
- Verifies owned state, reporting already reconciled components as unchanged. Setup follows its [check and retry rules](./MANIFEST.md#checks-installation-and-retries).
- Rejects an agent id already bound to another workspace.
- Reconciles manifest-selected Git, worktree, and GitHub tool grants while preserving unrelated grants.
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
| `--store <id>`     | no       | automatic           | Select `keychain`, `secret-service`, or `file`; see [storage](#credential-storage). |
| `--from-env`       | no       | off                 | Validate only `OP_SERVICE_ACCOUNT_TOKEN` from the process environment.              |

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

The channel guide owns the complete command references:

- [`openclaw agent-system notifications refresh`](./channels/github/ADVANCED.md#openclaw-agent-system-notifications-refresh)
- [`openclaw agent-system notifications status`](./channels/github/ADVANCED.md#openclaw-agent-system-notifications-status)
- [`openclaw agent-system notifications wait`](./channels/github/ADVANCED.md#openclaw-agent-system-notifications-wait)

## `openclaw agent-system tool`

Run a registered tool command with an explicitly selected operator identity for administration, testing, or debugging. Agents use the corresponding native `agent_system_*` tool.

### Options

| Option or argument  | Required | Default             | Description                                                         |
| ------------------- | -------- | ------------------- | ------------------------------------------------------------------- |
| `<command>`         | yes      | none                | Select `git`, `gh`, or `worktree`.                                  |
| `--agent <id>`      | no       | workspace discovery | Use the exact configured workspace for an installed OpenClaw agent. |
| `-- <arguments...>` | yes      | none                | Pass the remaining arguments to the selected command.               |

### Usage

```text
openclaw agent-system tool <command> [--agent <id>] -- <arguments...>
```

```sh
# verify the configured github identity of one installed agent.
openclaw agent-system tool gh --agent tanaabot -- api user --jq .login
```

| ID                          | Command    | CLI                                   | Shim                                           |
| --------------------------- | ---------- | ------------------------------------- | ---------------------------------------------- |
| `agent_system_git`          | `git`      | [Usage](./tools/git/README.md#cli)    | [Packaged shim](./tools/git/README.md#shim)    |
| `agent_system_git_worktree` | `worktree` | [Usage](./tools/git/README.md#cli)    | none                                           |
| `agent_system_github`       | `gh`       | [Usage](./tools/github/README.md#cli) | [Packaged shim](./tools/github/README.md#shim) |

Tool-specific arguments, policy, and routing behavior belong in the linked guide.

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
