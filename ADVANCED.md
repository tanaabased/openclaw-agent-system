# Advanced

This guide contains Agent System's advanced manifest, logging, and CLI references. Start with the [README](./README.md) for installation and the common workflow; use [DEVELOPMENT.md](./DEVELOPMENT.md) when changing Agent System itself.

## Advanced Usage

### Workspace Manifest Lifecycle

An OpenClaw agent workspace opts into Agent System with one manifest:

```text
.agent-system/agent.yaml   # preferred
agent.yaml                 # shorthand
```

The preferred file wins when both exist; the files never merge. Agent System loads the selected manifest at `session_start` and `before_prompt_build`. Passive loading validates and reports non-secret manifest state but never resolves environment values, adds agents, changes identity, installs dependencies, or executes workspace code. Prompt construction adds concise tool guidance only for capabilities configured by that manifest.

Manifest discovery rejects symlinked manifests, a symlinked `.agent-system` directory, files larger than 1 MiB, invalid UTF-8, YAML anchors, aliases, explicit tags, duplicate keys, and unknown schema keys.

### Explicit Agent Onboarding

Run installation from the workspace represented by the manifest:

```sh
# Enter the workspace represented by the manifest.
cd /path/to/agent-workspace

# Install or reconcile the workspace agent.
openclaw agent-system install
```

Installation compares the manifest with current OpenClaw configuration. It resolves an environment-backed display name when declared, adds an absent agent, reconciles the manifest-owned display name and optional avatar, configures the supported executable paths, reloads configuration, and verifies the final state. A matching installation is unchanged. An existing agent id bound to another workspace fails instead of being silently repointed.

The implicit `main` agent is not redundantly added when OpenClaw has no explicit agent list. `agent.email` and `agent.description` are validated manifest data but are not currently applied to OpenClaw identity. Installation does not choose a model, prompt for or import credentials, start a Gateway, deliver the resolved environment to generic execution tools, or run a workspace installation script. It resolves the environment only when the installed name references it. When `environment.op` is declared, install first validates stored OP access without the process-environment fallback, before resolving the name or reading or mutating OpenClaw state.

## Configuration Reference

Agent System currently has two configuration layers: an empty global plugin configuration and the per-workspace manifest described below.

### Plugin Configuration

Agent System currently owns no global plugin configuration; `openclaw.plugin.json` intentionally exposes an empty strict configuration schema. The workspace manifest is the current configuration surface.

### Workspace Manifest

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email:
    from-environment: AGENT_EMAIL
  description: Tanaab development agent.
  avatar: avatar.png

environment:
  dotenv:
    - .agent-system/env/base.env
    - .agent-system/env/local.env
  set:
    AGENT_COLOR: green
    AGENT_EMAIL: $COMPANY_EMAIL
    NODE_ENV: development
  op:
    - env_team
    - env_agent
  path-prepend:
    - tools/bin
  required:
    - AGENT_EMAIL

github:
  host: github.com
  username:
    from-environment: AGENT_GITHUB_USERNAME
  token: GITHUB_TOKEN
