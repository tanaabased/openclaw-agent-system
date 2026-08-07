# Agent System Product Specification

## Purpose

Agent System is an OpenClaw plugin and CLI layer that gives an agent workspace a
reproducible identity, deterministic environment, agent-aware provider tools,
and explicit lifecycle procedures.

The environment runtime is the product's foundation. It resolves declared
literal values, dotenv files, and 1Password Environments while allowing explicit
references to a host-environment snapshot without copying that snapshot into the
agent environment. Higher layers consume the assembled environment through
purpose-built configuration projections, Agent System-owned tools, command
shims, diagnostics, installation, and later lifecycle features such as cron
synchronization.

Agent System also defines a provider contract so its own tools can share agent
binding, credential resolution, policy, approval, redaction, safe process
execution, and audit behavior. Git and GitHub are the first providers; GOG and
other service integrations may implement the same contract later. A public
cross-plugin SDK remains a product goal, but depends on a supported OpenClaw
runtime capability rather than an ad hoc process-global registry.

This specification records initial product intent and boundaries. The package is
`@tanaab/openclaw-agent-system`, the OpenClaw plugin id is `agent-system`, the
display name is `Agent System`, and the canonical command is
`openclaw agent-system` with `openclaw as` as its shorter alias.

## Product Architecture

### Environment runtime

The core runtime owns deterministic environment assembly, provenance, required
value checks, secret classification, redaction, bootstrap credential access,
and action-scoped value delivery. Resolution does not modify the Gateway
process or inject values into OpenClaw's generic command-execution tools.
Agent System-owned consumers must explicitly request the values they need.

### Provider tool platform

The provider platform exposes stable OpenClaw tools backed by trusted agent
context and the environment runtime. Agent System owns the common binding,
credential, policy, approval, execution, redaction, and audit lifecycle. A
provider owns its model-facing schema, fixed executable or direct API adapter,
operation classifier, normalization, supplemental redaction, health checks, and
concise tool guidance.

Providers do not receive a general raw-secret API. They request logical
credentials and consume them through an approved child-process or request
helper for the smallest practical action scope.

### Configuration and lifecycle projections

The manifest composes configuration sections over the environment runtime. A
section is not required to map one-to-one to a tool:

- `agent` configures core OpenClaw identity and workspace binding;
- `git` and `github` supply values used by provider tools, shims, installation,
  and diagnostics;
- `environment` defines common values and executable path additions;
- `install` defines explicit operator-run reconciliation;
- future `cron` configuration describes scheduled desired state; and
- later provider integrations may define additional strictly validated
  capability sections.

One section may feed several runtime surfaces, and one provider tool may consume
several sections. The schema must not synthesize arbitrary tool names or load
untrusted provider code from manifest values.

The manifest describes one agent workspace. It is not OpenClaw's global
configuration and must not become a biography, secret store, or general-purpose
host-management format.

## Phased Delivery Contract

### Phase 1: environment foundation

Phase 1 delivers:

- strict manifest discovery, parsing, casing, and agent binding;
- inline strings and restricted references to environment lookup values;
- ordered dotenv sources;
- lazy 1Password Environment resolution;
- macOS Keychain and Linux Secret Service bootstrap storage, ephemeral CI
  bootstrap, and a hardened credential-file fallback;
- required-variable validation, provenance, value-free consolidated `env`
  inspection, and automatic provider-output redaction;
- executable path projection for ordinary OpenClaw exec and local Codex native
  shell commands, plus later optional shim routing; and
- focused Leia coverage of installed-plugin, agent-binding, environment, and
  value-free diagnostic boundaries.

### Phase 2: provider API and first tools

Phase 2 delivers:

- an internal Agent System provider contract and runtime service;
- common operation risk, policy, approval, redaction, audit, and error models;
- a fixed-executable CLI runner and a constrained direct-request helper;
- first-party `agent_system_git` and `agent_system_github` tools;
- top-level `git` and `github` manifest projections;
- provider-owned skills, tool descriptions, and concise prompt guidance;
- agent-local `git` and `gh` shims installed into the Phase 1 prepended path;
  and
- provider, capability, executable, and routing diagnostics.

Publishing the provider contract for third-party plugins follows only after
OpenClaw exposes or accepts a supported typed cross-plugin capability. The
first-party vertical slice must not invent a private runtime service locator.

### Phase 3: lifecycle completion

Phase 3 completes:

- installation planning and explicit execution of a workspace-owned,
  conventionally idempotent reconciliation script;
- installation state and drift diagnostics;
- declarative cron synchronization with stable ownership and no duplicate jobs;
  and
- additional lifecycle-oriented manifest sections that do not belong to the
  environment or provider layers.

## Manifest Contract

### Discovery

Agent System supports these manifest locations at the workspace root:

```text
.agent-system/agent.yaml   # preferred
agent.yaml                 # shorthand
```

Discovery follows these rules:

- `.agent-system/agent.yaml` wins when both files exist.
- The files never merge.
- Validation warns when the lower-priority file is ignored.
- Relative paths resolve from the workspace root, not the manifest directory.
- `schema-version` is required.
- Unknown keys are rejected by default.
- YAML anchors, aliases, custom tags, and executable YAML features are disabled.
- Diagnostics and serialization never reveal or write resolved secret values.

### External and internal key casing

Schema-owned keys in YAML use kebab-case:

```yaml
schema-version: 1

agent:
  github-username: emoriwan

install:
  working-directory: .
```

The JavaScript representation uses camelCase:

```js
{
  schemaVersion: 1,
  agent: {
    githubUsername: 'emoriwan',
  },
  install: {
    workingDirectory: '.',
  },
}
```

The configuration boundary must:

- reject camelCase and snake_case spellings in YAML rather than silently
  accepting multiple public schemas;
