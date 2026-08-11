# Agent System Git Tools

<p align="center">
  <img src="../../skills/git-cli/agents/assets/icon-large.svg" alt="Agent System Git" width="180" />
</p>

The Git capability runs ordinary noninteractive `git` commands and manages
durable worktrees with the active agent's declared identity, workspace, SSH
configuration, and operation policy. It is the preferred Git path when an Agent
System workspace declares `git`.

[Agent System](../../README.md) · [Raw Git skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-cli/SKILL.md) · [Raw worktree skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-worktree/SKILL.md)

## Overview

One shared runtime provides five Git interfaces:

| Interface                             | Purpose                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `agent_system_git`                    | Model-facing ordinary Git tool                               |
| `agent_system_git_worktree`           | Model-facing managed-worktree tool                           |
| `openclaw agent-system tool git`      | Explicit operator Git command                                |
| `openclaw agent-system tool worktree` | Explicit operator managed-worktree command                   |
| `git`                                 | Packaged compatibility shim on supported agent command paths |

The model-facing tools bind requests to trusted OpenClaw agent context. The CLI
and shim are operator interfaces that select an agent by option or workspace.
Every interface applies policy, resolves the selected identity, and launches the
real `git` without a shell.

## Requirements

- Agent System installed and enabled
- Git available as `git`
- An Agent System workspace manifest with `git` configured
- An effective Git name and email declared by `git` or `agent`
- OpenSSH when keys are configured: `ssh` for authentication, `ssh-agent` and `ssh-add` for authentication or signing, and `ssh-keygen` for signing

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
    town: ask
  ssh:
    private-keys:
      from-environment: GIT_SSH_PRIVATE_KEY
  signing:
    key: GIT_SIGNING_KEY
    allowed-signers-file: .agent-system/allowed_signers
  policy:
    delete: ask
    discard: ask
    force: deny
    rewrite: ask
    unknown: deny
```

### `git.name`

| Type                               | Required | Default      |
| ---------------------------------- | -------- | ------------ |
| string or `from-environment` value | no       | `agent.name` |

Sets both author and committer name for the Git child. Agent System does not
fall through to repository, global, or system Git identity.

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

Assigns `allow`, `ask`, or `deny` to exact external helpers such as `git-town`.
The helper must be executable on `PATH`; aliases do not satisfy the declaration,
and built-in hazard classification takes precedence. An allowed extension is
trusted for its private argument surface. Undeclared and unsupported commands
follow `git.policy.unknown`; a declared helper that is missing is denied.

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
[environment contract](../../ADVANCED.md#environment), so the Git schema does
not duplicate `from-op`. Encrypted keys are not yet supported. Agent System
isolates the declared keys from ambient SSH identities and presents them only
when Git uses SSH transport. Each invocation loads them into an isolated
`ssh-agent`, exposes no generic SSH socket to Git, and removes its resources
before returning. Run `openclaw agent-system doctor` to check OpenSSH readiness.

### `git.signing`

| Field                  | Type                    | Required | Default |
| ---------------------- | ----------------------- | -------- | ------- |
| `key`                  | environment binding     | yes      | none    |
| `allowed-signers-file` | workspace-relative path | no       | none    |

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

### `git.worktrees`

| Field                | Type                                   | Required | Default                      |
| -------------------- | -------------------------------------- | -------- | ---------------------------- |
| `root`               | path                                   | no       | `.agent-system/worktrees`    |
| `repositories.root`  | path                                   | no       | `.agent-system/repositories` |
| `repositories.local` | repository-id-to-existing-path mapping | no       | none                         |

An empty object enables workspace-local managed repositories and worktrees.
Custom roots and existing local repository overrides are optional:

```yaml
git:
  worktrees:
    root: .agent-system/worktrees
    repositories:
      root: .agent-system/repositories
      local:
        agent-system: ~/tanaab/openclaw-agent-system
