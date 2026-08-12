# Agent System GitHub CLI Tool

<p align="center">
  <img src="../../skills/github-cli/agents/assets/icon-large.svg" alt="Agent System GitHub CLI" width="180" />
</p>

The GitHub CLI tool runs ordinary noninteractive `gh` commands with the active
agent's credential, isolated configuration, and operation policy. It is the
preferred GitHub path when an Agent System workspace declares `github`.

[Agent System](../../README.md) · [Raw GitHub CLI skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/github-cli/SKILL.md)

## Overview

One shared runtime provides three GitHub interfaces:

| Interface                       | Purpose                                                      |
| ------------------------------- | ------------------------------------------------------------ |
| `agent_system_github`           | Model-facing OpenClaw tool                                   |
| `openclaw agent-system tool gh` | Explicit operator command                                    |
| `gh`                            | Packaged compatibility shim on supported agent command paths |

The model-facing tool binds the request to trusted OpenClaw agent context. The
CLI and shim are operator interfaces that select an agent by option or workspace.
All three then apply policy before loading the selected agent's credential and
launch the real `gh` executable without a shell.

## Requirements

- Agent System installed and enabled
- GitHub CLI available as `gh`
- An Agent System workspace manifest with `github` configured
- A GitHub token in the completed Agent System environment

GitHub token permissions remain the provider authorization boundary. Give each
agent the least privilege it needs.

## Configuration Reference

Add `github` to `.agent-system/agent.yaml` or the root `agent.yaml`. The schema is
strict: unknown and incorrectly cased keys fail validation.

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot

environment:
  op: z7q4m2n9v6k3p8r5t1w0x4c2ba
  required:
    - GH_TOKEN_TANAABOT

github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  policy:
    destructive: deny
    admin: deny
    unknown: deny
  ssh-keys: ~/.ssh/id_ed25519.pub
  ssh-signing-keys:
    path: .agent-system/keys/signing.pub
    title: Tanaabot signing key
  config:
    git-protocol: ssh
    color-labels: enabled
    accessible-colors: disabled
    spinner: enabled
    telemetry: disabled
```

### `github.host`

| Type   | Required | Default      |
| ------ | -------- | ------------ |
| string | no       | `github.com` |

Only `github.com` is currently supported.

### `github.username`

| Type                               | Required     | Default |
| ---------------------------------- | ------------ | ------- |
| string or `from-environment` value | for SSH keys | none    |

When configured, Agent System verifies `gh api user --jq .login` in the same
child environment before each requested operation and rejects a different login.

### `github.token`

| Type                      | Required     | Default                         |
| ------------------------- | ------------ | ------------------------------- |
| environment-variable name | for SSH keys | `GH_TOKEN`, then `GITHUB_TOKEN` |

The value names a variable in the completed Agent System environment; it can
never contain a literal token. A declared binding takes precedence over the
defaults. SSH authentication or signing keys require an explicit token and
username because installation may mutate the configured GitHub account.

### `github.policy`

| Field         | Values          | Default | Covers                                             |
| ------------- | --------------- | ------- | -------------------------------------------------- |
| `destructive` | `allow`, `deny` | `deny`  | Deletes and other irrecoverable operations         |
| `admin`       | `allow`, `deny` | `deny`  | Privilege, access, repository, and account control |
| `unknown`     | `allow`, `deny` | `deny`  | Syntax Agent System cannot classify confidently    |

Read and ordinary write operations are allowed. Known destructive and admin
operations take precedence over `unknown`; setting `unknown: allow` cannot permit
a recognized hazard.

Denied operations identify the controlling policy field and explain that an
operator must set it to `allow` before retrying. Policy enforcement occurs
before Agent System resolves the environment or token.

### `github.config`

| Field               | Values                | Default    |
| ------------------- | --------------------- | ---------- |
| `git-protocol`      | `ssh`, `https`        | `ssh`      |
| `color-labels`      | `enabled`, `disabled` | `enabled`  |
| `accessible-colors` | `enabled`, `disabled` | `disabled` |
| `spinner`           | `enabled`, `disabled` | `enabled`  |
| `telemetry`         | `enabled`, `disabled` | `disabled` |

Agent System writes a token-free `config.yml` beneath a private per-agent state
directory and supplies it through `GH_CONFIG_DIR`. It never reads or modifies the
operator's normal `~/.config/gh` configuration. The child environment also
disables prompts and editor launches and uses `cat` as its pager.

### `github.ssh-keys`

| Type                   | Required | Default |
| ---------------------- | -------- | ------- |
| key, path, or key list | no       | none    |

Declares GitHub SSH authentication keys. A short string may be one supported
OpenSSH public key or a path. An object uses exactly one of `key` or `path` and
may provide a GitHub `title`.

### `github.ssh-signing-keys`

| Type                   | Required | Default |
| ---------------------- | -------- | ------- |
| key, path, or key list | no       | none    |

Declares GitHub SSH signing keys using the same forms as `github.ssh-keys`.
Relative paths resolve from the workspace; absolute paths and `~/` paths are also
supported. Files must be non-symlinked regular files no larger than 64 KiB and
contain exactly one supported public key. Agent System never accepts private
keys, removes remote keys, rotates keys, or changes existing titles.

The generic [`validate`, `install`, and `doctor`](../../ADVANCED.md#cli)
commands validate declarations, reconcile missing keys and private GitHub CLI
configuration, and report drift.

## CLI

This is a trusted operator interface for administration, testing, and debugging.
Agents should use `agent_system_github`; an agent with unrestricted host command
access could otherwise select another installed agent.

### Usage

```text
openclaw agent-system tool gh [--agent <id>] -- <gh-arguments...>
```

```sh
# discover agent.yaml from the current workspace.
openclaw agent-system tool gh -- repo view owner/repo --json name --jq .name

# select one installed agent from any directory and verify its github identity.
openclaw as tool gh --agent tanaabot -- api user --jq .login
```

### Behavior

Arguments after `--` pass to `gh` unchanged. Child standard output and error pass
through directly, and the child exit code is preserved. The runtime blocks token
display, authentication or generated-config mutation, aliases, extensions, and
browser or editor launch paths. These containment rules complement GitHub token
permissions; they do not replace them.

## Shim

Installation projects the packaged `gh` shim onto supported agent command paths:

```sh
# confirm that this gh belongs to agent system.
gh --agent-system

# delegate an ordinary github cli command through the shared tool runtime.
gh repo view owner/repo --json name,url
```

The shim delegates through the reusable packaged `agent-system-tool` launcher,
which passes arguments to `openclaw agent-system tool gh`, exports the canonical
launcher directory, and never receives a credential. The runtime resolves the
real `gh` executable while excluding Agent System-managed command paths to
prevent substitution and wrapper recursion.

The shim is an operator-compatible routing convenience, not an agent security
boundary or universal interception. Absolute binaries, replaced `PATH` values,
direct HTTP, SDKs, MCP tools, and unrelated host processes can bypass it.

## Further Reading

- [Agent System README](../../README.md): installation and the common manifest workflow
- [Advanced](../../ADVANCED.md): complete manifest, configuration, CLI, environment, and path references
- [Development](../../DEVELOPMENT.md#logging): runtime logging during development
- [Raw GitHub CLI skill](https://raw.githubusercontent.com/tanaabased/openclaw-agent-system/main/skills/github-cli/SKILL.md): model-facing GitHub guidance
