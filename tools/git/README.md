# Agent System Git Tool

<p align="center">
  <img src="../../skills/git-cli/agents/assets/icon-large.svg" alt="Agent System Git" width="180" />
</p>

The Git tool runs ordinary noninteractive `git` commands and manages durable
Git worktrees with the active agent's declared identity, contained workspace,
optional isolated SSH identity, SSH commit and tag signing, and operation
policy. It is the preferred Git path when an Agent System workspace declares
`git`.

[Agent System](../../README.md) · [Raw Git skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-cli/SKILL.md) · [Raw worktree skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-worktree/SKILL.md)

## Overview

The Git capability provides two model-facing tools and their operator routes:

| Interface                             | Purpose                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `agent_system_git`                    | Model-facing ordinary Git tool                               |
| `agent_system_git_worktree`           | Model-facing managed-worktree lifecycle tool                 |
| `openclaw agent-system tool git`      | Explicit ordinary Git command                                |
| `openclaw agent-system tool worktree` | Explicit managed-worktree command                            |
| `git`                                 | Packaged compatibility shim on supported agent command paths |

Every interface binds the request to one trusted agent workspace, applies the
configured operation policy, resolves the effective agent identity, and
launches the real `git` executable without a shell.

## Requirements

- Agent System installed and enabled
- Git available as `git`
- An Agent System workspace manifest with `git` configured
- An effective Git name and email declared by `git` or `agent`
- OpenSSH `ssh`, `ssh-agent`, and `ssh-add` when managed authentication keys are configured
- OpenSSH `ssh-agent`, `ssh-add`, and `ssh-keygen` when signing is configured

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

Assigns `allow`, `ask`, or `deny` to named external Git helpers. A key such as
`town` applies only when `git-town` is executable on the effective process
`PATH`; repository aliases do not satisfy the declaration. Built-in command
and hazard classification takes precedence over a matching extension name.
Agent System masks the same alias name in command-scoped configuration so a
missing or disappearing helper cannot fall back to repository alias content.

An allowed extension is trusted for its complete private argument surface,
which Agent System cannot classify. An undeclared command falls through to
`git.policy.unknown`; an exact decision can therefore permit one helper while
the remaining extension surface stays denied. A declared helper that is not
executable is denied rather than falling back to an alias.

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
can supply the key. For example:

```yaml
environment:
  set:
    GIT_SSH_PRIVATE_KEY:
      from-op: 'op://vault/item/private key?ssh-format=openssh'

git:
  ssh:
    private-keys:
      from-environment: GIT_SSH_PRIVATE_KEY
```

The Git schema does not duplicate `from-op`; secret acquisition belongs to the
shared environment contract. Encrypted keys are not yet supported.

Every authorized Git invocation with managed authentication starts a fresh
isolated `ssh-agent` and loads the selected keys through standard input. Agent
System projects its fixed `GIT_SSH` helper for the complete invocation, and Git
calls that helper only when an operation actually uses SSH transport. The Git
child receives no generic `SSH_AUTH_SOCK`; the helper selects only the declared
authentication identities through a private SSH configuration. Agent System
removes the agent and temporary directory before the tool call completes. Run
`openclaw agent-system doctor` to check installed-host OpenSSH readiness.

### `git.signing`

| Field                  | Type                    | Required | Default |
| ---------------------- | ----------------------- | -------- | ------- |
| `key`                  | environment binding     | yes      | none    |
| `allowed-signers-file` | workspace-relative path | no       | none    |

The presence of `git.signing` SSH-signs every commit and tag. `key` names one
variable in the completed Agent System environment; it is never private-key
material itself and does not accept a literal value, path, array, or nested
`from-environment` object:

```yaml
environment:
  set:
    GIT_SIGNING_KEY:
      from-op: 'op://vault/item/private key?ssh-format=openssh'

git:
  signing:
    key: GIT_SIGNING_KEY
    allowed-signers-file: .agent-system/allowed_signers
```

Every authorized Git invocation with signing configured loads the key through
standard input into a dedicated invocation-scoped `ssh-agent`. Agent System
projects Git's `gpg.ssh.defaultKeyCommand` and `gpg.ssh.program` helpers, and Git
calls them only when it selects or uses an SSH signing key. The Git child
receives no generic `SSH_AUTH_SOCK`; each helper selects the signing agent only
for its own process. Signing-control arguments are rejected so a tool call
cannot disable signing or select another key. Authentication and signing use
separate agents even when both declarations name the same underlying key.

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

An empty object enables workspace-local managed repositories and worktrees:

```yaml
git:
  worktrees: {}
```

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

