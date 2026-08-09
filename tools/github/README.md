# Agent System GitHub CLI Tool

<p align="center">
  <img src="../../skills/github-cli/agents/assets/icon-large.svg" alt="Agent System GitHub CLI" width="180" />
</p>

The GitHub CLI tool runs ordinary noninteractive `gh` commands with the active
agent's credential, isolated configuration, and operation policy. It is the
preferred GitHub path when an Agent System workspace declares `github`.

Start with the main [Agent System README](../../README.md) for plugin installation
and the common manifest workflow. Use [Advanced](../../ADVANCED.md) for the complete
Agent System manifest, environment, logging, and CLI references.

## Overview

Configuring `github` in `agent.yaml` enables three interfaces over one shared
runtime:

- `agent_system_github`, the model-facing OpenClaw tool
- `openclaw agent-system tool gh`, the explicit human-facing command
- `bin/gh`, the packaged compatibility launcher projected onto supported agent
  command paths by `openclaw agent-system install`

All three bind the request to one trusted agent workspace, classify and authorize
the operation before loading credentials, resolve only that agent's selected
token, reconcile private GitHub CLI configuration, verify the configured account,
and launch the real `gh` executable without a shell. The model never supplies the
agent id, workspace, executable, credential name, or token.

## Requirements

- Agent System installed and enabled
- GitHub CLI available as `gh`
- An Agent System workspace manifest with `github` configured
- A GitHub token in the completed Agent System environment

The packaged `$agent-system-github-cli` skill includes a Homebrew installation
hint for `gh`. GitHub token permissions remain the underlying provider boundary,
so use the least-privilege token appropriate for the agent.

## Configuration

Add `github` to the workspace's `.agent-system/agent.yaml` or `agent.yaml`:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot

environment:
  op: env_agent_github
  required:
    - GH_TOKEN_TANAABOT

github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  policy:
    destructive: ask
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

Only `github.com` is currently supported. Unknown or incorrectly cased keys fail
manifest validation.

### Identity and credentials

`github.username` is optional for ordinary tool use and may be a literal or an
explicit `from-environment` reference. When present, the tool runs
`gh api user --jq .login` in the same child environment before every requested
operation and rejects an account mismatch.

`github.token` names an environment variable; it can never contain a literal
token. A declared binding wins. When omitted, ordinary tool use looks for
`GH_TOKEN` and then `GITHUB_TOKEN` in the completed Agent System environment.
Declaring SSH authentication or signing keys requires explicit `github.username`
and `github.token` values because installation may mutate the configured GitHub
account.

### GitHub CLI configuration

Agent System writes a token-free `config.yml` beneath a private per-agent state
directory and always supplies that directory through `GH_CONFIG_DIR`. It never
reads or modifies the operator's normal `~/.config/gh` configuration.

| Manifest field             | Default    |
| -------------------------- | ---------- |
| `config.git-protocol`      | `ssh`      |
| `config.color-labels`      | `enabled`  |
| `config.accessible-colors` | `disabled` |
| `config.spinner`           | `enabled`  |
| `config.telemetry`         | `disabled` |

The generated environment also disables prompts and editor prompts and uses
`cat` as the pager. Missing or drifted config is written atomically; unsafe
links, ownership, or permissions fail closed.

### Operation policy

Read and ordinary write operations are allowed. The three higher-risk classes
accept `allow`, `ask`, or `deny` and default to `deny`:

| Policy field         | Covers                                             |
| -------------------- | -------------------------------------------------- |
| `policy.destructive` | Deletes and other irrecoverable operations         |
| `policy.admin`       | Privilege, access, repository, and account control |
| `policy.unknown`     | Syntax Agent System cannot classify confidently    |

Known destructive and admin operations take precedence over `unknown`, so
`unknown: allow` cannot permit a recognized hazard. Validation warns when
`unknown: allow` weakens the fail-closed compatibility boundary.

`ask` is available only to `agent_system_github` during an OpenClaw agent turn.
OpenClaw requests approval before Agent System resolves the environment or token.
An allow-once decision creates a short-lived receipt bound to the agent, tool-call
id, and exact input; it is consumed once. Denial, timeout, missing approval
delivery, changed input, and replay fail closed.

Direct `agent-system tool gh` and packaged `gh` invocations have no originating
approval conversation. They reject `ask` operations with guidance to use an agent
turn or configure explicit `allow` for noninteractive automation.

### SSH account keys

