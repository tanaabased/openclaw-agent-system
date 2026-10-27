# Agent System GitHub CLI Tool

<p align="center">
  <img src="../../skills/github-cli/assets/icon-large.svg" alt="Agent System GitHub CLI" width="180" />
</p>

The GitHub CLI tool runs noninteractive `gh` commands with the active agent's
credential, isolated configuration, and policy. Enable it through the workspace's
`github` declaration.

> [!IMPORTANT]
> GitHub permissions and server-side protections decide what is allowed. Agent
> System adds the narrow release control documented under
> [`github.policy`](#githubpolicy) and fixed [self-unassignment protection](#assignment-protection).

- [Configuration Reference](#configuration-reference)
  - [`github.config`](#githubconfig)
  - [`github.host`](#githubhost)
  - [`github.policy`](#githubpolicy)
  - [`github.ssh-keys`](#githubssh-keys)
  - [`github.ssh-signing-keys`](#githubssh-signing-keys)
  - [`github.token`](#githubtoken)
  - [`github.username`](#githubusername)
- [`agent_system_github`](#agent_system_github)
- [CLI](#cli)
  - [`openclaw agent-system tool gh`](#openclaw-agent-system-tool-gh)
- [Shim](#shim)
- [Launcher Bindings](#launcher-bindings)

## Requirements

- Agent System installed and enabled
- GitHub CLI available as `gh`
- An Agent System workspace manifest with `github` configured
- A GitHub token in the completed Agent System environment

Give each agent the least-privilege token and repository role it needs.

## Configuration Reference

Declare `github` in the [workspace manifest](../../MANIFEST.md#discovery):

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email: tanaabot@tanaab.dev

environment:
  op: z7q4m2n9v6k3p8r5t1w0x4c2ba
  required:
    - GH_TOKEN_TANAABOT

github:
  host: github.com
  username: tanaabot
  token: GH_TOKEN_TANAABOT
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

### `github.config`

| Field               | Values                | Required | Default    |
| ------------------- | --------------------- | -------- | ---------- |
| `accessible-colors` | `enabled`, `disabled` | no       | `disabled` |
| `color-labels`      | `enabled`, `disabled` | no       | `enabled`  |
| `git-protocol`      | `ssh`, `https`        | no       | `ssh`      |
| `spinner`           | `enabled`, `disabled` | no       | `enabled`  |
| `telemetry`         | `enabled`, `disabled` | no       | `disabled` |

Agent System keeps token-free configuration in private per-agent state and leaves
the operator's `~/.config/gh` untouched. Managed commands disable prompts, editors,
and interactive paging.

### `github.host`

| Type   | Required | Default      |
| ------ | -------- | ------------ |
| string | no       | `github.com` |

Only `github.com` is currently supported.

### `github.policy`

| Field      | Values          | Required | Default | Covers                                             |
| ---------- | --------------- | -------- | ------- | -------------------------------------------------- |
| `releases` | `allow`, `deny` | no       | `deny`  | Creating, editing, deleting, or uploading releases |

Enable release mutations only when the agent needs them:

```yaml
github:
  policy:
    releases: allow
```

`deny` blocks `gh release create`, `edit`, `delete`, `upload`, and
`delete-asset`, plus unrecognized future `gh release` subcommands. It also blocks
non-read requests to GitHub REST release and release-asset routes. Release reads
through `gh release list` (including its `ls` alias), `gh release view`, and
`gh release download` remain available. REST `GET` and `HEAD` requests and `POST`
requests to `.../releases/generate-notes` also remain available.

Other valid operations, including repository deletion and PR merges, rely on GitHub
permissions and [assignment protection](#assignment-protection). Limit the token's
[permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
and repository role; omit `Administration` to prevent repository administration.
Use [rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
for merges and ref changes, and
[immutable releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)
for published tags and assets. A local `allow` cannot override GitHub denial.
Release policy is checked before credentials resolve.

<a id="assignment-protection"></a>

> [!NOTE]
> Managed GitHub calls cannot remove the authenticated account's own assignment,
> including through CLI, REST, or GraphQL. This has no policy override; an operator
> or another authorized user must change that assignment. Ambiguous inputs or
> incomplete assignment reads block the request. The guard does not cover standalone
> Codex's native host tools or other unmanaged access.

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
keys or rotates them.

Install adds missing account keys without removing or retitling existing keys;
Doctor reports drift. [GitHub notifications](../../channels/github/README.md) have
separate workflow configuration.

### `github.token`

| Type                      | Required     | Default                         |
| ------------------------- | ------------ | ------------------------------- |
| environment-variable name | for SSH keys | `GH_TOKEN`, then `GITHUB_TOKEN` |

The value names a variable in the completed Agent System environment; it can
never contain a literal token. A declared binding takes precedence over the
defaults. SSH authentication or signing keys require an explicit token and
username because installation may mutate the configured GitHub account.

When both `github.username` and `github.token` are declared, Install also configures
that identity for the same agent in OpenClaw. Doctor checks this per-agent profile;
it reports a missing profile rather than adopting a system-level identity.

The token is copied only into OpenClaw's owner-readable PAT profile store, never
`openclaw.json`. Each agent receives a separately verified profile and binding;
conflicts or unsupported layouts fail closed. Agents that share an OS account still
share process-level access, so this provides identity separation, not hostile-process
secret isolation.

### `github.username`

| Type                               | Required     | Default |
| ---------------------------------- | ------------ | ------- |
| string or `from-environment` value | for SSH keys | none    |

When configured, Agent System verifies the authenticated login through `gh api user`
in the same child environment before each requested operation and rejects a different login.

<a id="native-tool"></a>

## `agent_system_github`

Run ordinary GitHub CLI commands with the trusted active agent. The same
[configuration](#configuration-reference) and [policy](#githubpolicy) apply to
native and operator calls.

### Parameters

| Parameter | Type         | Required | Default | Description                                                                         |
| --------- | ------------ | -------- | ------- | ----------------------------------------------------------------------------------- |
| `argv`    | string array | yes      | none    | 1–128 GitHub CLI arguments, without `gh`; each argument is at most 8192 characters. |
| `stdin`   | string       | no       | none    | Ordinary command input, at most 64 KiB; never tokens.                               |

Callers cannot select an agent, workspace, or credential. Unknown parameters are
rejected.

### Usage

Inspect the configured GitHub identity:

```json
{ "argv": ["api", "user", "--jq", ".login"] }
```

Results include `exitCode`, `stdout`, `stderr`, and `truncated`.

## CLI

These are operator commands; agents use `agent_system_github`. See the
[shared trust boundary](../../CLI.md#trust-boundary) for identity binding and host-access limits.

### `openclaw agent-system tool gh`

Run ordinary GitHub CLI commands through the agent’s account and operation policy.

#### Options

| Option or argument     | Required | Default             | Description                                                |
| ---------------------- | -------- | ------------------- | ---------------------------------------------------------- |
| `-- <gh-arguments...>` | yes      | none                | Supply ordinary GitHub CLI arguments.                      |
| `--agent <id>`         | no       | workspace discovery | Use the exact configured workspace for an installed agent. |

#### Usage

```text
openclaw agent-system tool gh [--agent <id>] -- <gh-arguments...>
```

```sh
# discover agent.yaml from the current workspace.
openclaw agent-system tool gh -- repo view owner/repo --json name --jq .name

# select an installed agent and verify its github identity.
openclaw agent-system tool gh --agent tanaabot -- api user --jq .login
```

Managed calls cannot display tokens, change authentication or CLI configuration, use
aliases or extensions, or launch a browser or editor. Manifest policy cannot disable these
identity and execution safeguards.

## Shim

Install adds the packaged `gh` shim to supported agent command paths:

```sh
# confirm that this gh belongs to agent system.
gh --agent-system

# delegate an ordinary github cli command through the shared tool runtime.
gh repo view owner/repo --json name,url
```

The packaged command automatically uses managed GitHub in agent context and
sanitized host execution outside it. See the
[command-routing contract](../../CLI.md#trust-boundary).

## Launcher Bindings

Agent-bound Gateway and setup children receive `AGENT_SYSTEM_GH`, the absolute
path to the strict managed launcher:

```sh
# require the bound agent's github identity and policy without host fallback.
"$AGENT_SYSTEM_GH" repo view owner/repo
```

This launcher requires active-agent authority under the shared
[execution boundary](../../CLI.md#trust-boundary). The [shim](#shim) retains
its contextual host fallback.