Managed repositories are bare clones selected by a bounded repository id.
Agent System accepts supported network Git remotes without a host allowlist,
but rejects local paths, `file:` URLs, option-like values, embedded credentials,
query strings, fragments, control characters, and shell fragments. The first
source stored for one repository id becomes immutable provenance. A declared
local override is authoritative and fails closed if it becomes unavailable or
unsafe, including when it is nested under a managed root, rather than silently
falling back to a managed clone. Managed fetches update
`refs/remotes/origin/*` without overwriting worktree branches; use a base such
as `origin/main` when work should begin from the latest fetched remote branch.

Workspace-local roots are owned by the installed agent. `install` creates them
with owner-only permissions and appends their entries to the workspace
`.gitignore`. It refuses tracked, symlinked, overlapping, or ineffectively
ignored roots. Agent System does not write editor-specific exclusion settings.

Active worktrees are Git state, not manifest desired state. Agent System uses
the configured repository mapping, deterministic paths, repository origin, and
`git worktree list --porcelain`; it does not keep a parallel state database.
`doctor` checks only the roots, workspace ignore state, and local overrides.

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

`checkout` is ambiguous between branch switching and path restoration. Prefer
`switch` for branches and `restore` for paths; otherwise Agent System treats the
ambiguous form as `discard`. Public command families with internal or
destructive syntax remain effect-classified or `unknown`; low-level plumbing is
not automatically trusted. `unknown: allow` permits Git to discover aliases and
undeclared `git-*` helpers, so prefer exact `git.extensions` declarations.
`ask` works only through `agent_system_git` during an OpenClaw agent turn;
direct CLI and shim invocations reject operations that require an approval
conversation.

Agent System disables operator-global and system Git configuration, terminal
prompts, hooks, pagers, and editors for the child. Managed SSH also bypasses
ambient SSH configuration and identities while retaining normal host-key
verification. It rejects command-line
configuration, executable, credential, and working-directory escape paths. A
repository's own Git configuration can still name helpers, filters, aliases,
and diff programs, so the wrapper does not make an untrusted checkout safe.

Raw `git worktree` access permits only read-only `list`. Managed lifecycle
changes use the semantic worktree interface, which derives and verifies every
repository, ref, destination, and registered-worktree operand before invoking
Git.

## CLI

```text
openclaw agent-system tool git [--agent <id>] -- <git-arguments...>
```

```sh
# preserve a nested repository directory and inspect the working tree.
openclaw agent-system tool git -- status --short

# select one installed agent outside its workspace; execution starts at its root.
openclaw as tool git --agent tanaabot -- status --short
```

Arguments after `--` pass to `git` unchanged. Child standard output and error
pass through directly, and the child exit code is preserved. Native tool calls
may provide a `cwd` inside the agent workspace or configured worktree root;
canonical path checks reject parent and symlink traversal outside those roots.
Commands under a workspace-local worktree retain ordinary manifest discovery.
An external worktree root requires trusted native agent context or an explicit
operator `--agent` selection.

## Managed Worktrees

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

# repeat the request without relocating or recreating the existing worktree.
openclaw agent-system tool worktree -- prepare agent-system task-123 origin/main \
  --clone-url https://github.com/tanaabased/openclaw-agent-system.git

# list current agent-owned worktrees from git.
openclaw agent-system tool worktree -- list agent-system

# ask git to remove the deterministic worktree without force.
openclaw agent-system tool worktree -- remove agent-system task-123
```

`prepare` is an ordinary write, `list` is a read, and `remove` selects
`git.policy.delete`; direct CLI use cannot complete an `ask` decision.
Preparation returns the canonical path to pass explicitly as `cwd` on later
`agent_system_git` calls. Removal invokes ordinary non-forced
`git worktree remove`; Git refuses dirty or otherwise unsafe removal. Agent
System does not force removal, delete the branch or refs, prune state, or keep
conversation attachment state.

## Shim

Installation projects the packaged `git` shim onto supported agent command
paths:

```sh
# confirm that this git belongs to agent system.
git --agent-system

# delegate an ordinary git command through the shared tool runtime.
git status --short
```

The shim delegates through the reusable packaged `agent-system-tool` launcher,
which passes arguments to `openclaw agent-system tool git`, exports the
canonical launcher directory, and preserves the caller's directory. The runtime
resolves the real `git` executable while excluding Agent System-managed command
paths to prevent wrapper recursion.

The shim is routing convenience, not universal interception. Absolute binaries,
replaced `PATH` values, and unrelated host processes can bypass it.

## Further Reading

- [Agent System README](../../README.md): installation and the common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest, configuration, CLI, environment, and path references
- [Git tool specification](./SPEC.md): detailed identity, policy, SSH, and signing design
- [Raw Git skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-cli/SKILL.md): model-facing Git guidance
- [Git worktree skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-worktree/SKILL.md): model-facing worktree guidance

The Git logo is by [Jason Long](https://git-scm.com/downloads/logos) and is
licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The
packaged mark preserves the official geometry and uses the Agent System brand
color.
