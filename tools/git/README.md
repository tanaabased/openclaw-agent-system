# Agent System Git Tools

<p align="center">
  <img src="../../assets/git-icon-large.svg" alt="Agent System Git" width="180" />
</p>

The Git capability runs ordinary noninteractive `git` commands and manages
durable worktrees with the active agent's declared identity, workspace, SSH
configuration, and operation policy. It is the preferred Git path when an Agent
System workspace declares `git`.

## Overview

One shared runtime provides five Git interfaces:

| Interface                             | Purpose                                                      |
| ------------------------------------- | ------------------------------------------------------------ |
| `agent_system_git`                    | Model-facing ordinary Git tool                               |
| `agent_system_git_worktree`           | Model-facing managed-worktree tool                           |
| `openclaw agent-system tool git`      | Explicit operator Git command                                |
| `openclaw agent-system tool worktree` | Explicit operator managed-worktree command                   |
| `git`                                 | Packaged compatibility shim on supported agent command paths |

The model-facing tools bind requests to trusted OpenClaw agent context. Direct
CLI use is an operator interface that selects an agent by option or workspace.
Inside a Gateway-hosted native agent command, the shim instead redeems a
short-lived capability that fixes the active agent. An OpenClaw-hosted Codex
`exec_command` descendant is fixed to the agent whose configured app-server home
matches its `CODEX_HOME`. Both routes apply policy and launch the real `git`
without a shell.

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

Assigns `allow` or `deny` to exact external helpers such as `git-town`.
The helper must be executable on `PATH`; aliases do not satisfy the declaration,
and built-in protection classification takes precedence. An allowed extension
is trusted for its private argument surface. Undeclared and unsupported
commands are denied; a declared helper that is missing is also denied.

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

The GitHub notifications channel uses this same managed-worktree service.
Without `git.ssh`, canonical HTTPS supports public repositories. When `git.ssh`
is configured, the channel derives the equivalent
`git@github.com:<owner>/<repository>.git` remote and uses the isolated SSH
resource. Configure `git.ssh` before enabling automatic notification delivery
for private repositories.

`install` creates workspace-local roots with owner-only permissions and adds
them to `.gitignore`; tracked, symlinked, overlapping, or ineffectively ignored
roots fail installation. Worktrees use deterministic paths and Git's own state,
while `doctor` checks the configured roots, ignore state, and local overrides.

### `git.policy`

| Field               | Values          | Default | Covers                                                        |
| ------------------- | --------------- | ------- | ------------------------------------------------------------- |
| `force-push`        | `allow`, `deny` | `deny`  | `--force`, `-f`, `--force-with-lease`, and positive refspecs  |
| `delete-remote-ref` | `allow`, `deny` | `deny`  | `--delete`, `-d`, `--prune`, deletion refspecs, and mirroring |

The defaults need no manifest entry. Add only a field that this agent should be
able to exercise; omitted fields remain denied:

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
fields, so both must be `allow`. Abbreviated protected long options and bundled
protected short options select the same fields. A denial identifies every
controlling policy field and explains that an operator must change each one
before retrying.

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

# remove one clean managed checkout without changing delete policy.
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

In direct shells the shim remains an operator-compatible routing convenience.
As a descendant of a Gateway-hosted native or Codex agent command, it must prove
the active-agent binding and may run only in that agent's workspace, declared
local repositories, or managed worktree root. A later `cd` cannot switch agent
identity. Absolute binaries, replaced `PATH` values, and unrelated host processes
can still bypass the shim.

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