- convert schema-owned YAML keys from kebab-case to camelCase after parsing;
- use the camelCase representation throughout application code;
- convert schema-owned camelCase keys back to kebab-case if Agent System ever
  writes a manifest; and
- preserve data keys and user-defined identifiers exactly.

The final rule is important. Environment-variable names such as
`GITHUB_TOKEN`, credential aliases, plugin identifiers, and other map keys that
represent user data must not be converted to `githubToken` or `github-token`.
Key conversion must therefore be schema-aware rather than an unrestricted deep
object transformation.

### Core Next configuration library

The newer configuration implementation in the local Core Next project is useful
prior art. It already provides relevant behavior, including:

- layered configuration stores and deterministic merging;
- YAML parsing and serialization;
- environment-backed configuration;
- kebab-case encoding and camelCase decoding; and
- YAML document updates that can preserve comments.

The initial repository scaffold includes faithful TypeScript ports of Core
Next's `encode` and `decode` utilities. They provide focused, directly tested
casing primitives without coupling Agent System to Core Next's private layout.

Agent System must not depend directly on Core Next's private `_new` paths. Its
security and schema requirements also remain authoritative: generic JavaScript
config loading, executable inputs, permissive YAML behavior, broad environment
ingestion, and unrestricted deep key conversion are not acceptable for
`agent.yaml`. The generic `encode` and `decode` functions must therefore be used
only through schema-aware callers that preserve literal data keys and
secret-handling boundaries.

## Identity Model

The core `agent` section contains stable, human-readable OpenClaw identity data:

```yaml
schema-version: 1

agent:
  id: emori
  name: EMORI
  description: Tanaab coordinating and project-management agent.
  avatar: .agent-system/assets/emori.png
```

Identity follows these rules:

- `agent.id` is a stable machine identifier and does not change implicitly when
  the display name changes.
- `agent.name` is the display name and default Git author and committer name.
- Explicit `install` requires `agent.name` and reconciles `agent.id`, `agent.name`,
  and a declared `agent.avatar` with OpenClaw's agent registration and identity.
- An existing OpenClaw agent id bound to another workspace is a conflict; Agent
  System does not silently repoint it.
- Core identity does not imply Git, GitHub, provider, environment, install, or
  cron configuration. Those sections may reference `agent` values but retain
  their own validation and lifecycle.

## Configuration Value References

Non-secret configuration values may be literal strings or restricted
interpolations against the host lookup and fully resolved Agent System
environment:

```yaml
git:
  name: EMORI
  email: $COMPANY_EMAIL

github:
  username: ${AGENT_GITHUB_USERNAME}
  host: github.com
  token-variable: GH_TOKEN
```

The public `git.name`, `git.email`, `github.username`, and similar fields may
use literal or interpolated values. `github.token-variable` names a resolved
environment variable; it is not the token itself. Tokens, private keys, and
other credentials must remain environment bindings or secret references and
must never appear as literal manifest values.

Both `$NAME` and `${NAME}` are supported for names matching
`[A-Z_][A-Z0-9_]*`. Interpolation occurs after environment assembly and before a
consuming projection is validated. Agent System output overrides a same-named
host lookup value. A reference used by a configuration field does not itself add
that name to the agent environment. A missing value is an explicit configuration
error, not an empty string or fallback to another agent. Environment-variable
names remain literal data keys and are never casing-converted.

## Environment Model

Environment resolution and consumption are separate contracts. Resolving a
value makes it available only to explicit Agent System-owned consumers. It does
not imply that OpenClaw's built-in `exec`, Codex native shell commands, ACP
backends, CLI backends, MCP tools, or third-party tools can receive it.

The current implementation loads ordered workspace-contained dotenv files and
ordered 1Password Environments, accepts strings under `environment.set`,
resolves restricted `$NAME` and `${NAME}` references against a fixed
host-environment snapshot plus the ordered external-source lookup, validates
`environment.required`, and implements value-free `env` diagnostics with
provenance. Agent-scoped OP credential validation and persistent storage through
macOS Keychain, Linux Secret Service, and the hardened file fallback are also
implemented. Executable path projection is implemented separately for ordinary
OpenClaw exec and local Codex native shell commands. Scoped consumer resolution
and centralized provider-output redaction are subsequent Phase 1 slices.

The completed Phase 1 environment has three output sources in a fixed order:

1. ordered dotenv files;
2. inline strings declared in `environment.set`; and
3. ordered 1Password Environments.

The host process environment is a lookup input, not an output source. A manifest
must explicitly bind a host value through `environment.set` when that value
should be part of the agent environment. Interpolation is a resolution feature,
not an additional source.

```yaml
environment:
  dotenv:
    - .agent-system/env/base.env
    - .agent-system/env/local.env

  set:
    AGENT_SYSTEM_AGENT_ID: emori
    NODE_ENV: development
    AGENT_EMAIL: $COMPANY_EMAIL

  op:
    - env_team
    - env_emori

  path-prepend:
    - tools/bin
    - vendor/bin

  required:
    - AGENT_EMAIL
    - GITHUB_TOKEN
```

Precedence is fixed:

```text
environment.dotenv[0]
  < environment.dotenv[1]
  < later dotenv files
  < environment.set
  < environment.op[0]
  < environment.op[1]
  < later 1Password Environments
```

Later values override earlier values. Ordered dotenv files establish the base,
explicit `environment.set` values override that base, and later secure sources
remain authoritative. The order is a product contract rather than a
user-configurable cross-source merge strategy. Within each ordered source type,
a higher array index overrides a lower index. `environment.dotenv` and
`environment.op` each accept either one string or a
non-empty list of unique strings and normalize the scalar form to a one-item
list. Empty strings, empty declared lists, and duplicate entries are invalid.
The resolver must retain provenance so diagnostics can explain which source
supplied or overrode a variable without printing its value.

