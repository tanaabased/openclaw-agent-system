# Agent System Product Specification

## Purpose

Agent System is an OpenClaw plugin and CLI layer that gives an agent
workspace a reproducible identity, runtime environment, and explicit installation
procedure.

The first implementation is intentionally focused. It discovers and interprets a
workspace manifest, applies the agent's public and Git identity, resolves a
deterministic environment, retrieves 1Password Environment values through secure
host bootstrap credentials, and runs a workspace-owned installation script only
when an operator explicitly requests it.

This specification records initial product intent and boundaries. The package is
`@tanaab/openclaw-agent-system`, the OpenClaw plugin id is `agent-system`, the
display name is `Agent System`, and the canonical command is
`openclaw agent-system` with `openclaw as` as its shorter alias.

## First Implementation Contract

The first useful implementation will:

- discover one workspace-bound `agent.yaml` manifest;
- parse and validate the manifest without executing YAML features or shell code;
- expose a stable agent identity and apply its Git author, transport, and signing
  configuration at execution time;
- assemble an environment from explicitly inherited host variables, dotenv
  files, 1Password Environments, and inline manifest values;
- retrieve the 1Password service-account token from a host credential backend
  without exposing it to ordinary agent commands;
- inspect an installation plan without executing it;
- execute the manifest's installation script only after explicit operator intent;
  and
- report validation, credential, environment, dependency, and installation drift
  through read-only diagnostics.

The manifest describes one agent workspace. It is not OpenClaw's global
configuration and must not become a biography, secret store, or general-purpose
host-management format.

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

The manifest contains stable, human-readable identity data and references to
credentials:

```yaml
schema-version: 1

agent:
  id: emori
  name: EMORI
  description: Tanaab coordinating and project-management agent.
  avatar: .agent-system/assets/emori.png

  git:
    name: EMORI
    email: emori@tanaab.dev
    github-username: emoriwan

    transport:
      type: ssh
      private-key:
        ref: op://EMORI/GitHub SSH Key/private key

    signing:
      enabled: true
      format: ssh
      public-key: .agent-system/keys/git-signing.pub
      private-key:
        ref: op://EMORI/Git Signing SSH Key/private key
```

Identity follows these rules:

- `agent.id` is a stable machine identifier and does not change implicitly when
  the display name changes.
- `agent.name` is the display name and default Git author and committer name.
- `agent.git.email` is the default Git author and committer email.
- `github-username` identifies the expected GitHub actor but does not
  authenticate it.
- Git transport and commit signing are separate concerns and may use separate
  credentials.
- Private keys remain secret references; a public SSH signing key may live in
  the workspace.
- Agent System injects Git author, committer, transport, and signing settings at
  execution time instead of relying on global Git state or model instructions.

## Environment Model

Environment construction is deterministic and independent of interactive shell
startup files such as `.zshrc`.

The first implementation supports four sources:

1. selected variables inherited from the host process;
2. dotenv-style environment files;
3. 1Password Environments; and
4. inline values declared in `environment.set`.

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

  required:
    - AGENT_EMAIL
    - GITHUB_TOKEN

  redact:
    - GITHUB_TOKEN
    - OPENAI_API_KEY
    - OP_SERVICE_ACCOUNT_TOKEN
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

### Host inheritance

`environment.inherit.mode` is one of `none`, `allowlist`, or `all`. An allowlist
is the recommended default because it avoids accidentally passing unrelated host
credentials into the agent environment.

### Inline values and interpolation

Inline environment values are strings and support only `${UPPERCASE_NAME}`
interpolation.

- Values resolve against the environment constructed so far.
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

### Required values and redaction

`environment.required` lists variables that must exist before execution.
`environment.redact` supplements automatic secret detection. Diagnostic and
streaming output must redact known secret values while still reporting variable
names, sources, presence, and override status.

The bootstrap `OP_SERVICE_ACCOUNT_TOKEN` is never included in the ordinary agent
environment, even if it is used internally to resolve a source.

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

The file fallback must require correct ownership and owner-only permissions,
reject symlinks where feasible, and fail closed when it is unsafe.

Agent System uses the bootstrap token internally to retrieve the requested
1Password Environment, then passes only the resolved Environment values to the
target process. Each service account should have the smallest practical scope.

