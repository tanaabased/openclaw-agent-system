# Agent System Product Specification

## Purpose

Agent System is an OpenClaw plugin and CLI layer that gives an agent workspace a
reproducible identity, deterministic environment, agent-aware provider tools,
and explicit lifecycle procedures.

The environment runtime is the product's foundation. It resolves declared
literal values, selected host variables, dotenv files, and 1Password
Environments without placing agent secrets in the Gateway environment. Higher
layers consume that environment through purpose-built configuration projections,
Agent System-owned tools, command shims, diagnostics, installation, and later
lifecycle features such as cron synchronization.

Agent System also defines a shared provider API so this package and other
OpenClaw plugins can expose agent-aware tools without independently rebuilding
agent binding, credential resolution, policy, approval, redaction, safe process
execution, and audit behavior. Git and GitHub are the first providers; GOG and
other service integrations may implement the same contract later.

This specification records initial product intent and boundaries. The package is
`@tanaab/openclaw-agent-system`, the OpenClaw plugin id is `agent-system`, the
display name is `Agent System`, and the canonical command is
`openclaw agent-system` with `openclaw as` as its shorter alias.

## Product Architecture

### Environment runtime

The core runtime owns deterministic environment assembly, provenance, required
value checks, secret classification, redaction, bootstrap credential access,
and action-scoped value delivery. It distinguishes a value Agent System can
resolve from one OpenClaw will accept through `resolve_exec_env`.

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
- provider plugins may define additional strictly validated capability sections.

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
- inline strings and restricted environment interpolation;
- explicitly selected host variables and dotenv sources;
- lazy 1Password Environment resolution;
- macOS Keychain bootstrap storage, ephemeral CI bootstrap, and a hardened
  credential-file fallback, with Linux credential backends following the same
  interface;
- required-variable validation, provenance, value-free consolidated `env`
  inspection, automatic provider-output redaction, and static OpenClaw delivery
  classification;
- per-agent executable path prepending through
  `agents.list[].tools.exec.pathPrepend`; and
- focused Leia coverage of installed-plugin, agent-binding, environment, and
  value-free diagnostic boundaries.

### Phase 2: provider API and first tools

Phase 2 delivers:

- the Agent System provider API and runtime service;
- common operation risk, policy, approval, redaction, audit, and error models;
- a fixed-executable CLI runner and a constrained direct-request helper;
- first-party `agent_system_git` and `agent_system_github` tools;
- top-level `git` and `github` manifest projections;
- provider-owned skills, tool descriptions, and concise prompt guidance;
- agent-local `git` and `gh` shims installed into the Phase 1 prepended path;
  and
- provider, capability, executable, and routing diagnostics.

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
interpolations against the fully resolved Agent System environment:

```yaml
git:
  name: EMORI
  email: ${AGENT_GIT_EMAIL}

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

Interpolation occurs after environment assembly and before a consuming
projection is validated. A missing value is an explicit configuration error,
not an empty string or fallback to another agent. Environment-variable names
remain literal data keys and are never casing-converted.

## Environment Model

Environment resolution and environment delivery are separate contracts.
Agent System may successfully resolve a value that OpenClaw refuses to deliver
to its built-in `exec` tool. Resolution therefore never implies that an
arbitrary OpenClaw or third-party tool can receive the value.

The first implementation slice is deliberately narrower than the completed
Phase 1 model. It accepts only literal strings under `environment.set`, offers
them through the agent-aware `resolve_exec_env` hook, and implements value-free
`env` diagnostics with static delivery classification. Host inheritance,
dotenv, 1Password, interpolation, required-variable validation, and path
prepending are subsequent Phase 1 slices.

The first implementation resolves four value sources, in the precedence order
defined below:

1. variables explicitly selected from the host process;
2. dotenv-style environment files;
3. 1Password Environments; and
4. inline string literals declared in `environment.set`.

Inline values may use restricted `${NAME}` interpolation against values already
resolved by the preceding layers. Interpolation is a resolution feature, not an
additional source.

```yaml
environment:
  inherit:
    mode: allowlist
    variables:
      - HOME
      - USER
      - SHELL
      - TERM
      - TMPDIR
      - LANG
      - SSH_AUTH_SOCK

  sources:
    - type: dotenv
      path: .agent-system/env/agent.env
      optional: true
    - type: onepassword-environment
      environment-id: env_emori_dev
      auth: onepassword-service-account
      optional: false

  set:
    AGENT_SYSTEM_AGENT_ID: emori
    NODE_ENV: development
    AGENT_EMAIL: ${COMPANY_EMAIL}

  path-prepend:
    - .agent-system/bin
    - ${AGENT_TOOL_BIN}

  required:
    - AGENT_EMAIL
    - GITHUB_TOKEN