```

| Field                      | Required      | Current behavior                                                                    |
| -------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `schema-version`           | yes           | Must be the integer `1`.                                                            |
| `agent.id`                 | yes           | Lowercase identifier matching `^[a-z0-9][a-z0-9-]*$`; binds manifest to agent.      |
| `agent.name`               | for `install` | Literal or environment-backed; applied as the OpenClaw display name during install. |
| `agent.email`              | no            | Literal or environment-backed; reserved for a Git identity consumer.                |
| `agent.description`        | no            | Validated and loaded; reserved for a later identity surface.                        |
| `agent.avatar`             | no            | Applied during install when declared; an undeclared existing avatar is retained.    |
| `environment.dotenv`       | no            | One relative path or an ordered non-empty unique list of paths.                     |
| `environment.set`          | no            | String map that overrides dotenv layers for explicit Agent System consumers.        |
| `environment.op`           | no            | One Environment id or an ordered non-empty unique list of ids.                      |
| `environment.path-prepend` | no            | One workspace-relative directory or an ordered non-empty unique list.               |
| `environment.required`     | no            | Non-empty unique list that fails resolution when a final value is absent or empty.  |
| `github.host`              | no            | Literal `github.com`; defaults to `github.com`.                                     |
| `github.username`          | no            | Literal or environment-backed expected authenticated login; verified when declared. |
| `github.token`             | with `github` | Environment binding resolved only inside an authorized GitHub tool action.          |

Schema-owned YAML keys use kebab-case. Unknown keys, camelCase alternatives, and snake_case alternatives fail validation rather than being ignored.

#### Manifest Value Kinds

Each schema field selects one closed value kind; manifests cannot name arbitrary resolvers or schema modules:

| Value kind          | YAML form                                             | Meaning                                                                                    |
| ------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| literal             | `name: Tanaabot`                                      | The scalar is the configured value.                                                        |
| resolvable          | a literal or `name: { from-environment: AGENT_NAME }` | The field may be literal or consume one value from the completed Agent System environment. |
| environment binding | `token: GITHUB_TOKEN`                                 | The scalar names an environment variable and can never be a literal credential.            |

`agent.id`, `agent.description`, and `agent.avatar` are literal. `agent.name`, `agent.email`, and `github.username` are resolvable. `github.token` is the first implemented environment-binding field. Environment names in references and bindings match `[A-Z_][A-Z0-9_]*` and remain literal data keys.

A dollar-prefixed scalar outside `environment.set` remains literal. For example, `agent.name: $AGENT_NAME` is the display name `$AGENT_NAME`; environment-backed identity must use `from-environment`. References resolve only from the final Agent System environment, never directly from the host lookup, and missing or empty values fail the consuming action without revealing values. A resolvable field does not itself add the referenced name to the environment.

#### Environment Resolution

Environment-variable names must match `^[A-Za-z_][A-Za-z0-9_]*$`. Values must be YAML strings; booleans and numbers fail validation instead of being coerced. Variable names are literal data keys and are never casing-converted.

`environment.dotenv` accepts one path or an ordered list. Paths must be relative, remain inside the canonical workspace even through symlinks, select distinct regular files, contain valid UTF-8, and remain at or below 1 MiB. Every declared file is required.

The owned dotenv parser supports blank lines, full-line comments, optional `export`, and `NAME=value`. Unquoted `#` remains literal unless whitespace introduces an inline comment. Single-quoted values are literal. Double-quoted values support `\\`, `\"`, `\n`, `\r`, and `\t`. Duplicate names within one file, malformed names, unsupported escapes, unterminated quotes, and NUL bytes fail closed. Dotenv values never interpolate or execute shell syntax.

`environment.op` accepts one Environment id or an ordered list. Agent System dynamically loads the official `@1password/sdk`, authenticates once per explicit resolution, and fetches each Environment in declared order. The SDK's Environment API is currently beta. Failures become stable Agent System diagnostics without including raw SDK errors, Environment ids, tokens, or values.

Source precedence is fixed:

```text
environment.dotenv[0] < later dotenv files < environment.set < environment.op[0] < later 1Password Environments
```

Set values support one-pass `$NAME` and `${NAME}` references for uppercase names matching `[A-Z_][A-Z0-9_]*`; `$$` emits a literal `$`. References resolve against a snapshot of the plugin process environment plus the ordered external-source lookup, with later external sources winning same-named host lookups. The host environment is lookup-only: `AGENT_EMAIL: $COMPANY_EMAIL` contributes `AGENT_EMAIL` but does not contribute `COMPANY_EMAIL`. Missing references fail resolution, and `environment.set` values do not reference one another.

Dotenv files and 1Password values are loaded only when an explicit Agent System environment consumer runs. Passive `session_start` manifest loading never reads or fetches them.

During ordinary environment resolution and credential validation, Agent System tries macOS Keychain then the agent-scoped file fallback on macOS, Linux Secret Service then file on Linux, and finally its permanent `OP_SERVICE_ACCOUNT_TOKEN` process-environment fallback. Installation uses the same persistent-store order but bypasses the process environment. An exact `credentials validate op --store <id>` request also bypasses the process environment. The token is never included in the resolved agent environment, and manifests, dotenv files, and 1Password Environments cannot export, require, or interpolate it.