```

Managed repositories are bare clones selected by a stable repository id. Agent
System accepts supported network remotes but rejects local or credential-bearing
clone URLs. A repository id retains its first source; a declared local override
is authoritative and fails closed when unavailable or unsafe. Use a remote base
such as `origin/main` to start from the latest fetched branch.

`install` creates workspace-local roots with owner-only permissions and adds
them to `.gitignore`; tracked, symlinked, overlapping, or ineffectively ignored
roots fail installation. Worktrees use deterministic paths and Git's own state,
while `doctor` checks the configured roots, ignore state, and local overrides.

### `git.policy`

| Field     | Values                 | Default | Covers                                                 |
| --------- | ---------------------- | ------- | ------------------------------------------------------ |
| `force`   | `allow`, `ask`, `deny` | `deny`  | Explicit safety overrides and forced ref replacement   |
| `rewrite` | `allow`, `ask`, `deny` | `deny`  | History replacement through rebase, amend, or reset    |
| `discard` | `allow`, `ask`, `deny` | `deny`  | Loss of working-tree, index, untracked, or stash state |
| `delete`  | `allow`, `ask`, `deny` | `deny`  | Ref, worktree, reflog, or unreachable-object deletion  |
| `unknown` | `allow`, `ask`, `deny` | `deny`  | Aliases, undeclared helpers, or unsupported syntax     |

Supported public reads and ordinary writes are allowed. Hazard selectors take
precedence and one invocation may select several policies; every selected
policy must allow the operation. For example, a force push selects `force` and
`rewrite`, while `reset --hard` selects `rewrite` and `discard`.

Prefer `switch` for branches and `restore` for paths because ambiguous `checkout`
forms select `discard`. `unknown: allow` permits aliases and undeclared external
helpers, so prefer exact `git.extensions` declarations. `ask` works only through
the model-facing tools during an OpenClaw agent turn; direct CLI and shim routes
reject operations requiring approval.

Agent System disables operator-global and system Git configuration, prompts,
hooks, pagers, and editors and rejects configuration, executable, credential,
and working-directory escape paths. Repository configuration can still name
helpers, filters, aliases, and diff programs, so the wrapper does not make an
untrusted checkout safe. Raw `git worktree` access permits only read-only
`list`; use the managed worktree tool for lifecycle changes.

## CLI

These are trusted operator interfaces for administration, testing, and
debugging. Agents should use `agent_system_git` and
`agent_system_git_worktree`; an agent with unrestricted host command access
could otherwise select another installed agent.

### Usage

```text
openclaw agent-system tool git [--agent <id>] -- <git-arguments...>
openclaw agent-system tool worktree [--agent <id>] -- prepare <repository-id> <work-id> <base-ref> [--clone-url <url>]
openclaw agent-system tool worktree [--agent <id>] -- list [repository-id]
openclaw agent-system tool worktree [--agent <id>] -- remove <repository-id> <work-id>
```

```sh
# inspect git from the current repository directory.
openclaw agent-system tool git -- status --short

# select an installed agent from a declared local repository.
openclaw as tool git --agent tanaabot -- status --short

# prepare a deterministic worktree from the latest remote branch.
openclaw agent-system tool worktree -- prepare agent-system 123-fix-agent-path-resolution origin/main \
  --clone-url https://github.com/tanaabased/openclaw-agent-system.git

# list current agent-owned worktrees from git.
openclaw agent-system tool worktree -- list agent-system

# request removal; direct cli requires git.policy.delete: allow.
openclaw agent-system tool worktree -- remove agent-system 123-fix-agent-path-resolution
```

### Behavior

Arguments after `--` pass through unchanged with the child's streams and exit
code. Native tools remain contained to the agent workspace and configured
worktree root. Trusted operator commands using `--agent` may also run inside an
existing local repository declared under `git.worktrees.repositories.local`;
undeclared paths remain unavailable.

`prepare` is idempotent, `list` is read-only, and `remove` uses non-forced Git
removal. Dirty worktrees, branches, and refs remain intact.

Agent System names both the branch and directory `<work-id-slug>-<digest>`.
Prefer `<task-id>-<brief-kebab-case-description>` for the work id when a
description is available; otherwise use `<task-id>`.

## Shim

Installation projects the packaged `git` shim onto supported agent command
paths:

```sh
# confirm that this git belongs to agent system.
git --agent-system

# delegate an ordinary git command through the shared tool runtime.
git status --short
```

The shim delegates through the packaged `agent-system-tool` launcher, which
passes arguments to `openclaw agent-system tool git`, exports its canonical
directory, and preserves the caller's directory. The runtime excludes managed
command paths when resolving the real `git` to prevent wrapper recursion.

The shim is an operator-compatible routing convenience, not an agent security
boundary. Absolute binaries, replaced `PATH` values, and unrelated host
processes can bypass it.

## Further Reading

- [Agent System README](../../README.md): installation and the common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest, configuration, CLI, environment, and path references
- [Development](../../DEVELOPMENT.md#logging): runtime logging during development
- [Raw Git skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-cli/SKILL.md): model-facing Git guidance
- [Git worktree skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-worktree/SKILL.md): model-facing worktree guidance

The Git logo is by [Jason Long](https://git-scm.com/downloads/logos) and is
licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The
packaged mark preserves the official geometry and uses the Agent System brand
color.