Manifest discovery and routine Gateway hooks load and cache only validated
non-secret manifest data. Dotenv and 1Password values are resolved lazily for
an explicit diagnostic, installation, Agent System tool, or shim action that
needs them. A secret must not be fetched merely because an agent session starts.

### Host environment lookup

Agent System snapshots the plugin process environment as a reference lookup.
That snapshot is never merged wholesale or selectively inherited into the agent
environment. A declaration such as `AGENT_EMAIL: $COMPANY_EMAIL` exports only
`AGENT_EMAIL`; `COMPANY_EMAIL` remains a host lookup input unless it is also
declared as an Agent System output. This keeps the agent environment explicit
and avoids accidental Gateway credential inheritance.

### Executable path projection

`environment.path-prepend` accepts one literal workspace-relative directory or
an ordered non-empty list. Entries do not interpolate environment variables.
Each entry resolves from the canonical workspace root, must already be a real
directory, may not traverse a symbolic link, and must remain inside the
workspace. Agent System deduplicates canonical paths while preserving first
occurrence.

Explicit `install` creates `<workspace>/bin` and builds one path prefix in this
order:

1. the agent workspace `bin` directory;
2. declared `environment.path-prepend` directories;
3. the installed Agent System package `bin` directory; and
4. the existing host `PATH`.

Installation projects the same prefix into the agent's OpenClaw
`tools.exec.pathPrepend` setting and a literal workspace `.codex/config.toml`
for local Codex native shell commands. OpenClaw entries not owned by Agent
System remain after the managed prefix. The generated Codex config enables
shell snapshots and sets `shell_environment_policy.set.PATH`; because the value
is literal, rerunning `install` refreshes it after any workspace, package,
manifest-path, or host-PATH change. Agent System does not set the Codex
environment inheritance or filtering policy.

Agent System creates or replaces only Codex config carrying its managed marker.
It lists a managed `.codex/config.toml` in the workspace root `.gitignore` with
a visible explanatory comment. An unmarked config, or one carrying the manual
marker, remains user-managed: installation warns without modifying the config
or ignore file. `doctor` reports OpenClaw drift, managed Codex drift, ignore
state, and manual ownership without repair.

This PATH-only projection does not deliver the resolved agent environment to
generic commands. It supports ordinary OpenClaw exec and the local Codex native
shell implementation. Node-host commands, remote Codex execution, ACP and CLI
backends, MCP tools, and arbitrary third-party tools remain outside the
contract. OpenClaw sandbox exec is conditional on the configured directories
being available under its mount and sandbox policy.

### Inline values and interpolation

Inline environment values are strings and support `$UPPERCASE_NAME` and
`${UPPERCASE_NAME}` interpolation.

- Reference names match `[A-Z_][A-Z0-9_]*`.
- Bare references consume the longest valid name, so `${NAME}_SUFFIX` is the
  explicit boundary form when `NAME_SUFFIX` is not the intended lookup.
- `$$` produces one literal `$`.
- Values resolve once against the host lookup plus the ordered external source
  maps. `environment.set` values do not reference one another.
- Plain values without interpolation remain literal strings.
- Commands, backticks, shell substitutions, and arbitrary expressions never run.
- A missing interpolation is a validation error.
- YAML boolean and numeric coercion must not change environment values.

### Dotenv files

Agent System owns one dotenv parser rather than delegating behavior to a shell.
It supports blank lines, comments, `NAME=value`, and optionally
`export NAME=value`. It does not evaluate commands or shell syntax and rejects
malformed names and NUL bytes.

Unquoted values preserve literal `#` characters unless whitespace introduces an
inline comment. Single-quoted values are literal. Double-quoted values support
only `\\`, `\"`, `\n`, `\r`, and `\t` escapes. Dotenv values do not perform
host or dotenv interpolation. Duplicate variables within one file, unsupported
escapes, unterminated quotes, invalid UTF-8, and files larger than 1 MiB fail
closed without including values in diagnostics.

`environment.dotenv` accepts one relative path or an ordered list of relative
paths and resolves them from the workspace root. Absolute paths, lexical or
symlink escapes from the workspace, and paths that canonically select the same
file more than once are rejected. Declared files are required regular files. A
higher list index overrides a lower list index, and `environment.set` overrides
the final dotenv layer. Secret-bearing files should use owner-only permissions
and remain outside version control.

### 1Password Environments

`environment.op` accepts one Environment id or an ordered
list of ids. A higher list index overrides a lower list index, and 1Password
values override dotenv and `environment.set` values. Resolution is lazy and uses
the agent's configured bootstrap credential without adding that credential to
the output environment.

### Required values and output safety

`environment.required` is a non-empty list of unique variables that must exist
with a non-empty value when the complete environment is explicitly resolved,
including by `agent-system env`. It does not turn every variable into a
prerequisite for every Agent System action. A provider or other scoped consumer
declares and checks only the values required for that action.

Removing a variable from the assembled environment is the way to keep it from
Agent System consumers. Diagnostic output reports names, sources, presence, and
override status without printing values. Provider result handling separately
redacts known secret material that may appear in command or HTTP output; there
is no manifest `environment.redact` list.

The bootstrap `OP_SERVICE_ACCOUNT_TOKEN` is never included in the ordinary agent
environment, even if it is used internally to resolve a source.

### Consumers and diagnostics

Environment values have no ambient delivery class. Each Agent System-owned
consumer explicitly requests either the complete environment or a named subset:

- `agent-system env` resolves the complete environment for inspection;
- provider actions resolve only their declared configuration and credential
  variables after validation, policy, and required approval;
- explicit installation may resolve only values required by the installation
  action; and
- later shims delegate to the same scoped provider runtime rather than receiving
  a general environment.

Routine Gateway hooks load only validated, non-secret manifest metadata.
Session startup does not resolve environment values, check complete-environment
requirements, fetch dotenv files, or contact 1Password.

