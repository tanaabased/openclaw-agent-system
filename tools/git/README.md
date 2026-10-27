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

## Requirements

- Agent System installed and enabled
- Git available as `git`
- An Agent System workspace manifest with `git` configured
- An effective Git name and email declared by `git` or `agent`
- OpenSSH when keys are configured: `ssh` for authentication, `ssh-agent` and `ssh-add` for authentication or signing, and `ssh-keygen` for signing

> [!IMPORTANT]
> The remote server decides which operations your agent may perform. Agent System
> adds the specific controls documented under [`git.policy`](#gitpolicy); a local
> `allow` cannot override a server denial.

## Configuration Reference

Declare `git` in the [workspace manifest](../../MANIFEST.md#discovery):

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

Sets the author and committer email for Git commands. A missing or unresolved
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

Sets the author and committer name for Git commands. Agent System does not
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

Supported public reads and recognized ordinary writes are allowed, including local
branch and tag deletion, cleanup, discard, rebase, amend, and reset.

> [!WARNING]
> These operations can discard local work. Agent System's remote protections do not
> prevent local data loss; use Git's recovery tools and your repository's review workflow.

Protected remote effects take precedence. `git push --mirror` selects both
fields, so both must be `allow`.

For GitHub remotes, use
[branch and tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
for server-side protection. A local `allow` cannot override a remote denial.
External helpers still require an exact [`git.extensions`](#gitextensions) declaration.

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

Commands cannot disable configured signing or select another key. Signing and
SSH authentication remain separate even when they use the same key.

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
can supply the key. Use the shared
[environment settings](../../MANIFEST.md#environment-resolution) for `from-op` bindings;
`git.ssh.private-keys` does not accept them directly. Encrypted keys are not yet supported. Agent System
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

In a session bound to a registered worktree under the managed bare-repository
layout, omitted and relative `cwd` values use that worktree. Otherwise they use the
agent workspace. Identity and policy always come from the agent workspace.

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

Agent-bound Gateway and setup children receive `AGENT_SYSTEM_GIT` when Git is
configured. It is the absolute path to the strict managed launcher:

```sh
# require the bound agent's git identity and policy without host fallback.
"$AGENT_SYSTEM_GIT" status --short
```

This launcher requires active-agent authority under the shared
[execution boundary](../../CLI.md#trust-boundary). The [shim](#shim) retains
its contextual host fallback.

Git logo by [Jason Long](https://git-scm.com/downloads/logos), licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/); recolored for Agent System.
