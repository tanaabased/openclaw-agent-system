# Agent System Git Tool

<p align="center">
  <img src="../../skills/git-cli/agents/assets/icon-large.svg" alt="Agent System Git" width="180" />
</p>

The Git tool runs ordinary noninteractive `git` commands with the active
agent's declared identity, contained workspace, and operation policy. It is the
preferred Git path when an Agent System workspace declares `git`.

[Agent System](../../README.md) · [Raw Git skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-cli/SKILL.md)

## Overview

One shared runtime provides three Git interfaces:

| Interface                        | Purpose                                                      |
| -------------------------------- | ------------------------------------------------------------ |
| `agent_system_git`               | Model-facing OpenClaw tool                                   |
| `openclaw agent-system tool git` | Explicit operator command                                    |
| `git`                            | Packaged compatibility shim on supported agent command paths |

Every interface binds the request to one trusted agent workspace, applies the
configured operation policy, resolves the effective agent identity, and
launches the real `git` executable without a shell.

## Requirements

- Agent System installed and enabled
- Git available as `git`
- An Agent System workspace manifest with `git` configured
- An effective Git name and email declared by `git` or `agent`

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
  policy:
    destructive: ask
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

### `git.policy`

| Field         | Values                 | Default | Covers                                  |
| ------------- | ---------------------- | ------- | --------------------------------------- |
| `destructive` | `allow`, `ask`, `deny` | `deny`  | Irrecoverable local or remote mutations |
| `unknown`     | `allow`, `ask`, `deny` | `deny`  | Unclassified Git command syntax         |

Read and ordinary write operations are allowed. `ask` works only through
`agent_system_git` during an OpenClaw agent turn; direct CLI and shim invocations
reject operations that require an approval conversation.

Agent System disables operator-global and system Git configuration, terminal
prompts, hooks, pagers, and editors for the child. It rejects command-line
configuration, executable, credential, and working-directory escape paths. A
repository's own Git configuration can still name helpers, filters, aliases,
and diff programs, so the wrapper does not make an untrusted checkout safe.

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
may provide a workspace-relative `cwd`; canonical path checks reject parent and
symlink traversal outside the workspace.

## Shim

Installation projects the packaged `git` shim onto supported agent command
paths:

```sh
# confirm that this git belongs to agent system.
git --agent-system

# delegate an ordinary git command through the shared tool runtime.
git status --short
```

The shim passes arguments through `openclaw agent-system tool git` and preserves
the caller's directory when it is inside the bound workspace. The runtime
resolves the real `git` executable while excluding Agent System-managed command
paths to prevent wrapper recursion.

The shim is routing convenience, not universal interception. Absolute binaries,
replaced `PATH` values, and unrelated host processes can bypass it.

## Further Reading

- [Agent System README](../../README.md): installation and the common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest, configuration, CLI, environment, and path references
- [Git tool specification](./SPEC.md): planned SSH authentication and signing work
- [Raw Git skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/git-cli/SKILL.md): model-facing Git guidance

The Git logo is by [Jason Long](https://git-scm.com/downloads/logos) and is
licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The
packaged mark preserves the official geometry and uses the Agent System brand
color.