The `env` command resolves the selected agent's sources and reports the
consolidated set of environment variables Agent System provides. It reports
variable name, final source, required state, and override history. It makes no
claim about an unrelated OpenClaw or harness command environment.

Without `--agent`, `env` discovers the manifest from the current workspace
using the normal `.agent-system/agent.yaml`, then `agent.yaml`, precedence. With
`--agent <id>`, it resolves the registered agent workspace and loads that
workspace's manifest instead of using current-directory discovery. If the
registered workspace manifest does not bind back to the explicit agent id, the
command fails closed. It never silently falls back to `main`.

The command never prints environment values and offers no flag that does so.
The 1Password bootstrap token is omitted entirely because it is host credential
state rather than part of the resolved agent environment. Human-readable and
machine-readable output follow the same rule, so `env` is safe to use in logs
and CI.

### Generic command boundary

Agent System does not inject its general environment into OpenClaw `exec`, Codex
native shell commands, ACP command tools, CLI backends, node-host commands, MCP
tools, or other harness-specific command surfaces. Those tools retain their
owning runtime's environment and security contract. The executable-path
projection above is an explicit PATH-only exception for its two supported
surfaces. Agent System does not source shell startup files to approximate
broader per-agent delivery.

Provider tools and other Agent System-owned actions may launch a fixed child
process with a sanitized baseline and an action-scoped subset of resolved
values. That child is a private implementation detail of the Agent System
consumer, not a replacement environment for generic command execution.

## 1Password Bootstrap Credentials

The service-account token that unlocks a 1Password Environment is host bootstrap
credential state. It must not be stored in `agent.yaml`, in the Environment it
unlocks, or in OpenClaw's global JSON configuration.

Credential storage is host state selected by CLI adapters, not manifest state.
Automatic resolution prefers the macOS login Keychain on macOS or Secret
Service on Linux before the file fallback. Other platforms use the file store.
The manifest remains portable and declares only the OP Environments that
require access.

`OP_SERVICE_ACCOUNT_TOKEN` is the always-supported process-environment fallback
after configured credential providers. It is read only by Agent System, is
never forwarded to ordinary agent commands, and is intended for ephemeral CI or
bootstrap rather than recommended persistent setup.

Bootstrap credential storage is namespaced by agent id by default. Each agent
gets a separate Keychain, Secret Service, or fallback-file entry unless an
operator explicitly configures a shared credential and accepts its broader
service-account scope.

The file fallback lives at
`$XDG_CONFIG_HOME/tanaab/agent-system/<agent-id>/op-token`, or
`$HOME/.config/tanaab/agent-system/<agent-id>/op-token` when
`XDG_CONFIG_HOME` is unset. Its directories and files require correct ownership
and owner-only permissions. It rejects symlinks and non-regular credential
files, writes through a private temporary file and atomic rename, and fails
closed when the store is unsafe. Unsetting removes the directory entry but does
not claim secure erasure from the underlying storage medium.

Agent System uses the bootstrap token internally to retrieve the requested
1Password Environment, then passes only the resolved Environment values to the
authorized Agent System-owned target process. Each service account should have
the smallest practical scope.

The credential lifecycle separates input from persistent storage:

```text
openclaw agent-system credentials set op [--from-env | --stdin] [--store <id>] [--agent <id>]
openclaw agent-system credentials validate op [--from-env | --store <id>] [--agent <id>]
openclaw agent-system credentials unset op [--store <id>] [--agent <id>]
```

Without an input flag, `set` prompts through a masked interactive terminal.
`--from-env` reads `OP_SERVICE_ACCOUNT_TOKEN`; `--stdin` supports redirected or
piped automation without putting the token in process arguments. Non-interactive
set operations require one of those explicit sources. Every source is validated
against each `environment.op` declaration before storage.

Omitting `--store` lets `set` use the first usable registered backend and lets
`unset` remove every persisted copy. Persistent order is Keychain then file on
macOS, Secret Service then file on Linux, and file on other platforms. A missing
entry or unavailable backend falls through during automatic selection; unsafe
state stops it. An explicit `--store` requires that exact adapter. Ordinary
`validate op` tries configured stores before the process-environment fallback;
`--from-env` checks only that fallback, while an explicit `--store` bypasses it.
`unset` is idempotent and never changes the parent process environment. `auto`
is not a store id.

Keychain access uses a lazily loaded native binding. Linux Secret Service access
uses `secret-tool` without a shell and passes credential values only through
standard input. A missing binding or executable, unavailable or locked session,
timeout, or backend-specific input limit makes that adapter unavailable without
exposing raw native or subprocess errors.

These commands report only credential source, selected stores, and Environment
count. They never print tokens, Environment ids, values, or raw SDK errors.

When `environment.op` is declared, `install` requires a stored credential that
can access every declared Environment. It performs that check before reading or
mutating OpenClaw state. Installation does not prompt, read
`OP_SERVICE_ACCOUNT_TOKEN`, or store credentials; its failure points users to
the explicit `credentials set` command.

## Agent System Provider Tool API

The provider contract lets Agent System register stable, agent-aware tools
without duplicating identity, environment, credential, policy, approval,
execution, redaction, or audit machinery. The same contract is intended to
become a public provider API once OpenClaw has a supported cross-plugin runtime
capability.

The responsibility boundary is:

```text
Agent System
  agent binding + environment + credentials + policy + approval
  safe execution + redaction + audit + diagnostics

Provider implementation
  stable tool schema + provider configuration projection
  fixed CLI or direct API behavior + operation classification
  normalization + supplemental redaction + concise guidance

OpenClaw agent
  ordinary model-controlled arguments only
```

### Registration and discovery

Agent System registers fixed OpenClaw tool names and declares them in its
OpenClaw plugin manifest. It does not inspect `agent.yaml` and dynamically
synthesize tool names.