The setup command reads the token without echo, avoids command-line arguments
that enter shell history, and stores or replaces it in the selected backend:

```text
openclaw agent-system credentials set onepassword-service-account
```

## Installation Contract

The manifest may contain an explicit multiline installation and reconciliation
script:

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
    openclaw agent-system register
```

The script is an intentional arbitrary-code escape hatch. It is not inherently
safe, declarative, or idempotent.

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
- Authors should prefer reconciling commands and safe existence checks, but Agent
  System does not claim arbitrary scripts are idempotent.

Because the script is arbitrary code, `plan` must not claim it can predict every
host mutation. Its reliable contract is to show inputs, readiness, and changes
from the last successful script hash.

## Initial CLI Contract

```text
openclaw agent-system validate
openclaw agent-system env
openclaw agent-system credentials set onepassword-service-account
openclaw agent-system plan
openclaw agent-system install
openclaw agent-system doctor
```

`openclaw as` is an alias for the same canonical command tree, so, for example,
`openclaw as validate` and `openclaw agent-system validate` are equivalent.

- `validate` discovers and parses the manifest and reports invalid or unresolved
  declarations without mutation.
- `env` reports variable names, provenance, required state, and redaction state;
  it does not reveal values by default.
- `credentials set` securely stores or replaces a bootstrap credential in the
  platform backend.
- `plan` reports installation inputs, readiness, hash, and drift without running
  the installation script.
- `install` resolves the managed environment and explicitly executes the script.
- `doctor` checks manifest validity, credential access, required variables, file
  permissions, expected tools and plugins, and installation drift without repair.

## Product Invariants

- Public identity is configuration; credentials are references or host bootstrap
  state.
- Schema-owned YAML keys are kebab-case and application-owned JavaScript keys are
  camelCase.
- Environment-variable names and user-defined identifiers retain their literal
  spelling across parsing and serialization.
- Environment assembly is deterministic and independent of shell startup files.
- Interpolation is restricted and never evaluates shell syntax.
- Source ordering and override behavior are explicit and inspectable.
- Secrets are never written into the manifest or printed by normal diagnostics.
- The 1Password bootstrap token is never passed to ordinary agent commands.
- Installation requires explicit operator intent.
- Gateway startup may validate and report drift but never installs dependencies,
  plugins, or configuration automatically.
- Read-only commands do not silently repair host or OpenClaw state.

## Initial Implementation Sequence

1. Scaffold the OpenClaw plugin and CLI entrypoint.
2. Implement workspace-root and manifest discovery.
3. Define the versioned external schema using kebab-case keys.
4. Add safe YAML parsing, casing validation, and schema-aware camelCase decoding.
5. Implement environment inheritance, provenance, and precedence.
6. Add dotenv parsing, restricted interpolation, required-value checks, and
   centralized redaction.
7. Define a credential-provider interface and implement macOS Keychain support.
8. Add Linux credential backends and the hardened file fallback behind the same
   interface.
9. Resolve 1Password Environments without leaking the bootstrap token.
10. Apply runtime Git author, transport, and signing identity.
11. Implement installation planning, hashing, explicit execution, and successful
    run state.
12. Implement `doctor` using the same read-only validators and state readers.
13. Integrate Gateway startup with validation and drift reporting only.

The CLI should remain a thin adapter over reusable discovery, configuration,
environment, credential, identity, redaction, installation, and diagnostic
services.

## Deferred Work

The first implementation does not include:

- backups;
- cron jobs or scheduling;
- memories;
- Git worktree management;
- notification routing;
- broad sandbox policy;
- structured dependency or plugin declarations;
- automatic installation at Gateway startup;
- interactive shell startup-file integration; or
- complete prediction or reversal of installation-script side effects.

## Open Decisions

- Whether the bounded Core Next casing ports should eventually move into a
  stable shared configuration package.
- The exact schema validation library and safe YAML parser options.
- The managed location and format for successful installation metadata.
- Whether same-block inline environment references are supported initially.
- The exact Linux headless service-credential integration.

The initial product direction is:

> A reproducible, inspectable workspace bootstrap layer that turns one strict
> manifest into an agent identity, deterministic environment, secure credential
> access, and an operator-controlled installation process.
