# CLI Reference

Commands for validating, installing, and inspecting an agent workspace. Start
with the [README](./README.md#usage) for the common workflow and
[Manifest Reference](./MANIFEST.md) for declarations.

- [Common behavior](#common-behavior)
- [Trust boundary](#trust-boundary)
- [Validate](#openclaw-agent-system-validate)
- [Environment](#openclaw-agent-system-env)
- [Credentials](#openclaw-agent-system-credentials)
- [Install](#openclaw-agent-system-install)
- [Doctor](#openclaw-agent-system-doctor-alias-status)
- [Notifications](#openclaw-agent-system-notifications)
- [Tools](#openclaw-agent-system-tool)

All commands live beneath `openclaw agent-system`; `openclaw as` is an equivalent
alias. Bare `agent-system` or `as` prints help.

## Common Behavior

| Option         | Commands                                                                                                                                        | Behavior                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `--agent <id>` | `validate`, `env`, `tool`, `credentials set/validate/unset`, `doctor`, `notifications refresh`, `notifications status`, `notifications wait`    | Uses the exact configured OpenClaw agent workspace instead of discovery. |
| `--json`       | `validate`, `env`, `install`, `doctor`, `credentials cache status/flush`, `notifications refresh`, `notifications status`, `notifications wait` | Writes undecorated structured output.                                    |

Human output honors `NO_COLOR` and `FORCE_COLOR=0`. A failed operation sets a
nonzero exit code. `credentials cache flush --agent <id>` limits invalidation to
one agent; cache status always covers the Gateway.

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

Gateway and setup child processes expose strict executable bindings for
configured routes:

| Route             | Binding                     |
| ----------------- | --------------------------- |
| Git               | `AGENT_SYSTEM_GIT`          |
| GitHub            | `AGENT_SYSTEM_GH`           |
| Managed worktrees | `AGENT_SYSTEM_GIT_WORKTREE` |

Use a binding when a script must require managed execution:

```sh
# require the bound agent's git identity and policy; never fall back to host git.
"$AGENT_SYSTEM_GIT" status --short
```

Bindings are absolute executable paths, not credentials. They retain the agent's
classification, authorization, policy, credentials, containment, and audit checks;
missing or invalid authority fails. They exist only in Agent System-owned child
environments, never login shells, repository config, manifest environment output,
or unrelated processes. Ordinary `git` and `gh` retain the context-sensitive
fallback described above.

The `install` and Doctor (`status`) CLI routes remain operator-only through both
aliases, including setup descendants. In OpenClaw chat, use
`agent_system_install` or `agent_system_doctor` to request **Allow once** for the
active agent and manifest. This includes Doctor's declared check commands.
Unattended CLI options do not grant chat approval. See the
[lifecycle tool guide](tools/lifecycle/README.md) for the approval boundary and
supported harnesses.

These are practical same-user guardrails, not process isolation. Absolute
binaries, replaced `PATH` values, direct HTTP, SDKs, and unrelated host
processes can bypass them. See OpenClaw's
[security model](https://docs.openclaw.ai/gateway/security) and
[sandboxing reference](https://docs.openclaw.ai/gateway/sandboxing) for the host
boundary beneath Agent System.

## `openclaw agent-system validate`

Discovers and validates a manifest without resolving credentials, inspecting
installed or remote state, or applying changes.

```text
openclaw agent-system validate [--agent <id>] [--json]
```

The result identifies the selected agent and workspace and reports the core and
configured capability declarations that passed validation.

## `openclaw agent-system env`

Resolves the environment Agent System contributes without printing values or
predicting another tool's environment.

```text
openclaw agent-system env [--agent <id>] [--json]
```

The result reports each variable's name, winning source, required state, and
override count without printing values.

## `openclaw agent-system credentials`

Manages the agent-scoped credential used to access declared 1Password
Environments and direct secret references. The current credential target is
`op`.

```text
openclaw agent-system credentials set op [--agent <id>] [--from-env | --stdin] [--store <id>]
openclaw agent-system credentials validate op [--agent <id>] [--from-env | --store <id>]
openclaw agent-system credentials unset op [--agent <id>] [--store <id>]
openclaw agent-system credentials cache status [--json]
openclaw agent-system credentials cache flush [--agent <id>] [--json]
```

| Option         | Commands                   | Behavior                                                   |
| -------------- | -------------------------- | ---------------------------------------------------------- |
| `--from-env`   | `set`, `validate`          | Reads only `OP_SERVICE_ACCOUNT_TOKEN`.                     |
| `--stdin`      | `set`                      | Reads redirected input without exposing it as an argument. |
| `--store <id>` | `set`, `validate`, `unset` | Targets `keychain`, `secret-service`, or `file`.           |

Without an input option, `set` uses a masked interactive prompt and fails with
guidance in a noninteractive session. Tokens are never accepted as command
arguments. Every set path verifies access to all declared 1Password resources
before storage.

Automatic persistent selection prefers Keychain then file on macOS and Secret
Service then file on Linux. `validate` checks those stores in order and then the
process fallback; an exact `--store` or `--from-env` request disables fallback.
`unset` is idempotent: it removes persisted credentials and requests Gateway cache
invalidation, but does not change the process-environment fallback. See
[global cache configuration](./CONFIG.md#opcache) for cache controls and pending invalidation.

The file fallback lives at
`$XDG_CONFIG_HOME/tanaab/agent-system/<agent-id>/op-token`, or under
`$HOME/.config` when `XDG_CONFIG_HOME` is unset. Agent System requires owner-only
directories, mode `0600`, and a regular non-symlinked credential file.

## `openclaw agent-system install`

Installs the current workspace agent and reconciles its public identity, model
defaults, memory search, executable paths, setup, and configured capability state.

```text
openclaw agent-system install [--yes] [--non-interactive] [--skip-setup] [--rebuild-codex-path] [--json]
```

| Option                 | Behavior                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `--yes`                | Consents to setup without prompting.                                                                  |
| `--non-interactive`    | Runs without prompting, implying setup consent.                                                       |
| `--skip-setup`         | Skips every setup check and apply with a warning; other components still install.                     |
| `--rebuild-codex-path` | Replaces the saved Codex PATH baseline with this process environment; see [Path](./MANIFEST.md#path). |

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
- Grants and verifies [conversation-hook access](./channels/github/README.md#required-conversation-hook) when notifications are configured.

Operator-owned tool denials and unmarked conflicting profiles block reconciliation.

## `openclaw agent-system doctor` (alias: `status`)

Inspects agent registration, public identity, model and memory configuration,
path projection, and configured capabilities for drift without applying repairs.

```text
openclaw agent-system doctor [--agent <id>] [--json]
openclaw agent-system status [--agent <id>] [--json]
```

Doctor reports all findings and returns nonzero for failing drift. It recommends
`install` for owned-state repairs; manual state remains the operator's responsibility.
Tool-specific checks live in the respective guides.

For [setup](./MANIFEST.md#setup), Doctor runs applicable checks without consent or repairs,
marks unchecked steps as manual, and skips other runtimes.

> [!NOTE]
> OpenAI memory inspection makes one bounded embedding request, which may incur
> a small provider charge. Other providers are inspected without a live probe.

## `openclaw agent-system notifications`

Runs the command family owned by the `agent-system-github` channel.

```text
openclaw agent-system notifications <refresh|status|wait> [options]
```

See the channel's [complete CLI reference](./channels/github/README.md#cli) for
command syntax, selectors, wait targets, output, and exit behavior.

## `openclaw agent-system tool`

Runs a registered command through its Agent System tool. Direct invocations are
an explicitly selected operator identity and are intended for administration,
testing, and debugging. Agents should use the corresponding native
`agent_system_*` tool for direct work. A public tool integration contract is
planned in [Tool API](./API.md).

```text
openclaw agent-system tool <command> [--agent <id>] -- <arguments...>
```

| ID                          | Command    | CLI                                   | Shim                                           |
| --------------------------- | ---------- | ------------------------------------- | ---------------------------------------------- |
| `agent_system_git`          | `git`      | [Usage](./tools/git/README.md#cli)    | [Packaged shim](./tools/git/README.md#shim)    |
| `agent_system_git_worktree` | `worktree` | [Usage](./tools/git/README.md#cli)    | none                                           |
| `agent_system_github`       | `gh`       | [Usage](./tools/github/README.md#cli) | [Packaged shim](./tools/github/README.md#shim) |

Tool-specific arguments, policy, and routing behavior belong in the linked guide.