The initial implementation keeps the provider contract and runtime inside this
package. It binds the current tool context to an agent manifest, environment,
policy, approval broker, runner, and audit sink. A provider fails closed with a
stable diagnostic when Agent System cannot resolve the active agent or
capability.

The supported OpenClaw SDK currently supplies trusted tool-factory context but
does not expose a general cross-plugin runtime service registry. A later public
API therefore requires a typed OpenClaw capability with provider registration
and runtime lookup. Agent System does not use process globals, private registry
reach-ins, background-service registration, or Gateway RPC as an in-process
service locator. A separate SDK package is justified only after an external
provider proves that supported boundary.

OpenClaw supplies `agentId`, `workspaceDir`, `agentDir`, `sessionKey`, and
sandbox state to a tool factory. The model must never supply an agent id,
account selector that bypasses the manifest binding, executable path, token, or
secret reference.

Native provider tools execute in the Gateway plugin process. A sandboxed
originating session adds an OpenClaw tool-policy gate but does not automatically
relocate provider code or its child process into the configured sandbox. A
provider that genuinely needs sandbox filesystem execution must select an
explicit supported executor; it must not imply that native plugin execution is
sandboxed.

### Common operation model

Every request is validated and classified before credentials resolve or an
action begins:

```ts
type AgentSystemRisk = 'read' | 'write' | 'destructive' | 'admin' | 'unknown';

interface AgentSystemOperation {
  action: string;
  risk: AgentSystemRisk;
  summary: string;
  resources?: Array<{ type: string; id: string }>;
  attributes?: Record<string, string | number | boolean>;
}
```

`unknown` never silently inherits read policy. It fails closed or receives the
strictest configured approval posture. Provider configuration may constrain
accounts, hosts, repositories, working directories, or other resources after
classification.

The shared runtime lifecycle is:

```text
1. OpenClaw invokes a stable provider tool.
2. The tool factory supplies trusted agent and workspace context.
3. Agent System resolves and validates that agent's manifest.
4. Agent System projects the provider's configuration and capability binding.
5. The provider validates and classifies model-controlled input.
6. Agent System evaluates resource policy and obtains required approval.
7. Agent System opens a secret-free pending audit event.
8. Agent System lazily resolves only the required action credentials.
9. The shared CLI or request helper performs the action.
10. Provider and core normalization, bounding, and redaction run.
11. Agent System finalizes the audit event and returns structured output.
```

Because credential resolution occurs inside provider execution, an OpenClaw
`before_tool_call` approval can resolve before the secret is materialized. The
same approval adapter and risk vocabulary apply to every supported provider and
remain part of any future third-party contract.

### Provider definitions

The internal provider contract supports a general direct executor and a
fixed-executable CLI adapter. The exact TypeScript names remain subject to
implementation validation, but the future public contract is conceptually:

```ts
defineAgentSystemTool(api, {
  name,
  capability,
  description,
  inputSchema,
  classify,
  execute,
  normalize,
  redact,
  guidance,
});

defineAgentSystemCliTool(api, {
  name,
  capability,
  description,
  executable,
  credentials,
  classify,
  validate,
  normalize,
  redact,
  guidance,
});
```

Provider execution context exposes purpose-built operations such as an
approved fixed-executable runner and an origin-constrained fetch helper. It
does not expose the entire resolved agent environment or a model-callable
secret retrieval surface. Logical credentials should remain opaque to provider
code where the chosen execution adapter permits it.

### Safe CLI runner

The shared runner:

- launches one fixed, operator-resolved executable with an argument array and
  never an interpolating shell command;
- treats `argv`, `stdin`, `cwd`, repository names, API paths, queries, and all
  other model parameters as untrusted;
- starts from a sanitized baseline environment and adds only
  provider-declared, binding-approved child variables;
- restricts `cwd` to the current agent workspace or an explicitly approved
  job/worktree, including canonical and symlink checks;
- disables interactive prompts, pagers, editors, browser launch, and TTY
  assumptions;
- applies cancellation, timeouts, process-tree cleanup, and bounded output;
- never returns or logs a child environment; and
- preserves a structured, redacted result for non-zero exits and failures.

Workspace-controlled hooks, aliases, extensions, configuration, and executable
resolution are possible code-execution paths and must be handled by each
provider's validation and runner configuration.

### Direct request helper

Providers without a suitable CLI may use a shared request helper. It enforces
provider-declared origins, injects authentication internally, bounds request
and response bodies, redacts headers and errors, respects cancellation and
timeouts, and emits the same operation and audit model as CLI tools.

### Guidance and routing

Each provider ships concise tool guidance rather than injecting a full CLI or
API manual into every prompt. Guidance may include:

- the tool name and the situations in which it is preferred;
- a provider-owned skill with task-oriented examples;
- a short `before_prompt_build` contribution for agents with a configured
  binding; and
- instructions to request the provider CLI's `--help` through the owned tool
  when syntax is unfamiliar.

This is tool guidance or context injection, not hostile prompt injection. It is
advisory. An optional enforcement mode may block high-confidence bypasses, but
must not claim to recognize every shell, absolute path, SDK, MCP, browser, or
third-party plugin route.

### Shims

Phase 2 installation may reconcile agent-local executable shims into an
Agent System-owned directory from Phase 1 `path-prepend`, then explicitly route
supported command surfaces through that directory. A shim delegates to the same
provider runtime as its OpenClaw tool, derives the agent from trusted runtime
context, and invokes a validated real executable without recursion. Tool and
shim requests share classification, credentials, policy, redaction, audit, and
errors; logs distinguish their source.

Shims are defense in depth, not hard isolation. Absolute binary paths, PATH
replacement, `command -p`, direct HTTP/SDK traffic, other tools, node-host
execution, and non-OpenClaw processes may bypass them. Sandbox use requires the
shim and its runtime bridge to exist inside or be mounted into the sandbox.
`doctor` reports unsupported or incomplete routes.

### Errors and audit