Agent System does not inject these values into OpenClaw `exec`, Codex native shell commands, ACP or CLI backends, node-host commands, MCP tools, or other harness-specific command surfaces. Executable path projection is a separate, PATH-only contract for OpenClaw exec and local Codex native shell commands. Other surfaces keep their own environment and security contracts. Agent System tools resolve the consolidated manifest environment only after agent binding, input classification, and authorization, then consume only their declared values; the initial GitHub tool supplies only `GH_TOKEN` and fixed non-interactive settings to its owned `gh` child process.

#### GitHub Tool Pilot

The initial tool surface is deliberately narrow. When `github` is configured, Agent System registers `agent_system_github` and adds concise preference guidance during `before_prompt_build`. The native tool, `agent-system tool gh`, and the packaged `bin/gh` command use the same manifest binding, read classification, environment resolution, sanitized runner, output normalization, and metadata-only logging path.

The only accepted request is the authenticated-user lookup represented as `{"argv":["api","user"]}` or `gh api user`. Agent System adds a fixed field projection internally, returns only `host`, `id`, and `login`, and rejects the result when a declared `github.username` does not match the authenticated login. The model never supplies the agent id, workspace, username, field projection, executable, credential name, or token. The runtime currently allows classified reads and rejects every other risk class; broader policy and interactive approval are later Phase 2 work.

Agent System ships one global `bin/gh` compatibility launcher. Exact `gh --agent-system` prints `agent-system` and exits successfully; ordinary arguments pass unchanged to `openclaw agent-system tool gh -- ...` through a minimal POSIX shell process. The launcher resolves `openclaw` through the caller's ordinary `PATH` and never receives an agent credential. Because the workspace `bin/` precedes the packaged bin, an agent can supply its own higher-priority command without Agent System replacing it. After trusted agent binding and credential resolution, the TypeScript tool runtime resolves the real GitHub CLI without a shell and excludes the workspace bin, declared prepended directories, and Agent System's packaged bin to prevent command overrides and recursion. The launcher is routing convenience, not universal interception; absolute binaries, replaced `PATH` values, direct HTTP, SDKs, MCP tools, and unrelated host processes may bypass it.

#### Executable Path Projection

Installation creates the workspace `bin/` directory and builds one deterministic path prefix in this order:

```text
<workspace>/bin
<workspace>/<environment.path-prepend[0]>
<workspace>/<later declared entries>
<agent-system-package>/bin
```

The host `PATH` follows this prefix unchanged. Manifest entries are literal workspace-relative directories: they do not interpolate environment variables, must already exist as real directories, may not traverse a symbolic link, and must remain inside the canonical workspace. Canonical duplicates are removed while preserving first occurrence. The automatically created workspace bin and packaged Agent System bin do not need to be declared.

For ordinary OpenClaw exec, `install` prepends the resolved paths to the selected agent's `tools.exec.pathPrepend` while preserving entries Agent System does not own. For local Codex native shell commands, `install` writes the equivalent literal `PATH` to `<workspace>/.codex/config.toml` with shell snapshots enabled. The Codex file must be refreshed by rerunning `install` when the workspace, package location, declared paths, or host `PATH` changes; start a new Codex session after refreshing it.

Agent System owns a Codex config only when it contains the generated `# agent-system: managed-path-v1` marker. It may create or replace that managed file and adds `.codex/config.toml` to the workspace root `.gitignore` with a visible explanatory comment. An existing unmarked config, or one carrying `# agent-system: manual-path-v1`, is user-managed: installation never edits it and warns the operator to add the rendered PATH configuration manually. Agent System also leaves `.gitignore` ownership to the user in that case.

For a user-managed config, merge the following settings into the existing TOML rather than duplicating an existing table. Replace the placeholder with the same absolute prefix shown under the agent's OpenClaw `tools.exec.pathPrepend`, followed by the intended base PATH. To take ownership of a previously generated file, replace the managed marker with the manual marker; do not retain both. The manual marker makes ownership explicit, and adding `.codex/config.toml` to the root `.gitignore` is recommended because the file is machine-specific and may contain environment values.

```toml
# agent-system: manual-path-v1

[features]
shell_snapshot = true

[shell_environment_policy.set]
PATH = "/absolute/workspace/bin:/absolute/agent-system/bin:/base/path"
```