```

Precedence is fixed:

```text
sanitized host environment
  < environment.sources[0]
  < environment.sources[1]
  < later environment sources
  < environment.set
```

Later values override earlier values. The resolver must retain provenance so
diagnostics can explain which source supplied or overrode a variable without
printing its value.

Manifest discovery and routine Gateway hooks load and cache only validated
non-secret manifest data. Dotenv and 1Password values are resolved lazily for
an explicit diagnostic, installation, Agent System tool, or shim action that
needs them. A secret must not be fetched merely because an agent session starts.

### Host inheritance

`environment.inherit.mode` is one of `none`, `allowlist`, or `all`. An allowlist
is the recommended default because it avoids accidentally passing unrelated host
credentials into the resolved environment. Host inheritance is still subject to
the delivery restrictions of the eventual action surface.

### Executable path projection

`environment.path-prepend` is an ordered list of literal or interpolated
directories. Relative entries resolve from the workspace root. Agent System
deduplicates canonical paths while preserving first occurrence and rejects
unsafe or workspace-escaping entries according to the consuming surface's
policy. A missing provider-owned directory is reported as unsynchronized;
only explicit installation may create it.

Agent System-owned child processes use the resolved list directly. For
OpenClaw `exec`, explicit installation reconciles the same list into the bound
agent's `agents.list[].tools.exec.pathPrepend` while preserving unrelated
operator entries. Agent System never returns or overrides `PATH` through
`resolve_exec_env`. `env` reports the effective prepend entries and whether the
OpenClaw projection is synchronized.

### Inline values and interpolation

Inline environment values are strings and support only `${UPPERCASE_NAME}`
interpolation.

- Values resolve against the environment constructed so far.
- Plain values without interpolation remain literal strings.
- Commands, backticks, shell substitutions, and arbitrary expressions never run.
- A missing interpolation is a validation error.
- YAML boolean and numeric coercion must not change environment values.
- Same-block references may resolve in declaration order only if the chosen YAML
  parser and configuration layer preserve that order reliably; otherwise they
  are rejected in the first version.

### Dotenv files

Agent System owns one dotenv parser rather than delegating behavior to a shell.
It supports blank lines, comments, `NAME=value`, and optionally
`export NAME=value`. It does not evaluate commands or shell syntax and rejects
malformed names and NUL bytes.

Relative paths resolve from the workspace root. A missing file is skipped only
when `optional: true`. Secret-bearing files should use owner-only permissions and
remain outside version control.

### Required values and output safety

`environment.required` lists variables that must exist before execution.
It does not suppress a declared variable; remove a variable from the assembled
environment when it should not be delivered. Diagnostic output reports names,
sources, presence, and override status without printing values. Provider result
handling separately redacts known secret material that may appear in command or
HTTP output; there is no manifest `environment.redact` list.

The bootstrap `OP_SERVICE_ACCOUNT_TOKEN` is never included in the ordinary agent
environment, even if it is used internally to resolve a source.

### Delivery classes and diagnostics

Each resolved variable is classified separately for every execution surface.
Static delivery classes are:

- `agent-system-only`: deliverable only to an Agent System-owned child process;
- `exec-candidate`: offered by Agent System through
  `resolve_exec_env`, subject to OpenClaw's private runtime filter;
- `inherited-only`: usable only when already present in the Gateway process;
- `documented-filtered`: documented by the supported OpenClaw compatibility
  contract as rejected or stripped for that surface; or
- `not-applicable`: the target tool does not consume process environment.

The `env` command resolves the selected agent's sources and reports the
consolidated set of environment variables Agent System provides. It reports
variable name, final source, override history, required state, and static
delivery class. This default view describes Agent System's resolved environment;
it does not claim that OpenClaw accepted every variable for `exec`.

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
`ADVANCED.md` must document the high-value OpenClaw-restricted names and
prefixes Agent System classifies statically for each supported compatibility
range. The list is a conservative compatibility hint, not an exhaustive copy of
private OpenClaw policy. The current CLI does not claim to observe the installed
runtime's final filtering decision.

#### Future active Gateway exec-filter diagnostic

A future diagnostic may report which Agent System-provided variable names
survive the installed OpenClaw Gateway's real built-in `exec` filter. It is not
part of the current `env` command.

The currently supported OpenClaw release does not expose built-in `exec`
through the public direct `tools.invoke` catalog, even when
`gateway.tools.allow` includes `exec`. That setting removes an HTTP exposure
deny but does not materialize shell tools in the direct-invocation catalog.
Agent System therefore cannot implement a deterministic, no-model runtime probe
through that surface.

Revisit this diagnostic only when OpenClaw exposes a stable public plugin or
loopback API that can invoke the real built-in `exec` path for an exact agent
under normal hook, policy, and approval behavior. The implementation must use
short-lived non-secret sentinels, never run raw `env`, never expose unrelated
Gateway variables, never import private OpenClaw internals, and never weaken
Gateway policy automatically.

The immediately relevant restrictions in the current supported OpenClaw line
include:

| Variable or prefix                          | Built-in host `exec` behavior                             | Agent System strategy                                         |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------- |
| `PATH`                                      | Direct override rejected                                  | Configure per-agent `tools.exec.pathPrepend`                  |
| `SHELL`, `BASH_ENV`, `ENV`                  | Blocked                                                   | Do not use shell startup variables for agent state            |
| `HOME`, `ZDOTDIR`                           | Existing Gateway value may be inherited; override blocked | Keep OpenClaw state global and avoid per-agent home switching |
| `SSH_AUTH_SOCK`                             | Existing Gateway value may be inherited; override blocked | Resolve agent transport inside the Git tool or shim           |
| `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS` | Override blocked and inherited value stripped             | Apply transport inside the Agent System Git execution service |
| `GIT_CONFIG_*`                              | Override prefix blocked                                   | Use explicit Git arguments/config in the owned process        |
| `GH_TOKEN`, `GITHUB_TOKEN`                  | Override blocked and inherited value stripped             | Resolve only inside the Agent System GitHub execution service |

`resolve_exec_env` remains useful for ordinary non-secret values that OpenClaw
accepts. It is not the general credential delivery mechanism and must not fetch
a secret that the target `exec` process cannot receive.

OpenClaw filters `resolve_exec_env` output before constructing the selected
Gateway, sandbox, or node environment. Choosing sandbox execution therefore
does not make a restricted hook variable pass through. Sandbox-specific static
environment or an Agent System-owned provider executor is a separate delivery
path.

### Shell startup behavior

On supported POSIX Gateway hosts, OpenClaw runs host `exec` through a
non-login, non-interactive shell. Bash uses `--noprofile --norc -c`; zsh uses
`-f -c`. Consequently `.bash_profile`, `.zprofile`, `.zshenv`, and other shell
startup files are not a dependable agent environment source.

OpenClaw separately creates a constrained shell snapshot for bash and zsh by
default. The current implementation captures `.bashrc` behavior through an
interactive bash and explicitly sources `${ZDOTDIR:-$HOME}/.zshrc` for zsh,
then retains aliases, functions, and only a small safe environment allowlist.
Secret-like shell state invalidates the snapshot. `ZDOTDIR` is selected from
Gateway state and cannot be overridden per agent through `resolve_exec_env`.

Agent System therefore does not use shell snapshots for credentials or
per-agent environment assembly. A GitHub Actions-only Leia spike must verify
the supported bash/zsh behavior, `OPENCLAW_SHELL=exec`, PATH ordering, and the
observed treatment of `.bashrc`, `.bash_profile`, `.zshenv`, `.zshrc`,
`.zprofile`, and `ZDOTDIR`. Any compatible snapshot behavior is an OpenClaw
convenience, not an Agent System source-of-truth.

## 1Password Bootstrap Credentials

The service-account token that unlocks a 1Password Environment is host bootstrap
credential state. It must not be stored in `agent.yaml`, in the Environment it
unlocks, or in OpenClaw's global JSON configuration.

The manifest declares the credential mechanism separately:

```yaml
credentials:
  onepassword-service-account:
    type: onepassword-service-account
    token:
      macos:
        type: keychain
        service: dev.tanaab.agent-system
        account: emori/onepassword/service-account-token
      linux:
        type: secret-service
        collection: login
        label: dev.tanaab.agent-system/emori/onepassword/service-account-token
      fallback:
        type: file
        path: ~/.config/tanaab/agent-system/emori/onepassword-token