Providers return stable categories such as `agent_not_resolved`,
`capability_not_configured`, `provider_unavailable`, `credential_unavailable`,
`resource_denied`, `approval_denied`, `operation_unclassified`,
`invalid_arguments`, `working_directory_denied`, `execution_failed`, and
`execution_timed_out`.

Audit records include agent, session/job context when available, provider,
capability, tool, classified operation, resources, non-secret account metadata,
canonical input hash, approval, duration, status, result size, truncation, and
redaction categories. They never contain tokens, authorization headers,
resolved environments, private keys, bootstrap credentials, or unredacted
sensitive input/output.

## Git and GitHub Providers

Git and GitHub are the proving providers because OpenClaw blocks several
environment variables traditionally used to select per-agent identity,
transport, signing, and credentials.

### Manifest projections

```yaml
git:
  name: EMORI
  email: ${AGENT_GIT_EMAIL}
  transport:
    type: ssh
    private-key-variable: GIT_SSH_PRIVATE_KEY
  signing:
    enabled: true
    format: ssh
    public-key: .agent-system/keys/git-signing.pub
    private-key-variable: GIT_SIGNING_PRIVATE_KEY

github:
  host: github.com
  username: ${AGENT_GITHUB_USERNAME}
  token-variable: GH_TOKEN
  repositories:
    - tanaabased/*
  policy:
    read: allow
    write: approve
    destructive: deny
```

These sections project values from the completed environment. Git and GitHub
credentials name resolved variables; they are never literal manifest values.
The same projections feed tools, shims, installation, validation, `env`, and
`doctor`, demonstrating that configuration sections do not map one-to-one to
tool commands.

### GitHub tool

The stable model-facing tool name is:

```text
agent_system_github(...)
```

Its initial input schema and executor are a Phase 2 vertical-slice decision.
Supported implementation shapes are:

- a CLI-shaped schema such as `{ argv, stdin?, cwd? }` over a fixed trusted
  `gh` executable;
- semantic GitHub operations executed through direct HTTP or Octokit; or
- a hybrid with typed common operations and a constrained `gh api` or direct
  request escape hatch.

This choice does not change agent binding, configuration projection,
classification, policy, approval, credential timing, redaction, audit, or
errors. Transport-specific logic remains behind the GitHub provider rather than
leaking into Agent System core.

The public schema and transport must be selected together. An `argv` schema
commits the model-facing contract to `gh` semantics even if a later
implementation internally translates some requests to HTTP. A semantic action
schema can switch between `gh`, Octokit, and direct HTTP more freely, but
requires Agent System to define and maintain those actions.

When the CLI adapter is used, the child receives only values such as:

```text
GH_TOKEN=<action-scoped resolved value>
GH_PROMPT_DISABLED=1
GH_CONFIG_DIR=<agent-specific trusted directory>
GH_PAGER=cat
PAGER=cat
```

The CLI adapter blocks or tightly controls aliases, extensions, authentication
changes, interactive login, `--web`, browser launch, host/account changes, and
workspace escapes. It classifies nested commands and flags rather than trusting
only the first argument: non-GET `gh api` methods are writes or destructive,
GraphQL mutations are not reads, and unrecognized escape hatches are `unknown`.

The HTTP or Octokit adapter fixes or allowlists GitHub origins, builds routes
from validated semantic input, injects authorization internally, constrains
pagination and response size, and never accepts an arbitrary credential,
authorization header, or unvalidated URL from the model.

Whichever initial surface is chosen, later typed conveniences such as issue
creation or workflow dispatch may be added only when they measurably improve
model reliability, semantic approvals, structured output, or policy. They
compile to the same provider lifecycle and do not create a parallel credential
or execution path.

### Git tool

The first Git surface follows the same pattern:

```text
agent_system_git({ argv, stdin?, cwd? })
```

It runs a fixed trusted `git` executable and applies the projected author,
committer, signing, and transport settings only to that child. It classifies
read, working-tree mutation, history mutation, network write, destructive, and
unknown operations; constrains repository/worktree paths; and treats Git
configuration, hooks, helpers, filters, and aliases as untrusted execution
paths.

Git and GitHub tools receive authoritative context from their OpenClaw tool
factories, bind `manifest.agent.id` to the active agent, and resolve only the
credentials required by the classified action. Neither tool accepts `agentId`,
tokens, secret references, or executable paths from the model.

### Provider verification contract

The shared provider harness and each proving provider must directly verify:

- agent-id and workspace spoofing fail closed, including missing or mismatched
  runtime context;
- tokens, secret references, bootstrap credentials, and resolved environments
  never appear in tool schemas, approvals, results, logs, errors, or audit;
- credentials resolve only after validation, classification, policy, and any
  required approval;
- CLI execution uses the fixed executable and argument array without a shell,
  rejects workspace and symlink escapes, and cleans up on cancellation or
  timeout;
- direct requests enforce allowed origins and reject model-supplied
  authorization headers or arbitrary credential selectors;
- destructive, admin, and unknown operations cannot inherit read policy;
- escape hatches such as `gh api`, Git config, aliases, hooks, helpers, and
  provider extensions receive explicit classification or fail closed;
- output bounding, normalization, redaction, audit completion, and non-zero
  execution results behave consistently; and
- provider SDK and runtime incompatibility produces a stable, secret-free
  diagnostic instead of partial execution.

## Installation Contract

Installation begins by reconciling the current workspace with OpenClaw:

- the current directory supplies the workspace and manifest;
- an absent named agent is added with that workspace;
- OpenClaw's implicit `main` agent is not redundantly added;
- the manifest-owned display name and optional avatar are applied;
- an agent id already bound to another workspace fails without mutation;
- `<workspace>/bin` is created when absent;
- the Agent System-owned OpenClaw exec prefix and managed local Codex PATH
  configuration are reconciled;