Agent System sets only the projected `PATH`. It does not override Codex's inherited-environment policy, so the current Codex default or a user-selected `all`, `core`, or `none` policy remains effective.

The projection covers OpenClaw's ordinary exec implementation and the local OpenAI Codex native shell implementation. It does not promise PATH delivery to node-host commands, remote Codex runs, ACP or CLI backends, MCP tools, or arbitrary third-party tools. OpenClaw sandbox exec can use the configured prefix only when the mounted paths and sandbox policy make those host directories available.

`environment.required` applies when Agent System resolves the complete environment, including through `agent-system env`. It does not make every declared variable a prerequisite for unrelated future tool actions; those actions declare and check their own required inputs.

### Runtime Logging

Set `OPENCLAW_LOG_LEVEL=debug` on the OpenClaw process to include debug lifecycle events. Agent System uses the OpenClaw plugin logger and prefixes diagnostic messages with `[agent-system]`. It logs metadata such as trigger, agent id, path, schema version, and a short content digest; it does not log manifest values. Stable diagnostic identities appear as `code=<code>` metadata instead of additional bracketed prefixes.

| Message                                    | Level | Meaning                                                  |
| ------------------------------------------ | ----- | -------------------------------------------------------- |
| `[agent-system] manifest_scope_unresolved` | debug | No authoritative agent could be identified for the hook. |
| `[agent-system] manifest_scope_failed`     | error | Agent or workspace resolution failed.                    |
| `[agent-system] manifest_absent`           | debug | The resolved workspace is unmanaged.                     |
| `[agent-system] manifest_shadowed`         | warn  | The preferred manifest hid the root shorthand.           |
| `[agent-system] manifest_invalid`          | error | Discovery, YAML, schema, or agent binding failed.        |
| `[agent-system] manifest_loaded`           | info  | A valid manifest was loaded.                             |
| `[agent-system] manifest_changed`          | info  | A later load observed a different manifest digest.       |
| `[agent-system] environment_resolved`      | info  | An environment was resolved; reports count and digest.   |
| `[agent-system] tool_call_started`         | info  | A classified tool call began; reports metadata only.     |
| `[agent-system] tool_call_completed`       | info  | A tool call completed; reports duration and bounds.      |
| `[agent-system] tool_call_failed`          | error | A tool call failed with a stable code.                   |

## CLI Reference

All commands are registered beneath `openclaw agent-system`; `openclaw as` is an equivalent alias. Bare `agent-system` or `as` prints command help. Human-facing results use locally aligned labels and Tanaab semantic colors on standard output; `NO_COLOR` and `FORCE_COLOR=0` disable styling. JSON output remains undecorated. Warnings and failures use the OpenClaw plugin logger on standard error. Failed validation, environment inspection, credential management, or installation sets a nonzero process exit code.

### `openclaw agent-system validate`

Discovers and validates a workspace manifest without mutating OpenClaw state.

#### Usage

```sh
# validate the manifest in the current workspace.
openclaw agent-system validate

# validate the configured workspace for one openclaw agent.
openclaw agent-system validate --agent tanaabot

# use the equivalent short command alias.
openclaw as validate --agent tanaabot
```

#### Options

**`--agent <id>`**

Resolves the configured OpenClaw workspace for the exact agent id and requires the manifest's `agent.id` to match. Without this option, validation uses the current directory as the workspace.

#### Behavior

A valid manifest prints its agent id and selected path. A shadowed shorthand produces a warning after the valid result. Missing, invalid, unreadable, unsafe, or mismatched manifests fail with stable diagnostic codes such as `manifest-shadowed`, `manifest-schema`, or `agent-id-mismatch`.

### `openclaw agent-system env`

Resolves and reports the environment variable names Agent System provides for one manifest. It never prints values or predicts another tool's environment.

#### Usage

```sh
# inspect the current workspace without printing environment values.
openclaw agent-system env

# inspect one configured agent in machine-readable form.
openclaw agent-system env --agent tanaabot --json

# use the equivalent short command alias.
openclaw as env --agent tanaabot
```

#### Options

**`--agent <id>`**

