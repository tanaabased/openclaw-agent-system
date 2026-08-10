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

The capability provides two model-facing tools:

| Tool                        | Purpose                               |
| --------------------------- | ------------------------------------- |
| `agent_system_git`          | Ordinary Git operations               |
| `agent_system_git_worktree` | Managed-worktree lifecycle operations |

Operators can use the equivalent `openclaw agent-system tool git` and
`openclaw agent-system tool worktree` commands. Installation also projects a
packaged `git` shim onto supported agent command paths. Every route binds the
request to one trusted agent workspace, applies policy, resolves the effective
identity, and launches the real `git` executable without a shell.

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
when Git uses SSH transport. Run `openclaw agent-system doctor` to check
installed-host OpenSSH readiness.

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

Agent System isolates the signing key from ambient SSH state. Signing-control
arguments are rejected so a tool call cannot disable signing or select another
key. Authentication and signing remain separate even when they use the same
underlying key.

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

### Ordinary Git

```text
openclaw agent-system tool git [--agent <id>] -- <git-arguments...>
```

```sh
# preserve a nested repository directory and inspect the working tree.
openclaw agent-system tool git -- status --short

# select one installed agent outside its workspace; execution starts at its root.
openclaw as tool git --agent tanaabot -- status --short
```

Arguments after `--` pass to `git` unchanged. Standard streams and the child
exit code are preserved. Native tool calls may provide a `cwd` inside the agent
workspace or configured worktree root; parent and symlink traversal outside
those roots is rejected. External worktree roots require trusted native agent
context or an explicit operator `--agent` selection.

### Managed Worktrees

Operator worktree lifecycle uses the registered `worktree` tool command rather
than a special CLI hierarchy or raw Git mutation:

```text
openclaw agent-system tool worktree [--agent <id>] -- prepare <repository-id> <work-id> <base-ref> [--clone-url <url>] [--branch <branch>]
openclaw agent-system tool worktree [--agent <id>] -- list [repository-id]
openclaw agent-system tool worktree [--agent <id>] -- remove <repository-id> <work-id>
```

```sh
# clone or fetch a managed repository and prepare one deterministic worktree.
openclaw agent-system tool worktree -- prepare agent-system task-123 origin/main \
  --clone-url https://github.com/tanaabased/openclaw-agent-system.git

# list current agent-owned worktrees from git.
openclaw agent-system tool worktree -- list agent-system

# ask git to remove the deterministic worktree without force.
openclaw agent-system tool worktree -- remove agent-system task-123
```

`prepare` is an ordinary write, `list` is a read, and `remove` selects
`git.policy.delete`; direct CLI use cannot complete an `ask` decision.
Preparation is idempotent and returns the canonical path to pass as `cwd` on
later `agent_system_git` calls. Removal uses non-forced `git worktree remove`,
so Git refuses dirty or otherwise unsafe removal. Agent System does not delete
the branch or refs, prune state, or maintain conversation attachment state.

## Shim

Installation projects the packaged `git` shim onto supported agent command
paths:

```sh
# confirm that this git belongs to agent system.
git --agent-system

# delegate an ordinary git command through the shared tool runtime.
git status --short
```

The shim delegates to `openclaw agent-system tool git`, preserves the caller's
directory, and excludes Agent System-managed command paths when resolving the
real executable to prevent wrapper recursion.

The shim is routing convenience, not universal interception. Absolute binaries,
replaced `PATH` values, and unrelated host processes can bypass it.

## Further Reading

- [Agent System README](../../README.md): installation and the common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest, configuration, CLI, environment, and path references
- [Raw Git skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-cli/SKILL.md): model-facing Git guidance
- [Git worktree skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-worktree/SKILL.md): model-facing worktree guidance

The Git logo is by [Jason Long](https://git-scm.com/downloads/logos) and is
licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The
packaged mark preserves the official geometry and uses the Agent System brand
color.