`github.ssh-keys` and `github.ssh-signing-keys` each accept one source or a
non-empty list. A short string may be one supported OpenSSH public key or a path.
Object forms use exactly one of `key` or `path` and may add a GitHub `title`:

```yaml
github:
  username: tanaabot
  token: GH_TOKEN_TANAABOT
  ssh-keys:
    - ~/.ssh/id_ed25519.pub
    - key: ssh-ed25519 AAAA...
      title: Tanaabot laptop
  ssh-signing-keys:
    path: .agent-system/keys/signing.pub
```

Relative paths resolve from the agent workspace; absolute paths and `~/` paths
are also supported. Files must be non-symlinked regular files no larger than
64 KiB and contain exactly one supported public key. Agent System never accepts
or manages private keys.

`validate` checks declarations without reading files, loading credentials, or
contacting GitHub. `doctor` resolves sources and compares canonical SHA-256
fingerprints with the configured account. `install` resolves every source before
remote work, creates only missing keys, then refetches both key collections to
verify convergence. It never removes, rotates, retitles, or prunes keys.

## Usage

### Agent tool

When `github` is configured, Agent System loads `$agent-system-github-cli` and
adds preference guidance for `agent_system_github`. The native tool accepts
ordinary noninteractive GitHub CLI arguments and optional bounded standard input:

```json
{ "argv": ["repo", "view", "owner/repo", "--json", "name,url"] }
```

```json
{ "argv": ["api", "user", "--jq", ".login"] }
```

The native result contains `exitCode`, `stdout`, `stderr`, and `truncated`.
Standard input and combined captured output are each bounded at 64 KiB.

### Agent System command

Use the explicit command from an agent workspace or select an installed agent:

```sh
# Discover agent.yaml from the current workspace.
openclaw agent-system tool gh -- repo view owner/repo --json name --jq .name

# Use one exact installed agent from any directory.
openclaw as tool gh --agent tanaabot -- api user --jq .login
```

Child standard output and error pass through directly, and the child exit code is
preserved.

### Packaged `gh` launcher

Installation projects Agent System's global `bin` directory onto supported agent
command paths. The packaged launcher confirms its identity and otherwise delegates
arguments unchanged through the same tool runtime:

```sh
gh --agent-system
gh repo view owner/repo --json name,url
```

The launcher never receives a credential. It locates `openclaw` through the
caller's ordinary `PATH`; the TypeScript runtime later resolves the real `gh` to
an absolute path while excluding workspace overrides, declared prepended paths,
the packaged Agent System bin, and the calling launcher directory. This prevents
command substitution and wrapper recursion.

The launcher is routing convenience, not universal interception. Absolute
binaries, replaced `PATH` values, direct HTTP, SDKs, MCP tools, and unrelated host
processes can bypass it.

## Security boundaries

Before loading an agent credential, the shared runtime:

1. proves the active agent and workspace binding;
2. validates the request and credential-containment boundaries;
3. classifies the operation;
4. applies the configured allow, ask, or deny decision.

Only an authorized operation resolves the completed Agent System environment.
The child receives the selected token as `GH_TOKEN`, the private `GH_CONFIG_DIR`,
fixed GitHub settings, and a sanitized baseline environment. Known secret values
are redacted from captured output, output is bounded, and call logs contain only
metadata.

Authentication mutation or token display, generated-config mutation, aliases,
extensions, and browser or editor launch paths are blocked. GitHub operation
classification is conservative defense in depth; it does not replace token
permissions or GitHub-side repository policy.

## Verification

Validate declarations, install or reconcile GitHub-owned state, and inspect drift:

```sh
openclaw agent-system validate
openclaw agent-system install
openclaw agent-system doctor

# Confirm the selected GitHub identity through the shared runtime.
openclaw agent-system tool gh -- api user --jq .login
```

Run `install` again to verify idempotence. A healthy repeated run reports the
GitHub config and declared account keys as unchanged.

Use `OPENCLAW_LOG_LEVEL=debug` on the OpenClaw process for value-free Agent System
tool-call diagnostics. Missing credentials, identity mismatches, denied policy,
unsafe generated config, unavailable executables, and nonzero `gh` results are
reported without revealing the selected token.

## Related documentation

- [Agent System README](../../README.md): installation and common workflow
- [Advanced](../../ADVANCED.md): complete manifest, environment, logging, and CLI reference
- [GitHub CLI skill](../../skills/github-cli/SKILL.md): model-facing usage guidance