Uses the exact agent's configured OpenClaw workspace and requires the manifest to bind back to that id. Without this option, the command discovers the manifest from the current directory.

**`--json`**

Writes structured output. It follows the same value-free contract as human output.

#### Output

The local view includes `agentId`, `workspaceDir`, `manifestPath`, and one entry per variable:

```text
AGENT_COLOR source=environment.set required=false overridden=1
GITHUB_TOKEN source=environment.dotenv[1] required=true overridden=1
```

### `openclaw agent-system tool`

Runs one registered command through its Agent System tool. This is a closed tool registry, not a general raw-secret or arbitrary executable interface.

#### Usage

```sh
# discover the current workspace manifest.
openclaw agent-system tool gh -- api user

# target one exact installed agent from any directory.
openclaw as tool gh --agent tanaabot -- api user

# verify that the packaged gh command belongs to Agent System.
gh --agent-system
```

#### Behavior

The current registry accepts command `gh` and exact arguments `api user`. Without `--agent`, it discovers the current manifest and binds that workspace back to the installed OpenClaw agent. With `--agent`, it resolves the exact configured workspace directly. It then classifies and authorizes the read, resolves the manifest environment, launches the trusted real `gh` executable with only the action credential and sanitized baseline variables, verifies the configured username when present, and writes normalized user JSON. Unsupported commands or arguments fail before credential resolution. The packaged `bin/gh` command delegates ordinary arguments through this same route.

### `openclaw agent-system credentials`

Manages the OP service-account credential for the selected agent. Each operation loads the agent's manifest and uses every declared `environment.op` id as the access check. Results report only selected sources, stores, and Environment counts; they never print token values, Environment ids, resolved values, or raw SDK errors.

#### Usage

```sh
# prompt securely and store in the preferred available backend.
openclaw agent-system credentials set op

# store OP_SERVICE_ACCOUNT_TOKEN in the preferred available backend.
openclaw agent-system credentials set op --from-env

# read a credential from redirected input without putting it in command arguments.
openclaw agent-system credentials set op --stdin < /secure/path/op-token

# force the credential into one exact backend.
openclaw agent-system credentials set op --from-env --store file

# validate the effective credential, including the process-environment fallback.
openclaw agent-system credentials validate op

# validate only OP_SERVICE_ACCOUNT_TOKEN.
openclaw agent-system credentials validate op --from-env

# validate only one persistent backend.
openclaw agent-system credentials validate op --store file

# remove every persisted copy for the selected agent.
openclaw agent-system credentials unset op

# remove only one persistent copy.
openclaw agent-system credentials unset op --store file
```

#### Behavior

Credential input and persistent storage are separate choices. `set op` uses a masked interactive prompt. `--from-env` reads `OP_SERVICE_ACCOUNT_TOKEN`, while `--stdin` reads redirected or piped input and removes one terminal line ending. The input flags are mutually exclusive. A non-interactive invocation without either flag fails with guidance instead of reading the environment implicitly. Agent System does not accept a token as a command argument because process arguments and shell history are not credential-safe.

Every `set` path verifies that the token can access every declared OP Environment before storing it. Without `--store`, Agent System writes to the first usable backend and reports the concrete store used. The persistent order is `keychain`, then `file`, on macOS and `secret-service`, then `file`, on Linux. A missing entry or unavailable native backend falls through during automatic selection; unsafe store state stops selection. Supplying `--store keychain`, `--store secret-service`, or `--store file` requires that exact backend without fallback.

`validate op` uses the platform's persistent order and then the process-environment fallback. `validate op --from-env` checks only `OP_SERVICE_ACCOUNT_TOKEN`, while `--store <id>` checks only that persistent backend. Those selectors are mutually exclusive. A found credential that fails OP access validation does not fall through to a lower-priority copy.

`unset op` removes every persisted copy available to Agent System for the selected agent. Supplying `--store <id>` removes only that backend. Removal is idempotent, skips unavailable stores with a value-free warning, and never changes `OP_SERVICE_ACCOUNT_TOKEN` in the parent process environment.

The `keychain` backend uses the current user's macOS Keychain and is loaded lazily so a missing native binding can fall back safely. The `secret-service` backend uses `secret-tool` without a shell, passes credential input only through standard input, and requires a usable D-Bus Secret Service session. A missing helper, unavailable or locked session, timeout, or helper input limit makes that backend unavailable so automatic selection can use `file`.

