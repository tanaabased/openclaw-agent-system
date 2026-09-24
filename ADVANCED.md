# Advanced

This guide is the complete reference for Agent System's core workspace manifest,
configuration, CLI, environment, and path behavior. Start with the
[README](./README.md) for installation and the common workflow; use
[DEVELOPMENT.md](./DEVELOPMENT.md) when changing Agent System itself.

Public components own their capability-specific configuration, CLI, behavior,
and security documentation:

| Type    | ID                          | Display name          | Guide                                               |
| ------- | --------------------------- | --------------------- | --------------------------------------------------- |
| tool    | `agent_system_git`          | Git CLI               | [Git tools](./tools/git/README.md)                  |
| tool    | `agent_system_git_worktree` | Managed Git worktrees | [Git tools](./tools/git/README.md)                  |
| tool    | `agent_system_github`       | GitHub CLI            | [GitHub CLI](./tools/github/README.md)              |
| channel | `agent-system-github`       | GitHub notifications  | [GitHub notifications](./channels/github/README.md) |

These IDs come from distinct OpenClaw registries: tool IDs use underscores,
while the channel ID uses hyphens.

## Version Compatibility

| Agent System release | Minimum OpenClaw | Development target |
| -------------------- | ---------------- | ------------------ |
| Unreleased           | 2026.9.5         | 2026.9.5           |
| 0.6.0                | 2026.9.2         | 2026.9.3           |
| 0.5.3                | 2026.7.1         | 2026.7.2           |

Compatibility metadata declares the minimum supported OpenClaw version. Build
metadata and development dependencies pin the newest version tested for the
release.

## Manifest

Agent System discovers one manifest from an agent workspace:

```text
.agent-system/agent.yaml   # preferred
agent.yaml                 # shorthand
```

The preferred file wins when both exist; the files never merge. Passive loading
validates the manifest but does not resolve environment values or mutate state.
The strict loader rejects unknown or incorrectly cased keys, unsafe symlinks,
files larger than 1 MiB, invalid UTF-8, duplicate keys, and unsupported YAML
features such as anchors, aliases, and explicit tags.

A minimal manifest binds one workspace to one agent:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot

environment:
  set:
    NODE_ENV: development
```

See [Configuration](#configuration) for the complete core manifest and
component-provided sections.

## Codex Workspace Binding

Each Codex plugin installation or profile can bind explicitly to one Agent
System workspace. The binding is independent of `CODEX_HOME`, the current task
directory, and OpenClaw agent configuration. Agent System stores only the
canonical workspace directory in `PLUGIN_DATA/workspace-binding.json`; binding,
rebinding, and unbinding do not change the workspace or its manifest.

After installing the plugin, start a fresh Codex task. Codex reports that the
bundled SessionStart hook needs review because plugin installation does not grant
hook trust. Open `/hooks`, inspect the Agent System hook, and trust its current
definition. Codex records trust against that definition's hash, so a plugin
upgrade that changes the hook is skipped until it is reviewed again. Start a
fresh task after trusting or re-trusting it. See the official
[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
for the host trust contract.

The trusted hook supplies the packaged binding skill with the installed runtime
and writable plugin-data paths. Invoke `$agent-system-codex-binding` to:

- inspect the current binding and live manifest state
- preview and confirm a canonical workspace before binding or rebinding
- bind anyway when the manifest is missing or invalid
- unbind the stored pointer without modifying workspace files

An inaccessible path or non-directory is rejected. A missing or invalid manifest
is an inactive binding rather than an installation failure: ordinary Codex use
continues, and the binding workflow reports the state plainly. The hook checks
the pointer and manifest again on `startup`, `resume`, `clear`, and `compact`.
Each result explicitly supersedes earlier Agent System context, so unbinding,
rebinding, removing a manifest, or making it invalid revokes the previous active
projection on the next trusted hook run.

For a valid manifest, Codex receives only supported non-secret values:

- literal agent identity fields
- supported Git identity, extension, policy, and worktree metadata
- supported GitHub host, username, configuration, and policy metadata
- `agent-system-git-cli` and `agent-system-github-cli` when their respective sections are configured

The hook never resolves dotenv files, 1Password references, credentials, signing
keys, or other declared environment values. It also does not run Agent System
installation, setup, Doctor, model routing, channels, or OpenClaw model-facing
tools. Those remain explicit OpenClaw-owned workflows. Other hosts use their
normal Git and GitHub operations; binding supplies context, not managed tool
authority.

## Configuration

The workspace manifest declares the agent's desired state. `install` reconciles
owned OpenClaw settings; credentials remain outside `openclaw.json`.
[Global Configuration](#global-configuration) covers operator-owned plugin settings.

A complete core configuration can contain:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email:
    from-environment: AGENT_EMAIL
  description: Tanaab development agent.
  avatar: avatar.png
  emoji: 🧑‍💻

models:
  default: { model: openai/gpt-6-astra, effort: high }
  low: { model: openai/gpt-5.6-terra, effort: medium }
  medium: { model: openai/gpt-5.6-sol, effort: high }
  high: { model: openai/gpt-6-astra, effort: xhigh }

memory:
  search:
    provider: openai
    model: text-embedding-3-small
    api-key: EMBEDDINGS_API_KEY

environment:
  dotenv:
    - .agent-system/env/base.env
    - .agent-system/env/local.env
  set:
    AGENT_COLOR: green
    AGENT_EMAIL: $COMPANY_EMAIL
    NODE_ENV: development
    SSH_KEY:
      from-op: 'op://v4u7l2t9n5p8r1c6x3z0m4q7da/ssh-key/private key?ssh-format=openssh'
  op:
    - b3v8n1q6m4z9k2r7t5w0x8c6pd
    - z7q4m2n9v6k3p8r5t1w0x4c2ba
  path-prepend:
    - tools/bin
  required:
    - AGENT_EMAIL
```