- an existing user-managed Codex config is left untouched with a warning;
- configuration is reloaded and verified after mutation; and
- a repeated install with matching registration, identity, and path projection
  is a no-op.

This reconciliation happens only through an explicit `install` command. Gateway
startup and passive manifest hooks never add agents or update identity.

In Phase 3, the manifest may contain an explicit multiline installation and
reconciliation script:

```yaml
install:
  shell: /bin/bash
  working-directory: .
  script: |
    set -euo pipefail

    if command -v brew >/dev/null 2>&1 && [[ -f Brewfile ]]; then
      brew bundle --file Brewfile
    fi

    openclaw plugins install npm:@tanaab/openclaw-mem0
    openclaw plugins enable openclaw-mem0
    openclaw config set plugins.entries.agent-system.enabled true
```

The script is an intentional arbitrary-code escape hatch. The authoring
convention requires it to be idempotent: every explicit run should inspect
current state and mutate only drift. Agent System cannot prove arbitrary shell
idempotence and does not describe the script as inherently safe or declarative.

- Manifest discovery, validation, and Gateway startup never execute it.
- `plan` displays the selected shell, working directory, script, script hash,
  environment readiness, and drift without execution.
- `install` runs it only after explicit operator intent.
- Execution uses the selected shell and fully resolved Agent System environment,
  not an interactive shell paste.
- Agent System sets stable values such as `WORKSPACE_ROOT` and
  `AGENT_SYSTEM_AGENT_ID` before execution.
- Output streams through known-secret redaction.
- A successful run records the manifest version and script hash so `doctor` can
  report later drift.
- Authors use reconciling commands, safe existence checks, and explicit updates
  rather than unconditional appends, duplicate creation, or destructive reset.
- Re-running `install` is supported and expected. A correctly authored script
  converges without duplicating resources or mutating already-synchronized
  state.
- Validation may identify common non-idempotent patterns, but warnings do not
  prove that a script is safe or convergent.

Because the script is arbitrary code, `plan` must not claim it can predict every
host mutation. Its reliable contract is to show inputs, readiness, and changes
from the last successful script hash.

## Cron and Scheduled Desired State

Phase 3 may add a top-level `cron` section for jobs owned by the agent
workspace. Cron configuration is declarative desired state rather than an
arbitrary startup side effect.

Each job requires a stable manifest identifier. Explicit synchronization:

- creates a missing owned job;
- updates an owned job whose schedule or payload drifted;
- leaves a matching job unchanged;
- removes a previously owned job only through an explicit prune or removal
  operation; and
- never adopts or mutates an unowned job merely because its schedule or command
  looks similar.

Gateway startup and passive hooks may validate and report cron drift but do not
create, update, or delete jobs. The exact job schema, OpenClaw ownership marker,
payload model, and synchronization command remain Phase 3 design work.

## CLI Contract by Phase

```text
openclaw agent-system validate
openclaw agent-system env [--agent <id>]
openclaw agent-system credentials set op [--from-env | --stdin] [--store <id>] [--agent <id>]
openclaw agent-system credentials validate op [--from-env | --store <id>] [--agent <id>]
openclaw agent-system credentials unset op [--store <id>] [--agent <id>]
openclaw agent-system providers list
openclaw agent-system capabilities inspect github --agent emori
openclaw agent-system capabilities test github --agent emori
openclaw agent-system plan
openclaw agent-system install
openclaw agent-system doctor
```

`openclaw as` is an alias for the same canonical command tree, so, for example,
`openclaw as validate` and `openclaw agent-system validate` are equivalent.

- `validate` discovers and parses the manifest and reports invalid or unresolved
  declarations without mutation.
- `env` resolves the current workspace manifest by default, or the registered
  workspace selected by `--agent`, and reports the consolidated Agent
  System-provided environment with provenance and required state. It never
  prints values or predicts another tool's environment.
- `credentials set` reads a masked prompt, the fixed process environment, or
  standard input; validates every declared OP Environment; and stores or
  replaces the bootstrap credential in the preferred or explicitly selected
  backend. `credentials validate` checks the effective or explicitly selected
  credential without revealing values, and `credentials unset` removes every
  persistent copy or one exact backend entry idempotently.
- `providers` and `capabilities` inspect provider compatibility, the selected
  agent's non-secret binding, required executable or request adapter, credential
  resolvability, and policy without exposing secret values. Human-facing
  commands may accept `--agent`; model-facing tools may not.
- `plan` reports installation inputs, readiness, hash, and drift without running
  the installation script.
- `install` currently reconciles OpenClaw agent registration, identity, and the
  supported executable paths. Phase 3 then resolves the managed environment and
  explicitly executes a declared script.
- `doctor` currently checks supported OpenClaw and Codex path projection without
  repair. Later phases add credential access, required variables, file
  permissions, expected tools and plugins, provider compatibility, shim routing,
  cron state, and installation-script drift.

Phase 1 owns `validate`, `env`, bootstrap credential management, executable path
projection, and its narrow `doctor` checks. Phase 2 adds provider and capability
inspection. Phase 3 completes installation script execution, cron
synchronization, and their corresponding `plan` and expanded `doctor` checks.
The already-supported agent registration, identity, and path reconciliation
remain the first part of explicit `install` throughout these phases.

## Product Invariants

- Public identity is configuration; credentials are references or host bootstrap
  state.
- Schema-owned YAML keys are kebab-case and application-owned JavaScript keys are
  camelCase.
- Environment-variable names and user-defined identifiers retain their literal
  spelling across parsing and serialization.
- Environment resolution is deterministic and does not depend on shell startup
  files or OpenClaw shell snapshots.
- Environment resolution is not ambient delivery. Generic command tools receive
  no Agent System environment-value injection; the two supported command
  surfaces receive only the explicit executable-path projection.