The file fallback is stored at `$XDG_CONFIG_HOME/tanaab/agent-system/<agent-id>/op-token`, or `$HOME/.config/tanaab/agent-system/<agent-id>/op-token` when `XDG_CONFIG_HOME` is unset. Agent System creates store directories with owner-only access, creates credential files with mode `0600`, checks ownership and permissions when reading, rejects symlinks and non-regular files, and replaces values atomically. Removal deletes the directory entry but does not claim secure erasure from the underlying storage medium.

The current command accepts only the `op` credential target. Concrete store ids are `keychain` on macOS, `secret-service` on Linux, and `file` on both platforms. Omitting `--store` invokes command-appropriate automatic behavior; `auto` is not itself a store id.

### `openclaw agent-system install`

Installs the agent represented by the current workspace and reconciles its public OpenClaw identity and supported executable paths.

#### Usage

```sh
# install and reconcile the agent represented by the current workspace.
openclaw agent-system install

# use the equivalent short command alias.
openclaw as install
```

#### Options

This command currently has no options. Run it from the intended agent workspace.

#### Behavior

Installation first performs the same manifest discovery and validation used by `validate`. It requires `agent.name` and resolves it from the completed Agent System environment when `from-environment` is declared. A missing or empty name binding fails before any OpenClaw configuration read or command. When `environment.op` is declared, install first verifies that a stored credential can access every declared Environment without using the process-environment fallback and fails with a `credentials set op` remediation before environment resolution or OpenClaw mutation. Installation never prompts for, imports, or stores a credential. It then refuses an agent id already bound to another workspace, runs only the necessary public OpenClaw agent operations, reconciles the OpenClaw and Codex path projections described above, reloads configuration, and fails if registration, identity, or an Agent System-owned path surface still differs from the manifest. `agent.email` is not resolved by install because OpenClaw identity has no email field.

Possible result lines are:

```text
created    OpenClaw agent tanaabot
updated    OpenClaw identity for tanaabot
created    workspace bin directory
updated    OpenClaw exec path for tanaabot
created    Codex workspace path configuration
updated    workspace .gitignore
workspace  /path/to/workspace

unchanged  OpenClaw agent tanaabot
workspace  /path/to/workspace
```

The created and updated lines may appear together on first installation. Repeated installation produces the unchanged line when no reconciliation is needed. An existing user-managed `.codex/config.toml` instead produces a warning and remains outside Agent System remediation.

### `openclaw agent-system doctor`

Inspects implemented Agent System path projection for drift without applying repairs.

#### Usage

```sh
# inspect the current workspace without repairing it.
openclaw agent-system doctor

# inspect one configured agent workspace.
openclaw agent-system doctor --agent tanaabot

# emit stable machine-readable findings.
openclaw agent-system doctor --agent tanaabot --json
```

#### Options

**`--agent <id>`**

Resolves the configured OpenClaw workspace for the exact agent id. Without this option, doctor uses the current directory as the workspace.

**`--json`**

Writes the value-free result as JSON instead of styled summary lines.

#### Behavior

The current doctor slice compares the expected prefix with OpenClaw exec configuration, checks Agent System-owned Codex path content, and confirms that `.codex/config.toml` is listed in the workspace `.gitignore`. Drift returns a nonzero exit code and recommends rerunning `install`. A user-managed Codex config is reported as manual rather than repaired or treated as failing drift; the operator remains responsible for its PATH and ignore rule.

## Planned Advanced Surfaces

### Installation Scripts And Drift

Workspace installation scripts, non-mutating plans, and successful-run metadata are not implemented. The current `install` and `doctor` commands cover OpenClaw agent registration, public identity reconciliation, and supported executable path projection only.

### Diagnostics

The planned `plan` command and broader tool policy, approval, persistent audit, direct-request, diagnostics, installation-script, and lifecycle doctor surfaces are not registered yet. [SPEC.md](https://github.com/tanaabased/openclaw-agent-system/blob/main/SPEC.md) describes their intended boundaries; this guide will expand their implemented command reference as each surface ships.
