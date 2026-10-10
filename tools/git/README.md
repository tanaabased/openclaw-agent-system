# Agent System Git Tools

<p align="center">
  <img src="../../assets/git-icon-large.svg" alt="Agent System Git" width="180" />
</p>

The Git tools run noninteractive `git` commands and manage durable worktrees
with the active agent's identity, SSH configuration, and policy. Enable them
through the workspace's `git` declaration.

- [Configuration Reference](#configuration-reference)
  - [`git.email`](#gitemail)
  - [`git.extensions`](#gitextensions)
  - [`git.name`](#gitname)
  - [`git.policy`](#gitpolicy)
  - [`git.signing`](#gitsigning)
  - [`git.ssh.private-keys`](#gitsshprivate-keys)
  - [`git.worktrees`](#gitworktrees)
- [Native Tools](#native-tools)
  - [`agent_system_git`](#agent_system_git)
  - [`agent_system_git_worktree`](#agent_system_git_worktree)
- [CLI](#cli)
  - [`openclaw agent-system tool git`](#openclaw-agent-system-tool-git)
  - [`openclaw agent-system tool worktree -- list`](#openclaw-agent-system-tool-worktree----list)
  - [`openclaw agent-system tool worktree -- prepare`](#openclaw-agent-system-tool-worktree----prepare)
  - [`openclaw agent-system tool worktree -- remove`](#openclaw-agent-system-tool-worktree----remove)
- [Shim](#shim)
- [Launcher Bindings](#launcher-bindings)

## Overview

| Interface                             | Purpose                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `agent_system_git`                    | Model-facing ordinary Git tool                               |
| `agent_system_git_worktree`           | Model-facing managed-worktree tool                           |
| `git`                                 | Packaged compatibility shim on supported agent command paths |
| `openclaw agent-system tool git`      | Explicit operator Git command                                |
| `openclaw agent-system tool worktree` | Explicit operator managed-worktree command                   |

Model-facing tools use the trusted active agent. Direct CLI and shell use are
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

Assigns `allow` or `deny` to exact external helpers such as `git-town`.
The helper must be executable on `PATH`; aliases do not satisfy the declaration,
and built-in protection classification takes precedence. An allowed extension
is trusted for its private argument surface. Undeclared and unsupported
commands are denied; a declared helper that is missing is also denied.

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

The presence of `git.signing` SSH-signs every commit and tag. `key` names one
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

| Field                            | Type                                        | Required | Default                      |
| -------------------------------- | ------------------------------------------- | -------- | ---------------------------- |
| `repositories.local`             | repository-id-to-authoritative-path mapping | no       | none                         |
| `repositories.root`              | path                                        | no       | `.agent-system/repositories` |
| `repositories.working-directory` | path                                        | no       | none                         |
| `root`                           | path                                        | no       | `.agent-system/worktrees`    |

An empty object enables workspace-local managed repositories and worktrees.
Custom roots and local repository overrides are optional:

```yaml
git:
  worktrees:
    root: .agent-system/worktrees
    repositories:
      root: .agent-system/repositories
      local:
        agent-system: ~/tanaab/openclaw-agent-system
```

An explicit `repositories.local` mapping wins. Otherwise, setting
`repositories.working-directory` selects a normal checkout at
`<directory>/<repository-name>`: preparation verifies and reuses an existing checkout
or clones it if missing. Relative paths resolve from the workspace, and `~/` resolves
from the host home. The directory may contain the agent workspace; it cannot be
inside either managed root. Same-name repositories from different owners require
explicit local mappings to separate paths. Full remote host, owner, and repository
identity must match; dirty files are preserved, and failures never fall back to a
different location or overwrite an existing checkout.

Without either setting, managed repositories remain bare clones selected by a
stable repository id. Agent System accepts supported network remotes but rejects
local or credential-bearing clone URLs. Ordinary worktree preparation pins a
repository id to its first source. A declared local override is authoritative: `install` preserves a
missing path as drift so ordered setup can create it, while non-repositories,
symlinks, and other unsafe paths fail closed. Managed worktree preparation
still requires every declared local override to be a ready repository. Use a
remote base such as `origin/main` to start from the latest fetched branch.

Install creates a missing working directory and inspects existing ownership and
permissions without changing them. Preparation retains interrupted clone state for
retry; an incomplete temporary clone requires operator inspection before retrying.
OpenClaw uses its managed Git runner. [Standalone Codex](../../CODEX.md#issue-assessment)
uses native host authorization and separately verifies saved project registration.

Preparation is serialized per repository; concurrent callers reuse the same
worktree, while different repositories can prepare independently. Waiting callers
honor cancellation and stop after ten minutes if the repository remains busy.
See the [worktree example](https://github.com/tanaabased/openclaw-agent-system/blob/main/examples/worktree/README.md)
for lock-loss and recovery checks.

Without `git.ssh`, canonical HTTPS supports public repositories. With `git.ssh`,
all managed worktree interfaces derive `git@github.com:<owner>/<repository>.git`
from canonical GitHub HTTPS URLs and use isolated SSH credentials. Configure SSH
before enabling private-repository notification delivery. Channel-specific origin
changes and retirement follow the [notification worktree lifecycle](../../channels/github/ADVANCED.md#managed-worktrees).

`install` creates workspace-local roots with owner-only permissions and adds
them to `.gitignore`; tracked, symlinked, overlapping, or ineffectively ignored
roots fail installation. Worktrees use deterministic paths and Git's own state,
while `doctor` checks the configured roots, ignore state, and local overrides.

## Native Tools

### `agent_system_git`

Run ordinary Git commands using the trusted active agent. Configuration and
[policy](#gitpolicy) apply to native and CLI calls alike.

#### Parameters

| Parameter | Type         | Required | Default         | Description                                                                            |
| --------- | ------------ | -------- | --------------- | -------------------------------------------------------------------------------------- |
| `argv`    | string array | yes      | none            | 1–256 Git arguments, without the `git` executable.                                     |
| `cwd`     | string       | no       | agent workspace | Working directory within the workspace or configured worktree root; 1–4096 characters. |
| `stdin`   | string       | no       | none            | Ordinary command input, at most 64 KiB; never credentials.                             |

#### Usage

Inspect the active workspace:

```json
{ "argv": ["status", "--short"] }
```

For a managed checkout, pass its returned canonical path as `cwd`. Results include
`exitCode`, `stdout`, `stderr`, and `truncated`.

### `agent_system_git_worktree`

Prepare, list, or remove managed worktrees when [`git.worktrees`](#gitworktrees)
is enabled. The trusted tool context supplies the agent and workspace.

#### Parameters

| Parameter      | Type                        | Required                          | Default                     | Description                                                                                    |
| -------------- | --------------------------- | --------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `action`       | `list`, `prepare`, `remove` | yes                               | none                        | Worktree operation.                                                                            |
| `baseRef`      | string                      | for `prepare`                     | none                        | Git base ref, such as `origin/main`.                                                           |
| `repository`   | object                      | for `prepare`                     | none                        | `{ id, cloneUrl? }`; the URL may be omitted for an already known or declared local repository. |
| `repositoryId` | string                      | for `remove`; optional for `list` | all repositories for `list` | Stable managed repository ID.                                                                  |
| `workId`       | string                      | for `prepare` and `remove`        | none                        | Stable work ID; see [naming](#openclaw-agent-system-tool-worktree----prepare).                 |

Identifiers and refs are 1–256 characters, cannot start with `-`, and cannot have
surrounding whitespace or control characters. `cloneUrl` is at most 4096 characters.
Each action accepts only its own parameters; unknown fields are rejected.

#### Usage

Prepare a checkout, then use its returned path with `agent_system_git`:

```json
{
  "action": "prepare",
  "repository": {
    "id": "agent-system",
    "cloneUrl": "https://github.com/tanaabased/openclaw-agent-system.git"
  },
  "workId": "123-fix-agent-path-resolution",
  "baseRef": "origin/main"
}
```

Use `{"action":"list"}` to inspect managed worktrees. Removal requires
`action: remove`, `repositoryId`, and `workId`; dirty checkouts, branches, and refs
remain intact.

## CLI

These are operator commands; agents use `agent_system_git` and
`agent_system_git_worktree`. See the [shared trust boundary](../../CLI.md#trust-boundary)
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

### `openclaw agent-system tool worktree -- list`

List current agent-owned worktrees from Git without changing them.

#### Options

| Option or argument | Required | Default                   | Description                                                |
| ------------------ | -------- | ------------------------- | ---------------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery       | Use the exact configured workspace for an installed agent. |
| `[repository-id]`  | no       | all agent-owned worktrees | Limit the listing to one repository.                       |

#### Usage

```text
openclaw agent-system tool worktree [--agent <id>] -- list [repository-id]
```

```sh
# list worktrees for one repository.
openclaw agent-system tool worktree -- list agent-system
```

### `openclaw agent-system tool worktree -- prepare`

Prepare or reuse a deterministic managed worktree.

#### Options

| Option or argument  | Required | Default                  | Description                                                                     |
| ------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------- |
| `--agent <id>`      | no       | workspace discovery      | Use the exact configured workspace for an installed agent.                      |
| `--clone-url <url>` | no       | saved or declared source | Provide the source for a new managed repository.                                |
| `<base-ref>`        | yes      | none                     | Base ref; use a remote ref such as `origin/main` for the latest fetched branch. |
| `<repository-id>`   | yes      | none                     | Select the managed repository or declared local override.                       |
| `<work-id>`         | yes      | none                     | Stable work identity; prefer `<task-id>-<brief-kebab-case-description>`.        |

#### Usage

```text
openclaw agent-system tool worktree [--agent <id>] -- prepare <repository-id> <work-id> <base-ref> [--clone-url <url>]
```

```sh
# prepare a checkout from the latest remote branch.
openclaw agent-system tool worktree -- prepare agent-system 123-fix-agent-path-resolution origin/main \
  --clone-url https://github.com/tanaabased/openclaw-agent-system.git
```

Preparation is idempotent.

For ordinary managed work, Agent System names both the branch and directory
`<work-id-slug>-<digest>`. Prefer `<task-id>-<brief-kebab-case-description>` for
the work id when a description is available; otherwise use `<task-id>`.
See [notification worktrees](../../channels/github/ADVANCED.md#managed-worktrees)
for issue branch naming and retirement.

### `openclaw agent-system tool worktree -- remove`

Remove one clean managed checkout using non-forced Git removal.

#### Options

| Option or argument | Required | Default             | Description                                                |
| ------------------ | -------- | ------------------- | ---------------------------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Use the exact configured workspace for an installed agent. |
| `<repository-id>`  | yes      | none                | Select the repository.                                     |
| `<work-id>`        | yes      | none                | Select the stable work identity.                           |

#### Usage

```text
openclaw agent-system tool worktree [--agent <id>] -- remove <repository-id> <work-id>
```

```sh
# remove the clean checkout without deleting its branch or remote refs.
openclaw agent-system tool worktree -- remove agent-system 123-fix-agent-path-resolution
```

Dirty worktrees, branches, and refs remain intact.

## Shim

Installation projects the packaged `git` shim onto supported agent command
paths:

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

Agent-bound Gateway and setup children receive absolute executable paths:

| Variable                    | Available when                | Purpose                             |
| --------------------------- | ----------------------------- | ----------------------------------- |
| `AGENT_SYSTEM_GIT`          | Git is configured             | Require managed Git execution.      |
| `AGENT_SYSTEM_GIT_WORKTREE` | `git.worktrees` is configured | Require managed worktree execution. |

```sh
# require the bound agent's git identity and policy without host fallback.
"$AGENT_SYSTEM_GIT" status --short

# list worktrees through the bound managed route.
"$AGENT_SYSTEM_GIT_WORKTREE" list
```

These launchers require active-agent authority under the shared
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