- Interpolation is restricted and never evaluates shell syntax.
- Source ordering and override behavior are explicit and inspectable.
- Secrets are never written into the manifest or printed by normal diagnostics.
- The 1Password bootstrap token is never passed to ordinary agent commands.
- Manifest sections are configuration projections, not implicit one-to-one tool
  registrations.
- Provider tools derive the agent from trusted OpenClaw context and never accept
  agent identity, executable paths, tokens, or secret references from the model.
- Credentials resolve after classification and required approval, for the
  smallest practical child process or request scope.
- All Agent System providers use one operation, policy, approval, redaction,
  error, and audit contract. A future third-party API preserves that contract.
- Git and GitHub credentials are resolved only inside their Agent System-owned
  action path and never placed in the Gateway environment.
- Ordinary OpenClaw exec, local Codex native shell commands, Agent System-owned
  children, and later supported shim routes use explicit path configuration
  rather than Gateway-wide or shell-startup mutation.
- Installation requires explicit operator intent.
- Gateway startup may validate and report drift but never installs dependencies,
  plugins, or configuration automatically.
- Read-only commands do not silently repair host or OpenClaw state.

## Implementation Sequence

### Phase 1

1. Preserve the existing plugin, CLI, manifest discovery, agent binding, safe
   YAML parsing, casing, and public identity reconciliation foundation.
2. Implement literal `environment.set` parsing and resolution with metadata-only
   provenance and no generic command-environment injection.
3. Implement `env` for current-workspace and explicit-agent selection with
   machine-readable value-free output.
4. Define the fixed output-source precedence, scalar-or-list normalization, and
   scalar configuration references without resolving secrets at session startup.
5. Implement `$NAME` and `${NAME}` host-lookup interpolation for
   `environment.set`, followed by required-value checks.
6. Implement ordered dotenv parsing and provenance, then ordered lazy 1Password
   Environment resolution with the same merge contract.
7. Implement agent-scoped OP credential management with explicit input,
   environment-access validation, macOS Keychain, Linux Secret Service, the
   hardened file fallback, and the permanent process-environment fallback.
8. Resolve `environment.path-prepend`, create the workspace bin, and project the
   deterministic prefix into ordinary OpenClaw exec and local Codex native shell
   commands, with managed-config ownership and read-only drift diagnostics.
9. Add centralized secret classification and provider-output redaction.
10. Add direct unit coverage and minimal GitHub Actions-only Leia scenarios for
    manifest binding, source precedence, value-free diagnostics, path
    projection, and 1Password boundaries.

### Phase 2

1. Define and version the common provider, operation, risk, error, audit, and
   compatibility contracts.
2. Implement internal provider registration and the runtime Agent System service
   used by the first-party proving tools.
3. Implement the fixed-executable CLI runner, constrained request helper, and
   provider test harness.
4. Add common resource policy, OpenClaw approval integration, output bounding,
   and redaction before credential materialization.
5. Add the GitHub projection and prove the initial `agent_system_github`
   model-facing schema and `gh`, HTTP/Octokit, or hybrid executor through a thin
   vertical slice.
6. Add the Git projection and `agent_system_git` over the same provider runtime.
7. Ship provider-owned skills, tool descriptions, and concise conditional
   guidance.
8. Install and validate `git` and `gh` shims through the Phase 1 prepended path.
9. Add provider/capability diagnostics, optional high-confidence bypass
   blocking, and Leia scenarios for tool discovery, approval-before-secret,
   agent separation, shim routing, and secret-free results/audit.
10. Propose a typed OpenClaw cross-plugin capability before exporting the
    provider contract for third-party plugins.

### Phase 3

1. Complete installation planning, hashing, explicit idempotent-by-convention
   script execution, and successful-run state.
2. Extend `doctor` with installation, provider, shim, and lifecycle drift.
3. Define and implement explicitly synchronized cron desired state with stable
   ownership and idempotent reconciliation.
4. Add other lifecycle-oriented manifest sections only after their ownership,
   desired-state, and removal semantics are explicit.
5. Integrate Gateway startup with validation and drift reporting only.

The CLI should remain a thin adapter over reusable discovery, configuration,
environment, credential, identity, redaction, installation, and diagnostic
services.

## Deferred Work

The first implementation does not include:

- backups;
- memories;
- Git worktree management;
- notification routing;
- broad sandbox policy;
- structured dependency or plugin declarations;
- automatic installation at Gateway startup;
- use of interactive or login shell startup files as a credential source;
- hard prevention of every possible Git or GitHub bypass; or
- complete prediction or reversal of installation-script side effects.

GOG and other providers beyond the Phase 2 Git/GitHub proving slice are later
provider work, not new Agent System core environment implementations.

## Open Decisions

- Whether the bounded Core Next casing ports should eventually move into a
  stable shared configuration package.
- The managed location and format for successful installation metadata.
- The exact Linux headless service-credential integration.
- The final compile-time SDK export/package boundary and typed OpenClaw
  cross-plugin provider capability.
- Whether the initial GitHub schema is CLI-shaped, semantic HTTP/Octokit
  operations, or a hybrid, and which executor proves the safest reliable slice.
- Whether one stable tool per provider remains sufficient or common operations
  need narrower approval-aware convenience tools.
- How third-party providers contribute strictly validated manifest projection
  schemas without weakening unknown-key rejection.
- Whether provider tools without a binding are omitted per agent or remain
  visible with a deterministic `capability_not_configured` result.
- The default policy for GitHub and Git writes, destructive operations, and
  unknown classifications.
- The exact cron job schema, ownership marker, synchronization command, and
  removal policy.
- The exact enforcement policy for direct GitHub HTTP, SDK, MCP, and browser
  alternatives without disabling generally useful tools.

The initial product direction is:

> A reproducible, inspectable agent runtime that turns one strict manifest into
> deterministic environment resolution, configuration projections, agent-aware
> provider tools, and explicit lifecycle reconciliation without placing agent
> secrets in the Gateway environment.
