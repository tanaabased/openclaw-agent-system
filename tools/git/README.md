# Agent System Git Tool

<a id="agent-system-git-tools"></a>

<p align="center">
  <img src="../../skills/git-cli/assets/icon-large.svg" alt="Agent System Git" width="180" />
</p>

The Git tool runs noninteractive `git` commands with the active agent's identity,
SSH configuration, and policy. Enable it through the workspace's `git` declaration.
Use the [Git Worktree tool](./worktree/README.md) to manage durable checkouts.

- [Configuration Reference](#configuration-reference)
  - [`git.email`](#gitemail)
  - [`git.extensions`](#gitextensions)
  - [`git.name`](#gitname)
  - [`git.policy`](#gitpolicy)
  - [`git.signing`](#gitsigning)
  - [`git.ssh.private-keys`](#gitsshprivate-keys)
  - [`git.worktrees`](#gitworktrees)
- [`agent_system_git`](#agent_system_git)
- [CLI](#cli)
  - [`openclaw agent-system tool git`](#openclaw-agent-system-tool-git)
- [Shim](#shim)
- [Launcher Bindings](#launcher-bindings)

## Overview

| Interface                        | Purpose                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `agent_system_git`               | Model-facing ordinary Git tool                               |
| `git`                            | Packaged compatibility shim on supported agent command paths |
| `openclaw agent-system tool git` | Explicit operator Git command                                |

The model-facing tool uses the trusted active agent. Direct CLI and shell use are
operator interfaces unless OpenClaw supplies an active-agent binding. Every
interface applies the same Git configuration and policy before launching `git`.

## Requirements

- Agent System installed and enabled
- Git available as `git`
- An Agent System workspace manifest with `git` configured
- An effective Git name and email declared by `git` or `agent`
- OpenSSH when keys are configured: `ssh` for authentication, `ssh-agent` and `ssh-add` for authentication or signing, and `ssh-keygen` for signing

> [!IMPORTANT]
> Remote-server authorization and ref protections are authoritative wherever
> they exist. Agent System adds only the narrow, provider-portable controls
> documented under [`git.policy`](#gitpolicy).

## Configuration Reference

Add `git` to `.agent-system/agent.yaml` or the root `agent.yaml`. The schema is
strict: unknown and incorrectly cased keys fail validation.

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email:
    from-environment: AGENT_EMAIL

environment:
  required:
    - AGENT_EMAIL
    - GIT_SIGNING_KEY
    - GIT_SSH_PRIVATE_KEY

git:
  worktrees: {}
  extensions:
    lfs: allow
    town: deny
  ssh:
    private-keys:
      from-environment: GIT_SSH_PRIVATE_KEY
  signing:
    key: GIT_SIGNING_KEY
    allowed-signers-file: .agent-system/allowed_signers
```

### `git.email`

| Type                               | Required | Default       |
| ---------------------------------- | -------- | ------------- |
| string or `from-environment` value | no       | `agent.email` |

Sets both author and committer email for the Git child. A missing or unresolved
effective value fails the operation.

### `git.extensions`

| Type                                     | Required | Default |
| ---------------------------------------- | -------- | ------- |
| exact command-to-policy-decision mapping | no       | none    |

Assigns `allow` or `deny` to exact external helpers such as `git-town`. The helper must
be executable on `PATH`; aliases do not satisfy the declaration, and built-in protection
classification takes precedence. Allowing an extension trusts the helper to handle its
own arguments. Undeclared and unsupported commands are denied; a declared helper that is
missing is also denied.

### `git.name`

| Type                               | Required | Default      |
| ---------------------------------- | -------- | ------------ |
| string or `from-environment` value | no       | `agent.name` |

Sets both author and committer name for the Git child. Agent System does not
fall through to repository, global, or system Git identity.

### `git.policy`

| Field               | Values          | Required | Default | Covers                                                        |
| ------------------- | --------------- | -------- | ------- | ------------------------------------------------------------- |
| `delete-remote-ref` | `allow`, `deny` | no       | `deny`  | `--delete`, `-d`, `--prune`, deletion refspecs, and mirroring |
| `force-push`        | `allow`, `deny` | no       | `deny`  | `--force`, `-f`, `--force-with-lease`, and positive refspecs  |

Omitted fields remain denied. Enable only the required remote effects:

```yaml
git:
  policy:
    force-push: allow
```

Supported public reads and recognized ordinary writes are allowed. This includes
local branch and tag deletion, cleanup, discard, rebase, amend, and reset
operations. These actions can still lose local work; Git's own state and the
repository's review workflow remain responsible for recovery and coordination.

Protected remote effects take precedence. `git push --mirror` selects both
fields, so both must be `allow`.

These fields provide the same narrow safeguards across Git providers because
equivalent server-side controls are not consistently available. Where the
provider supports ref protection, configure it as the authoritative boundary.
For GitHub remotes, use
[branch and tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
to restrict updates, deletions, and force pushes on important refs. A local
`allow` cannot override a remote denial.

Undeclared external helpers and unsupported command families remain denied
independently of `git.policy`; use exact `git.extensions` declarations for
trusted helpers.

Agent System disables operator-global and system Git configuration, prompts,
hooks, pagers, and editors and rejects configuration, executable, credential,
and working-directory escape paths. Repository configuration can still name
helpers, filters, aliases, and diff programs, so the wrapper does not make an
untrusted checkout safe. Raw `git worktree` access permits only read-only
`list`; use the managed worktree tool for lifecycle changes.

### `git.signing`

| Field                  | Type                    | Required | Default |
| ---------------------- | ----------------------- | -------- | ------- |
| `allowed-signers-file` | workspace-relative path | no       | none    |
| `key`                  | environment binding     | yes      | none    |

Declaring `git.signing` enables SSH signing for every commit and tag. `key` names one
variable in the completed Agent System environment; it is never private-key
material itself and does not accept a literal value, path, array, or nested
`from-environment` object. Any declared environment source may populate the
binding.

Signing uses a separate invocation-scoped agent and fixed helpers. Git receives
no generic SSH socket, and signing-control arguments cannot disable signing or
select another key. Authentication and signing remain separate even when they
use the same key.

The optional allowed-signers file is public trust policy. It must be a regular,
non-symlinked file inside the agent workspace and use the OpenSSH allowed
signers format:

```text
tanaabot@tanaab.dev ssh-ed25519 AAAA... tanaabot@tanaab.dev
```

When present, `git log --show-signature`, `git verify-commit`, and
`git verify-tag` require a fully trusted signer. Protect changes to a
repository-owned trust file through normal review and branch controls; an
untrusted checkout cannot establish trust merely by adding its own key.
Hosting-provider signing-key registration remains a separate provider
operation.

### `git.ssh.private-keys`

| Type                          | Required | Default |
| ----------------------------- | -------- | ------- |
| key source or key source list | no       | none    |

Selects one or more unencrypted OpenSSH private keys in declaration order:

```yaml
git:
  ssh:
    private-keys:
      - path: ~/.ssh/id_ed25519
      - from-environment: GIT_SSH_PRIVATE_KEY
```

`path` reads an existing owner-only regular file. Relative paths remain inside
the agent workspace; absolute and `~/` paths are explicit operator choices.
`from-environment` reads the named value from the completed Agent System
environment, so dotenv, 1Password Environments, and direct OP secret references
can supply the key. Secret acquisition belongs to the shared
[environment contract](../../MANIFEST.md#environment-resolution), so the Git schema does
not duplicate `from-op`. Encrypted keys are not yet supported. Agent System
isolates the declared keys from ambient SSH identities and presents them only
for Git SSH transport. Run `openclaw agent-system doctor` to check OpenSSH
readiness.

### `git.worktrees`

See the [Git Worktree configuration reference](./worktree/README.md#gitworktrees)
for managed roots, repository locations, preparation, and recovery.

<a id="native-tools"></a>

## `agent_system_git`

Run ordinary Git commands using the trusted active agent. Configuration and
[policy](#gitpolicy) apply to native and CLI calls alike.

### Parameters

| Parameter | Type         | Required | Default                      | Description                                                                            |
| --------- | ------------ | -------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `argv`    | string array | yes      | none                         | 1–256 Git arguments, without the `git` executable.                                     |
| `cwd`     | string       | no       | verified execution workspace | Working directory within the workspace or configured worktree root; 1–4096 characters. |
| `stdin`   | string       | no       | none                         | Ordinary command input, at most 64 KiB; never credentials.                             |

### Usage

Inspect the active workspace:

```json
{ "argv": ["status", "--short"] }
```

For a managed checkout, pass its returned canonical path as `cwd`. Results include
`exitCode`, `stdout`, `stderr`, and `truncated`.

In an ordinary session bound to a registered worktree under the agent's managed
bare-repository layout, omitted and relative `cwd` values use that worktree.
Agent configuration and Git identity still come from the canonical agent workspace.
Home-workspace sessions retain the agent workspace default. This binding does not
admit an issue or expand Git policy.

<a id="agent_system_git_worktree"></a>

For managed checkout operations, use the
[Git Worktree tool](./worktree/README.md#agent_system_git_worktree).

## CLI

These are operator commands; agents use `agent_system_git`. See the [shared trust boundary](../../CLI.md#trust-boundary)
for identity binding and host-access limits.

### `openclaw agent-system tool git`

Run ordinary Git commands with the agent’s configured identity and policy.

#### Options

| Option or argument      | Required | Default             | Description                                                |
| ----------------------- | -------- | ------------------- | ---------------------------------------------------------- |
| `-- <git-arguments...>` | yes      | none                | Pass ordinary Git arguments unchanged.                     |
| `--agent <id>`          | no       | workspace discovery | Use the exact configured workspace for an installed agent. |

#### Usage

```text
openclaw agent-system tool git [--agent <id>] -- <git-arguments...>
```

```sh
# inspect git from the current repository directory.
openclaw agent-system tool git -- status --short

# select an installed agent from a declared local repository.
openclaw agent-system tool git --agent tanaabot -- status --short
```

Arguments after `--` retain the child’s streams and exit code. Native tools
remain contained to the workspace and configured worktree root. Trusted
operator commands may also use declared local repositories; undeclared paths
remain unavailable.

<a id="openclaw-agent-system-tool-worktree----list"></a>
<a id="openclaw-agent-system-tool-worktree----prepare"></a>
<a id="openclaw-agent-system-tool-worktree----remove"></a>

Worktree commands have their own references: [list](./worktree/README.md#openclaw-agent-system-tool-worktree----list),
[prepare](./worktree/README.md#openclaw-agent-system-tool-worktree----prepare), and
[remove](./worktree/README.md#openclaw-agent-system-tool-worktree----remove).

## Shim

Install adds the packaged `git` shim to supported agent command paths:

```sh
# confirm that this git belongs to agent system.
git --agent-system

# delegate an ordinary git command through the shared tool runtime.
git status --short
```

The packaged command automatically uses managed Git in agent context and
sanitized host execution outside it. See the
[command-routing contract](../../CLI.md#trust-boundary).

## Launcher Bindings

Agent-bound Gateway and setup children receive an absolute executable path:

| Variable           | Available when    | Purpose                        |
| ------------------ | ----------------- | ------------------------------ |
| `AGENT_SYSTEM_GIT` | Git is configured | Require managed Git execution. |

```sh
# require the bound agent's git identity and policy without host fallback.
"$AGENT_SYSTEM_GIT" status --short
```

This launcher requires active-agent authority under the shared
[execution boundary](../../CLI.md#trust-boundary). The [shim](#shim) retains
its contextual host fallback.

## Further Reading

- [Agent System README](../../README.md): installation and the common manifest workflow
- [Manifest reference](../../MANIFEST.md): workspace declarations, environment, and paths
- [CLI reference](../../CLI.md): shared commands and execution boundaries
- [Global configuration](../../CONFIG.md): operator-owned plugin settings
- [Development](../../DEVELOPMENT.md#logging): runtime logging during development
- [Raw Git skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-cli/SKILL.md): model-facing Git guidance
- [Git worktree skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-worktree/SKILL.md): model-facing worktree guidance

Git logo by [Jason Long](https://git-scm.com/downloads/logos), licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/); recolored for Agent System.