### `schema-version`

| Type    | Required | Default |
| ------- | -------- | ------- |
| integer | yes      | `1`     |

Identifies the manifest schema. Version `1` is the only accepted value.

### `agent`

| Field         | Type                               | Required      | Behavior                                                         |
| ------------- | ---------------------------------- | ------------- | ---------------------------------------------------------------- |
| `id`          | string                             | yes           | Literal lowercase id matching `^[a-z0-9][a-z0-9-]*$`.            |
| `name`        | string or `from-environment` value | for `install` | Agent display name applied to OpenClaw by `install`.             |
| `email`       | string or `from-environment` value | no            | Agent email available to configured consumers.                   |
| `description` | string                             | no            | Agent description retained for configured consumers.             |
| `avatar`      | string                             | no            | Applied by `install`; an undeclared OpenClaw avatar is retained. |
| `emoji`       | string                             | no            | Applied by `install`; an undeclared OpenClaw emoji is retained.  |

`name` and `email` accept a literal or an explicit reference to the completed
Agent System environment:

```yaml
agent:
  name:
    from-environment: AGENT_NAME
```

A missing or empty referenced value fails the action that consumes it. A
dollar-prefixed scalar in these fields remains literal.

Identity fields do not configure tools by themselves; a tool may explicitly use
them as defaults.

### `models`

`models` is optional. Omitting it leaves the agent's existing model configuration
untouched. When present, `default` is required; `low`, `medium`, and `high` are an
additive work-tier group and must be declared together or omitted together.

Each profile requires both fields:

| Field    | Type                         | Behavior                                                      |
| -------- | ---------------------------- | ------------------------------------------------------------- |
| `model`  | provider-qualified model ref | Exact `provider/model` reference; no model value is built in. |
| `effort` | `medium`, `high`, or `xhigh` | Explicit profile effort, intersected with runtime support.    |

Model refs cannot select an authentication profile. Runtime and credential
configuration remain outside the manifest.

OpenClaw's `agents.entries.<id>.models` map stores per-model metadata such as
`agentRuntime`; it does not authorize selection. Selection is governed by the
agent's effective `modelPolicy.allow`, which may come from the agent entry or
`agents.defaults`.

`install` sets the bound agent's primary model and default thinking effort from
`models.default`. It binds each distinct declared model to the same established
runtime route already used by that agent, without provisioning or resolving
credentials and without changing global defaults, fallbacks, unrelated per-model
settings, or existing session selections. When a restrictive effective model
policy excludes a declared model, `install` creates or extends the bound agent's
own `modelPolicy.allow`, preserving the currently inherited permissions and
appending only missing declarations. It does not broaden the global policy or
other agents. Unrestricted and matching wildcard policies need no repair. An
explicit incompatible or ambiguous runtime binding blocks the change rather than
selecting another route. Removing profiles or `models` later performs no cleanup
and does not guess which policy entries or previous defaults it once added.

`doctor` checks configuration drift, effective selection policy, configured model
presence, and effort support without changing configuration, resolving
authentication, or running inference. OpenClaw owns authentication and runtime
health through its model status and agent execution surfaces. A configured model
that OpenClaw explicitly reports as unavailable produces a warning rather than
blocking Doctor. Unknown availability does not imply failure, while list
inspection failures remain distinct from a model or effort known to be
unsupported.