```

Resolution behavior is:

- use the macOS login Keychain on macOS;
- use a Secret Service-compatible keyring on desktop Linux when available;
- prefer a system service credential on headless Linux where practical; and
- use a raw credential file only as an explicit fallback.

An explicitly named process-environment source may be supported for ephemeral CI
bootstrap, but it is read only by Agent System, is never forwarded to ordinary
agent commands, and must not become the recommended persistent setup.

Bootstrap credential storage is namespaced by agent id by default. Each agent
gets a separate Keychain, Secret Service, or fallback-file entry unless an
operator explicitly configures a shared credential and accepts its broader
service-account scope.

The file fallback must require correct ownership and owner-only permissions,
reject symlinks where feasible, and fail closed when it is unsafe.

Agent System uses the bootstrap token internally to retrieve the requested
1Password Environment, then passes only the resolved Environment values to the
authorized Agent System-owned target process. Each service account should have
the smallest practical scope.

The setup command reads the token without echo, avoids command-line arguments
that enter shell history, and stores or replaces it in the selected backend:

```text
openclaw agent-system credentials set onepassword-service-account
```

## Agent System Provider Tool API

The provider API lets Agent System and other OpenClaw plugins register stable,
agent-aware tools without duplicating identity, environment, credential,
policy, approval, execution, redaction, or audit machinery.

The responsibility boundary is:

```text
Agent System
  agent binding + environment + credentials + policy + approval
  safe execution + redaction + audit + diagnostics

