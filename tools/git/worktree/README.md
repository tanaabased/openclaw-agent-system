# Agent System Git Worktree Tool

<p align="center">
  <img src="../../../skills/git-worktree/assets/icon-large.svg" alt="Agent System Git Worktree" width="180" />
</p>

Prepare, list, and remove durable managed worktrees with the active agent's Git
identity. Use this guide to configure and manage worktrees. See the
[Git guide](../README.md) for identity, SSH, signing, and policy.

- [Requirements](#requirements)
- [Configuration](#configuration)
- [`agent_system_git_worktree`](#agent_system_git_worktree)
- [CLI](#cli)
- [Launcher Bindings](#launcher-bindings)

## Requirements

Use the [Git prerequisites](../README.md#requirements) and enable `git.worktrees`
in the workspace manifest. The native tool and CLI below use OpenClaw's managed
Git runner. Standalone Codex uses native host authorization and its own worktree
lifecycle; see [Codex issue setup](../../../CODEX.md#issue-assessment).

## Configuration

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

An explicit `repositories.local` mapping wins. Codex issue dispatch uses
`github-<repository-database-id>` as the mapping key and verifies the full GitHub
repository identity. Otherwise, setting
`repositories.working-directory` selects a normal checkout at
`<directory>/<repository-name>`: preparation verifies and reuses an existing checkout
or clones it if missing. Relative paths resolve from the workspace, and `~/` resolves
from the host home. The directory may contain the agent workspace; it cannot be
inside either managed root. Same-name repositories from different owners require
explicit local mappings to separate paths. Full remote host, owner, and repository
identity must match; dirty files are preserved, and failures never fall back to a
different location or overwrite an existing checkout.

A later configuration change may select another location for the same repository;
previous checkouts are preserved. An interrupted temporary clone must first be
recovered at its original location. Codex assignments already preparing a repository
retain their original path; see [issue assessment recovery](../../../CODEX.md#issue-assessment).

Without either setting, managed repositories remain bare clones selected by a
stable repository id. Agent System accepts supported network remotes but rejects
local or credential-bearing clone URLs. Ordinary worktree preparation pins a
repository id to its first source. A declared local override fixes the repository location. Install reports a missing
path as drift so setup can create it; non-repositories, symlinks, and other unsafe
paths stop the operation. Managed worktree preparation
still requires every declared local override to be a ready repository. Use a
remote base such as `origin/main` to start from the latest fetched branch.

Install creates a missing working directory without changing existing ownership or
permissions. Recover interrupted clones at their original location before retrying.

Without `git.ssh`, canonical HTTPS supports public repositories. With `git.ssh`,
all managed worktree interfaces derive `git@github.com:<owner>/<repository>.git`
from canonical GitHub HTTPS URLs and use isolated SSH credentials. Configure SSH
before enabling private-repository notification work.

`install` creates workspace-local roots with owner-only permissions and adds
them to `.gitignore`; tracked, symlinked, overlapping, or ineffectively ignored
roots fail installation. Worktrees use deterministic paths and Git's own state,
while `doctor` checks the configured roots, ignore state, and local overrides.

## `agent_system_git_worktree`

Prepare, list, or remove managed worktrees when [`git.worktrees`](#gitworktrees)
is enabled. The trusted tool context supplies the agent and workspace.

### Parameters

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

### Usage

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

These are operator commands; OpenClaw agents use `agent_system_git_worktree`.
See the [shared trust boundary](../../../CLI.md#trust-boundary) for identity binding
and host-access limits.

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

Repeating preparation reuses the existing worktree.

For ordinary managed work, Agent System names both the branch and directory
`<work-id-slug>-<digest>`. Prefer `<task-id>-<brief-kebab-case-description>` for
the work id when a description is available; otherwise use `<task-id>`.
Native issue workflows retain their worktree binding in the owning runtime.

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

## Launcher Bindings

Agent-bound Gateway and setup children receive `AGENT_SYSTEM_GIT_WORKTREE` when
`git.worktrees` is configured. It is an absolute executable path that requires
active-agent authority and has no host fallback.

```sh
# list worktrees through the bound managed route.
"$AGENT_SYSTEM_GIT_WORKTREE" list
```

See the [execution boundary](../../../CLI.md#trust-boundary).