Complete work tiers enable [GitHub issue model routing](channels/github/README.md#model-routing)
for new issue conversations. A default-only manifest keeps ordinary model behavior.

### `memory`

`memory` is optional. Omitting it leaves the bound agent's existing OpenClaw
memory search configuration untouched. When present, `search.provider` is
required:

| Field      | Type                      | Required | Behavior                                                                  |
| ---------- | ------------------------- | -------- | ------------------------------------------------------------------------- |
| `provider` | `none`, `local`, `openai` | yes      | Selects keyword-only, local embedding, or OpenAI embedding search.        |
| `model`    | string                    | no       | Overrides OpenClaw's embedding model; valid only with `openai`.           |
| `api-key`  | environment name          | no       | Reads one declared Agent System environment binding; valid with `openai`. |

`install` sets the bound agent's provider and fallback, plus the optional model
and API-key reference, while preserving other memory settings and agents. The
`none` provider retains keyword search. Configure `local` through OpenClaw before
expecting semantic search:

```sh
openclaw models --agent tanaabot auth login --provider llama-cpp --method local
```

An OpenAI `api-key` becomes an agent-and-binding-scoped OpenClaw `SecretRef`, not
plaintext configuration. Managed package installs use Agent System's plugin
integration; source-linked installs use a bounded standalone provider pointing
to the checkout's built entrypoint because OpenClaw does not expose plugin
integrations from a `config` origin. Agent System resolves only the exact
declared reference when OpenClaw builds or reloads its secret snapshot. Build
the checkout before reconciliation, then restart the Gateway after changing the
provider form or binding. Use a declared dotenv file or stored 1Password
credential for restart-safe configuration. This remains a same-host operator
boundary because an operator who can rewrite `openclaw.json` can copy the
reference.

`doctor` never changes or deletes the memory database. It reports keyword-index
readiness for `none`, verifies local-provider availability for `local`, resolves
the exact configured OpenAI credential before making one bounded embedding
probe, and never treats an unrelated fallback credential as readiness.
Authentication, permission, billing/quota, and transport failures are reported
without reproducing upstream error bodies. Index identity or synchronization
drift remains a separate finding.
Use OpenClaw's explicit memory commands when you intend to mutate the index:

```sh
# inspect the bound agent without rebuilding its index.
openclaw memory status --agent tanaabot --deep --json

# rebuild only when doctor reports index drift and you intend the write.
openclaw memory status --index --agent tanaabot
```

### `environment`

| Field          | Type                    | Required | Behavior                                                              |
| -------------- | ----------------------- | -------- | --------------------------------------------------------------------- |
| `dotenv`       | string or string list   | no       | Ordered workspace-relative dotenv files.                              |
| `set`          | string or `from-op` map | no       | Explicit values merged over dotenv values.                            |
| `op`           | string or string list   | no       | Ordered 1Password Environment IDs merged after `set`.                 |
| `path-prepend` | string or string list   | no       | Ordered workspace-relative executable directories.                    |
| `required`     | string list             | no       | Names that fail complete environment resolution when absent or empty. |

Schema-owned YAML keys use kebab-case. Environment names and user-defined
identifiers remain literal and are never casing-converted. See
[Environment Resolution](#environment-resolution) for source precedence and resolution behavior, and
[Path](#path) for executable projection.

### `setup`

Declares workspace preparation that an operator runs through `install`, with
optional checks for repeat installation and Doctor. Omit `setup` when the
first-party configuration already handles the work. Setup scripts can change
files or external services; their authors must make checks read-only and applies
safe to repeat.

#### Syntax, from shortest to most detailed

A string is shorthand for `setup.apply`, using `sh`:

```yaml
setup: mkdir -p repos
```

A YAML block embeds a script using the same shorthand:

```yaml
setup: |
  mkdir -p repos
  mkdir -p artifacts
```

The short mapping adds an optional check and shell selection:

```yaml
setup:
  shell: zsh
  check: test -d repos
  apply: mkdir -p repos
```

Each `check` or `apply` also accepts a direct argument array. Arguments are passed
literally, without shell parsing, variable expansion, pipes, or redirection:

```yaml
setup:
  check: [test, -d, repos]
  apply: [mkdir, -p, repos]
```

A direct command object accepts optional arguments and a custom timeout:

```yaml
setup:
  check: [test, -d, repos]
  apply:
    command: mkdir
    args: [-p, repos]
    timeout-seconds: 60
```

Use `steps` for multiple commands in declaration order. The container's shell is
inherited by string commands unless a step overrides it; direct commands ignore
shell selection. This example assumes the referenced scripts exist:

```yaml
setup:
  shell: bash
  steps:
    - id: directories
      check: test -d repos && test -d artifacts
      apply: |
        mkdir -p repos
        mkdir -p artifacts
    - id: workspace-configuration
      shell: zsh
      check: ./scripts/workspace check
      apply: |
        ./scripts/workspace configure
        ./scripts/workspace verify
    - id: dependencies
      check: [./scripts/dependencies, check]
      apply:
        command: ./scripts/dependencies
        args: [install]
        timeout-seconds: 600
```

The string, block, and short mapping normalize to one step with id `default`.
Every named step requires a unique lowercase kebab-case `id` and an `apply`;
`check` is optional. `steps` must be nonempty. The short mapping and `steps`
container cannot be mixed, and a bare setup array or command object is not
shorthand: place those commands under `check` or `apply`.

#### Shells, executables, and limits

`shell` accepts only `sh`, `bash`, or `zsh`; the default is `sh` on every platform,
including macOS. The selected shell must already be installed. Strings are
written to private temporary scripts, run with these fixed arguments, and
removed afterward:

| Shell  | Invocation                                        |
| ------ | ------------------------------------------------- |
| `sh`   | `sh -e <script>`                                  |
| `bash` | `bash --noprofile --norc -e -o pipefail <script>` |
| `zsh`  | `zsh -f -e -o PIPE_FAIL <script>`                 |

There are no custom shell wrappers or automatic login-shell selection. Every
command defaults to a 300-second timeout. Only the direct command object accepts
`timeout-seconds`, an integer from `1` through `3600`; strings and arrays retain
the default.

Commands start in the bound workspace with closed stdin and a 64 KiB combined
output capture limit. Timeouts terminate the command's process tree. Ordinary
diagnostics and JSON results report step ids and diagnostic codes without
including raw command output. The interactive confirmation deliberately shows
the declared commands, so keep secrets out of declarations.

The child receives a minimal host environment for home, locale, temporary paths,
and OpenClaw profile selection, plus managed command bindings. Its `PATH` places
managed launchers before trusted host executable directories. Bare `git` and `gh`
use host executables when a descendant leaves agent scope; see the
[command-routing contract](#trust-boundary). The completed
Agent System environment and operator provider tokens are not copied into the
setup shell. Managed tools resolve their own declared environment and credentials
after binding the target agent and applying policy.

Direct workspace executables such as `./scripts/dependencies` must be executable
regular files within the workspace, with no symlinks or group/world-writable
path segments. Direct executable declarations reject `..` traversal. These
checks and the command limits do not sandbox arbitrary shell code or isolate
processes sharing the same OS user.

#### Runtime applicability

An optional `runtimes` list selects `openclaw`, `codex`, or both. Omission means
both; bare strings and blocks are therefore shared. The short mapping accepts a
runtime filter for its single step:

```yaml
setup:
  runtimes: [openclaw]
  check: test -d repos
  apply: mkdir -p repos
```

In the long form, put the filter on individual steps:

```yaml
setup:
  steps:
    - id: shared-directories
      runtimes: [openclaw, codex]
      check: test -d artifacts
      apply: mkdir -p artifacts
    - id: openclaw-directories
      runtimes: [openclaw]
      check: test -d repos
      apply: mkdir -p repos
    - id: codex-directories
      runtimes: [codex]
      check: test -d codex-artifacts
      apply: mkdir -p codex-artifacts
```

Lists must be nonempty and contain unique supported values. There is no
`runtimes` field or runtime inheritance on the `steps` container.

The invoking integration supplies the runtime through trusted context. The
current OpenClaw CLI always selects `openclaw`, including when Codex drives its
model turns. Installed binaries, environment variables, and model selection do
not select the runtime. The `codex` label reserves applicability for a future
integration; this release does not include a Codex setup adapter.

Nonmatching steps run neither command and report `status: skipped`,
`code: setup-not-applicable`, and their `stepId` in install and Doctor results.
They do not count as drift or failure and need no repair. Filtering happens
before setup preparation and execution; when no steps match, setup-only
prerequisite gates stay idle. Independently configured components still run
normally. All declarations are validated, including nonmatching steps, and
applicable steps keep their declared order. There is no skip exit code or `when`
expression.

#### Checks, installation, and retries

| Applicable step                                     | Doctor    | Install                                          |
| --------------------------------------------------- | --------- | ------------------------------------------------ |
| Check exits `0`                                     | `healthy` | Leaves the step `unchanged`.                     |
| Check exits `1`                                     | `drift`   | Runs apply, then requires the check to exit `0`. |
| Check exits otherwise, cannot execute, or times out | `blocked` | Stops without applying the step.                 |
| No check                                            | `manual`  | Runs apply on every installation.                |

Apply must exit `0`. A failed apply, blocked check, or check that still reports
drift after apply stops later steps and dependent lifecycle work. Earlier
completed work remains in place; there is no transaction or rollback of
arbitrary setup effects. On retry, healthy checked steps are skipped and
unchecked steps run again. Coordinate host-wide or shared-resource changes
outside this per-agent mechanism.

Write checks so that `1` means expected drift and other nonzero exits mean an
inspection failure. The runner cannot distinguish intended drift from an
unhandled command error that also returns `1`. Doctor runs applicable checks
without prompting, applying setup, or repairing prerequisites, and aggregates
their findings. A check is trusted code: its read-only behavior is the author's
responsibility. `validate` only validates declarations and never executes them.

#### Agent identity and repository cloning

For applicable setup, installation establishes agent registration, managed
paths, and configured Git/GitHub tools, including declared GitHub SSH-key
registration, before running setup. Remaining lifecycle components follow
setup. Unavailable prerequisites block execution; setup cannot bootstrap a tool
or credential required to reach its own commands.

To clone as the agent, first declare its [Git identity and SSH
keys](./tools/git/README.md#configuration-reference) and [GitHub username, token,
and public keys](./tools/github/README.md#configuration-reference). Executables,
credential sources, and key files must already be available. Then add:

```yaml
setup:
  steps:
    - id: clone-project
      runtimes: [openclaw]
      check: test -d repos/project/.git
      apply: |
        gh api user --jq .login
        mkdir -p repos
        git clone git@github.com:your-org/project.git repos/project
```

Replace `your-org/project` with the repository to clone. Managed `gh` uses the
agent's token and verifies the declared `github.username`; managed `git` uses
the agent's identity and SSH configuration. Both shell and direct commands use
the same binding, policy, and working-directory boundaries, without falling
back to the operator's tool identity. This does not switch OS accounts: the
process still runs as the installing OS user. The example is OpenClaw-only
because it relies on that integration's managed tools.

### Component Configuration

Components own their manifest schemas and document them beside their
implementation:

| Type    | ID                          | Manifest key           | Configuration                                                                  |
| ------- | --------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| tool    | `agent_system_git`          | `git`                  | [Configuration reference](./tools/git/README.md#configuration-reference)       |
| tool    | `agent_system_git_worktree` | `git.worktrees`        | [Configuration reference](./tools/git/README.md#gitworktrees)                  |
| tool    | `agent_system_github`       | `github`               | [Configuration reference](./tools/github/README.md#configuration-reference)    |
| channel | `agent-system-github`       | `github.notifications` | [Configuration reference](./channels/github/README.md#configuration-reference) |

A manifest section opts the workspace into its capability.

## Global Configuration

Set plugin-wide options under `plugins.entries.agent-system.config` in OpenClaw
configuration. These settings belong to the operator, not `agent.yaml`.

### `githubNotifications`

Controls operator-wide GitHub notification intake limits. `maxCommentCharacters`
is an integer from `1` through `64000` and defaults to `8000`. Comments above the
effective limit are rejected without executing truncated prose. This setting does
not change the separate outgoing reply or routing-assessment excerpt limits.

### `opCache`

Controls in-memory reuse of 1Password clients and resolved values. Gateway tools
share the cache; separate CLI processes do not. GitHub responses, permissions,
and command results are not cached.

| Field             | Type    | Default | Behavior                                                                               |
| ----------------- | ------- | ------- | -------------------------------------------------------------------------------------- |
| `mode`            | string  | `timed` | `off`, `timed`, or `process-lifetime`.                                                 |
| `durationSeconds` | number  | `300`   | Timed mode only; greater than zero, at most `4503599627370`.                           |
| `maxEntries`      | integer | `128`   | Maximum agent/workspace entries, from `1` to `1024`; oldest entries are evicted first. |

Timed values expire after the configured duration from retrieval; cache hits do
not extend it. Expiry refreshes values on demand, not an unchanged authenticated
client. Process-lifetime mode retains values until invalidation, eviction, or
exit. Off mode disables reuse between operations.

```bash
# retain values for five hours
openclaw config set plugins.entries.agent-system.config.opCache '{"mode":"timed","durationSeconds":18000}' --strict-json

# inspect the running gateway cache
openclaw agent-system credentials cache status --json

# flush one agent; omit --agent to flush all
openclaw agent-system credentials cache flush --agent data --json
```

Status requires `operator.read`; flush requires `operator.admin`. Both contact
the running Gateway without reading 1Password. Status reports policy, occupancy,
expiry, backoff, and usage counters without secrets. An unreachable or
unauthorized Gateway returns an error.

Authorization and local credential/configuration changes are checked on each
operation. Reload, agent removal, credential changes, flush, and shutdown
invalidate retained state; snapshots already in use are not revoked. If a
credential command reports **invalidation pending**, restore Gateway access and
flush. External 1Password edits appear after timed expiry or flush; lifetime
mode requires flush or restart.

Failed or partial loads are not cached, and failed refreshes return errors rather
than stale credentials. OTP and unknown reference transforms bypass value
retention. Use off mode for other time-varying credentials whose validity is
shorter than the cache duration. Provider failures back off from 30 seconds to
one hour; SDK quota errors wait one hour. Flush does not reset backoff or quota.

## CLI

All commands live beneath `openclaw agent-system`; `openclaw as` is an equivalent
alias. Bare `agent-system` or `as` prints help.

### Common Behavior

| Option         | Commands                                                                                                                                        | Behavior                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `--agent <id>` | `validate`, `env`, `tool`, `credentials set/validate/unset`, `doctor`, `notifications refresh`, `notifications status`, `notifications wait`    | Uses the exact configured OpenClaw agent workspace instead of discovery. |
| `--json`       | `validate`, `env`, `install`, `doctor`, `credentials cache status/flush`, `notifications refresh`, `notifications status`, `notifications wait` | Writes undecorated structured output.                                    |

Human output honors `NO_COLOR` and `FORCE_COLOR=0`. A failed operation sets a
nonzero exit code. `credentials cache flush --agent <id>` limits invalidation to
one agent; cache status always covers the Gateway.

### Trust Boundary

Model-facing `agent_system_*` tools bind the manifest and credentials to trusted
OpenClaw agent context. They remain the preferred direct execution path for
agents.

Packaged `git` and `gh` automatically use managed execution when the working
directory resolves to a valid installed agent; an active session is not required.
When an active agent supplies command authority, its identity takes precedence
and cannot change through directory changes. Host fallback applies when no agent
manifest is found or a valid active-agent command leaves its admitted directories.
Another known agent's workspace remains denied for that active agent.

Host fallback removes agent credentials, authority, and configuration overrides;
host tools may use their normal configuration files. Invalid authority, invalid
agent configuration, and managed command failures remain errors. Explicit managed
launchers and Agent System's `worktree` route never fall back. Direct `tool` and
`credentials` commands remain trusted operator interfaces and may select an
installed agent explicitly.

The `install` and Doctor (`status`) CLI routes remain operator-only through both
aliases, including setup descendants. In OpenClaw chat, use
`agent_system_install` or `agent_system_doctor` to request **Allow once** for the
active agent and manifest. This includes Doctor's declared check commands.
Unattended CLI options do not grant chat approval. See the
[lifecycle tool guide](tools/lifecycle/README.md) for the approval boundary and
supported harnesses.

These are practical same-user guardrails, not process isolation. Absolute
binaries, replaced `PATH` values, direct HTTP, SDKs, and unrelated host
processes can bypass them. See OpenClaw's
[security model](https://docs.openclaw.ai/gateway/security) and
[sandboxing reference](https://docs.openclaw.ai/gateway/sandboxing) for the host
boundary beneath Agent System.

### `openclaw agent-system validate`

Discovers and validates a manifest without resolving credentials, inspecting
installed or remote state, or applying changes.

```text
openclaw agent-system validate [--agent <id>] [--json]
```

The result identifies the selected agent and workspace and reports the core and
configured capability declarations that passed validation.

### `openclaw agent-system env`

Resolves the environment Agent System contributes without printing values or
predicting another tool's environment.

```text
openclaw agent-system env [--agent <id>] [--json]
```

The result reports each variable's name, winning source, required state, and
override count without printing values.

### `openclaw agent-system credentials`

Manages the agent-scoped credential used to access declared 1Password
Environments and direct secret references. The current credential target is
`op`.

```text
openclaw agent-system credentials set op [--agent <id>] [--from-env | --stdin] [--store <id>]
openclaw agent-system credentials validate op [--agent <id>] [--from-env | --store <id>]
openclaw agent-system credentials unset op [--agent <id>] [--store <id>]
openclaw agent-system credentials cache status [--json]
openclaw agent-system credentials cache flush [--agent <id>] [--json]
```

| Option         | Commands                   | Behavior                                                   |
| -------------- | -------------------------- | ---------------------------------------------------------- |
| `--from-env`   | `set`, `validate`          | Reads only `OP_SERVICE_ACCOUNT_TOKEN`.                     |
| `--stdin`      | `set`                      | Reads redirected input without exposing it as an argument. |
| `--store <id>` | `set`, `validate`, `unset` | Targets `keychain`, `secret-service`, or `file`.           |

Without an input option, `set` uses a masked interactive prompt and fails with
guidance in a noninteractive session. Tokens are never accepted as command
arguments. Every set path verifies access to all declared 1Password resources
before storage.

Automatic persistent selection prefers Keychain then file on macOS and Secret
Service then file on Linux. `validate` checks those stores in order and then the
process fallback; an exact `--store` or `--from-env` request disables fallback.
`unset` is idempotent: it removes persisted credentials and requests Gateway cache
invalidation, but does not change the process-environment fallback. See
[global cache configuration](#opcache) for cache controls and pending invalidation.

The file fallback lives at
`$XDG_CONFIG_HOME/tanaab/agent-system/<agent-id>/op-token`, or under
`$HOME/.config` when `XDG_CONFIG_HOME` is unset. Agent System requires owner-only
directories, mode `0600`, and a regular non-symlinked credential file.

### `openclaw agent-system install`

Installs the current workspace agent and reconciles its public identity, model
defaults, memory search, executable paths, setup, and configured capability state.

```text
openclaw agent-system install [--yes] [--non-interactive] [--skip-setup] [--json]
```

| Option              | Behavior                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| `--yes`             | Consents to setup without prompting.                                              |
| `--non-interactive` | Runs without prompting, implying setup consent.                                   |
| `--skip-setup`      | Skips every setup check and apply with a warning; other components still install. |

These switches take no values: presence sets the option to true and absence
leaves it false. `--skip-setup` takes precedence over consent. With applicable
setup, interactive installation previews the workspace and ordered check/apply
commands, shells, and timeouts on stderr before asking yes or no. Declining or
cancelling stops before any install mutation. No applicable setup means no
setup prompt.

Noninteractive stdin also implies consent. The `CI` and `NONINTERACTIVE`
environment variables each enable unattended consent for trimmed,
case-insensitive `1`, `true`, `yes`, or `on`. Unset, empty, `0`, `false`, `no`,
`off`, and unrecognized values do not enable that source; they do not override
another enabling option or noninteractive stdin. `--json` alone does not imply
consent, and prompts or warnings never become part of stdout JSON.

Consent is not persisted. An unattended invocation trusts the current workspace
declarations, including changes since the previous run.

Installation validates first and, when an OP Environment or direct secret is
declared, requires a working persistent credential before applying changes. It
verifies owned state and reports it unchanged when already reconciled. Setup
may also change external state; its [check and retry rules](#checks-installation-and-retries)
determine what repeats. An existing agent id bound to another workspace fails
instead of being repointed. It also reconciles per-agent grants for the native
Git, managed-worktree, and GitHub tools selected by the manifest while preserving
unrelated grants. GitHub installation additionally reconciles an agent-scoped
OpenClaw managed profile when explicit account and credential bindings are
present. An explicit operator-owned denial or unmarked conflicting profile
remains authoritative and blocks reconciliation.

### `openclaw agent-system doctor` (alias: `status`)

Inspects agent registration, public identity, model and memory configuration,
path projection, and configured capabilities for drift without applying repairs.

```text
openclaw agent-system doctor [--agent <id>] [--json]
openclaw agent-system status [--agent <id>] [--json]
```

Doctor, also available as `status`, reports all findings, returns nonzero for failing drift, and recommends
`install` for repairable owned state. Manual state remains the operator's
responsibility. It also reports tool-access and execution-boundary findings;
tool-specific checks are documented in each tool guide. For [setup](#setup),
Doctor runs applicable checks without consent or repairs, reports unchecked
steps as manual, and marks nonmatching runtime steps as skipped. OpenAI memory inspection
performs one bounded embedding request, which may incur a small provider charge;
other providers remain read-only and unprobed.

### `openclaw agent-system notifications`

Runs the command family owned by the `agent-system-github` channel.

```text
openclaw agent-system notifications <refresh|status|wait> [options]
```

See the channel's [complete CLI reference](./channels/github/README.md#cli) for
command syntax, selectors, wait targets, output, and exit behavior.

### `openclaw agent-system tool`

Runs a registered command through its Agent System tool. Direct invocations are
an explicitly selected operator identity and are intended for administration,
testing, and debugging. Agents should use the corresponding native
`agent_system_*` tool for direct work. A public tool integration contract is
planned in [Tool API](./API.md).

```text
openclaw agent-system tool <command> [--agent <id>] -- <arguments...>
```

| ID                          | Command    | CLI                                   | Shim                                           |
| --------------------------- | ---------- | ------------------------------------- | ---------------------------------------------- |
| `agent_system_git`          | `git`      | [Usage](./tools/git/README.md#cli)    | [Packaged shim](./tools/git/README.md#shim)    |
| `agent_system_git_worktree` | `worktree` | [Usage](./tools/git/README.md#cli)    | none                                           |
| `agent_system_github`       | `gh`       | [Usage](./tools/github/README.md#cli) | [Packaged shim](./tools/github/README.md#shim) |

Tool-specific arguments, policy, and routing behavior belong in the linked guide.

## Environment Resolution

Source precedence is fixed:

```text
environment.dotenv[0] < later dotenv files < environment.set < environment.op[0] < later 1Password Environments
```

Variable names match `^[A-Za-z_][A-Za-z0-9_]*$`; values are YAML strings or
`from-op` objects. Dotenv files must be distinct regular files inside the
workspace. They accept comments, optional `export`, and quoted or unquoted
`NAME=value` entries without interpolation or shell execution.

`environment.set` strings expand uppercase `$NAME` and `${NAME}` references
once; `$$` emits `$`. Lookups use the process environment and ordered external
sources, never sibling `set` values. Host values are lookup-only.

A `from-op` object resolves a secret directly:

```yaml
environment:
  set:
    SSH_KEY:
      from-op: 'op://vault/item/private key?ssh-format=openssh'
```

These values are always sensitive; diagnostics omit the reference itself.
A plain `op://` string stays literal. `environment.op` takes opaque
[1Password Environment IDs](https://www.1password.dev/sdks/environments#appendix-get-an-environments-id),
not display names, and loads them in order through the SDK.

Only explicit consumers load dotenv or 1Password values; passive discovery never
does. `environment.required` applies to complete environment resolution, not
unrelated actions. [Credential storage](#openclaw-agent-system-credentials)
defines lookup order. Install requires a persistent credential; the bootstrap
token is never exported, required, or interpolated by the manifest.

Agent System tools resolve declared values after trusted binding and authorization.
The consolidated environment is not injected into generic OpenClaw, Codex, ACP,
MCP, or third-party tools. PATH projection is the separate contract below.

## Path

Installation builds one deterministic managed prefix followed by a saved Codex
baseline:

```text
<workspace>/bin
<workspace>/<environment.path-prepend[0]>
<workspace>/<later declared entries>
<agent-system-package>/bin
<saved Codex baseline>
```

Declared entries are literal workspace-relative directories. They must exist,
remain inside the canonical workspace without traversing symlinks, and need not
repeat the automatically managed workspace or package `bin` directories.

Initial installation seeds the baseline from the invoking process PATH. Later
installs preserve its exact order and append caller directories not already
saved. Exact duplicates are removed; distinct path aliases are retained.
Managed workspace, declared, and package entries remain authoritative at the
front and obsolete known managed entries are reconciled.

Agent System projects the managed prefix into the selected agent's OpenClaw
`tools.exec.pathPrepend`. For local Codex native shell commands, it writes an
equivalent machine-specific `<workspace>/.codex/config.toml` and adds that path to
the root `.gitignore`.

Agent System owns the Codex file only when it contains
`# agent-system: managed-path-v1`. An existing unmarked file or one containing
`# agent-system: manual-path-v1` remains user-managed. Add the equivalent settings
to a user-managed file without duplicating existing TOML tables:

```toml
# agent-system: manual-path-v1

allow_login_shell = false

[features]
shell_snapshot = true

[shell_environment_policy.set]
PATH = "/absolute/workspace/bin:/absolute/agent-system/bin:/base/path"
```

Rerun `install` when the workspace, package location, declared paths, or host PATH
changes. Use `openclaw agent-system install --rebuild-codex-path` only when the
saved baseline should be replaced by that CLI environment. Native chat Install
offers the equivalent approved `rebuildCodexPath` option. Both report baseline
changes; neither modifies user-managed Codex configuration.

The union preserves directory availability, not every caller's command
precedence. Existing baseline order wins, stale entries can accumulate, and PATH
health does not inventory or prove the availability of executables. Doctor names
caller directories that Install would append, but extra, reordered, or
nonexistent saved baseline entries do not alone indicate drift.

Start a new Codex session after PATH changes; existing sessions do not hot-reload
the workspace configuration. Agent System disables login-shell
execution and sets the deterministic PATH without otherwise changing Codex's
inherited-environment policy. Remote, sandboxed, ACP, MCP, and third-party
surfaces retain their own path and mount contracts.