Provider plugin
  stable tool schema + provider configuration projection
  fixed CLI or direct API behavior + operation classification
  normalization + supplemental redaction + concise guidance

OpenClaw agent
  ordinary model-controlled arguments only
```

### Registration and discovery

Each provider plugin registers its own fixed OpenClaw tool names through the
shared Agent System SDK and declares those names in its own OpenClaw plugin
manifest. Agent System does not inspect `agent.yaml` and dynamically synthesize
tool names.

The public API has two coordinated layers:

1. a compile-time SDK containing provider types, registration helpers,
   adapters, compatibility metadata, and test utilities; and
2. a runtime Agent System service that binds the current tool context to an
   agent manifest, environment, policy, approval broker, runner, and audit sink.

The initial implementation may ship the SDK from this package. A separate SDK
package is justified only after an external provider proves the dependency and
versioning boundary. A provider fails closed with a stable diagnostic when
Agent System is absent, disabled, incompatible, or unable to resolve the active
agent and capability.

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
same approval adapter and risk vocabulary apply to first- and third-party
providers.

### Provider definitions

The SDK supports a general direct executor and a fixed-executable CLI adapter.
The exact TypeScript names remain subject to implementation validation, but the
public contract is conceptually:

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

Phase 2 installation reconciles agent-local executable shims into a directory
already projected through Phase 1 `path-prepend`. A shim delegates to the same
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
- configuration is reloaded and verified after mutation; and
- a repeated install with matching registration and identity is a no-op.

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
openclaw agent-system credentials set onepassword-service-account
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
  System-provided environment with provenance, required state, and static
  delivery class. It never prints values.
- `credentials set` securely stores or replaces a bootstrap credential in the
  platform backend.
- `providers` and `capabilities` inspect provider compatibility, the selected
  agent's non-secret binding, required executable or request adapter, credential
  resolvability, and policy without exposing secret values. Human-facing
  commands may accept `--agent`; model-facing tools may not.
- `plan` reports installation inputs, readiness, hash, and drift without running
  the installation script.
- `install` reconciles OpenClaw agent registration and identity, then resolves
  the managed environment and explicitly executes a declared script.
- `doctor` checks manifest validity, credential access, required variables, file
  permissions, expected tools and plugins, provider compatibility, tool and shim
  routing, cron state, and installation drift without repair.

Phase 1 owns `validate`, `env`, and bootstrap credential management. Phase 2
adds provider and capability inspection. Phase 3 completes installation script
execution, cron synchronization, and their corresponding `plan` and `doctor`
checks. The already-supported agent registration and identity reconciliation
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
- Resolution and delivery are distinct; blocked values are never described as
  available to OpenClaw `exec`.
- Static delivery classification is not described as an observed OpenClaw
  result. Reporting `accepted` or `filtered` for the installed runtime remains a
  future improvement pending a stable public OpenClaw invocation path.
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
- First- and third-party providers use one operation, policy, approval,
  redaction, error, and audit contract.
- Git and GitHub credentials are resolved only inside their Agent System-owned
  action path and never placed in the Gateway environment.
- PATH routing uses OpenClaw's per-agent `tools.exec.pathPrepend`, not a direct
  `PATH` override.
- Installation requires explicit operator intent.
- Gateway startup may validate and report drift but never installs dependencies,
  plugins, or configuration automatically.
- Read-only commands do not silently repair host or OpenClaw state.

## Implementation Sequence

### Phase 1

1. Preserve the existing plugin, CLI, manifest discovery, agent binding, safe
   YAML parsing, casing, and public identity reconciliation foundation.
2. Implement literal `environment.set` parsing and resolution, fail-closed exec
   binding, and metadata-only provenance.
3. Implement `env` for current-workspace and explicit-agent selection, static
   OpenClaw delivery classification, and machine-readable value-free output.
4. Define the remaining environment sources, scalar configuration references,
   deterministic precedence, and provenance without resolving secrets at
   session startup.
5. Implement selected host inheritance, dotenv parsing, restricted
   interpolation, and required-value checks.
6. Add centralized secret classification and provider-output redaction.
7. Resolve and reconcile `environment.path-prepend` for Agent System children
   and the bound OpenClaw agent.
8. Define the bootstrap credential interface and implement macOS Keychain,
   ephemeral CI environment input, Linux backends, and the hardened file
   fallback in that order of practical delivery.
9. Resolve 1Password Environments lazily without forwarding the service-account
   token.
10. Add direct unit coverage and minimal GitHub Actions-only Leia scenarios for
    manifest binding, source precedence, value-free diagnostics, path
    projection, and 1Password boundaries.

### Phase 2

1. Define and version the common provider, operation, risk, error, audit, and
   compatibility contracts.
2. Implement provider registration and the runtime Agent System service used by
   first- and third-party plugins.
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
- The exact schema validation library and safe YAML parser options.
- The managed location and format for successful installation metadata.
- Whether same-block inline environment references are supported initially.
- The exact Linux headless service-credential integration.
- Whether OpenClaw should expose its exec-environment projection with accepted
  and rejected diagnostics so routine inspection can avoid an active probe.
- The final compile-time SDK export/package boundary and compatible cross-plugin
  runtime service lookup mechanism.
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
- Whether an upstream OpenClaw hook is needed for stronger exact-command,
  post-approval credential delivery to built-in `exec`.

The initial product direction is:

> A reproducible, inspectable agent runtime that turns one strict manifest into
> deterministic environment resolution, configuration projections, agent-aware
> provider tools, and explicit lifecycle reconciliation without placing agent
> secrets in the Gateway environment.
