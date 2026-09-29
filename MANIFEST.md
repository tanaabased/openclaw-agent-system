# Manifest Reference

Configure an agent workspace through `agent.yaml`. Start with the
[README](./README.md#usage) for the common workflow; use [Global Configuration](./CONFIG.md)
for operator-owned OpenClaw settings and [CLI Reference](./CLI.md) to apply or inspect declarations.

- [Discovery](#discovery)
- [Component configuration](#component-configuration)
- [Configuration](#configuration)
  - [`schema-version`](#schema-version)
  - [`agent`](#agent)
  - [`models`](#models)
  - [`memory`](#memory)
  - [`environment`](#environment)
  - [`backup`](#backup)
  - [Setup](#setup)
- [Automation contract (proposed)](#automation-contract-proposed)
- [Environment resolution](#environment-resolution)
- [Path projection](#path)

## Discovery

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

## Component Configuration

| Type    | ID                          | Manifest key           | Configuration                                                                    |
| ------- | --------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| channel | `agent-system-github`       | `github.notifications` | [Configuration reference](./channels/github/ADVANCED.md#configuration-reference) |
| tool    | `agent_system_git`          | `git`                  | [Configuration reference](./tools/git/README.md#configuration-reference)         |
| tool    | `agent_system_git_worktree` | `git.worktrees`        | [Configuration reference](./tools/git/README.md#gitworktrees)                    |
| tool    | `agent_system_github`       | `github`               | [Configuration reference](./tools/github/README.md#configuration-reference)      |
| tool    | `agent_system_google`       | `google`               | [Configuration reference](./tools/google/README.md#configuration)                |

Declare a component's manifest key to enable it.

## Configuration

`install` applies declared state to owned OpenClaw settings; credentials remain
outside `openclaw.json`. Core configuration example:

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

| Field         | Type                               | Required      | Default                  | Behavior                                                         |
| ------------- | ---------------------------------- | ------------- | ------------------------ | ---------------------------------------------------------------- |
| `avatar`      | string                             | no            | installed value retained | Applied by `install`; an undeclared OpenClaw avatar is retained. |
| `description` | string                             | no            | none                     | Agent description retained for configured consumers.             |
| `email`       | string or `from-environment` value | no            | none                     | Agent email available to configured consumers.                   |
| `emoji`       | string                             | no            | installed value retained | Applied by `install`; an undeclared OpenClaw emoji is retained.  |
| `id`          | string                             | yes           | none                     | Literal lowercase id matching `^[a-z0-9][a-z0-9-]*$`.            |
| `name`        | string or `from-environment` value | for `install` | none                     | Agent display name applied to OpenClaw by `install`.             |

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

| Field    | Type                         | Required | Default | Behavior                                                      |
| -------- | ---------------------------- | -------- | ------- | ------------------------------------------------------------- |
| `effort` | `medium`, `high`, or `xhigh` | yes      | none    | Explicit profile effort, intersected with runtime support.    |
| `model`  | provider-qualified model ref | yes      | none    | Exact `provider/model` reference; no model value is built in. |

The [routing helper](./tools/model-routing/README.md) validates assessments and
explicit selections against these profiles; it has no built-in model or effort
defaults. Configuration generators can read `profiles.default` from `inspect`.

Model refs cannot select an authentication profile. Runtime and credential
configuration remain outside the manifest.

OpenClaw's `agents.entries.<id>.models` map stores per-model metadata such as
`agentRuntime`; it does not authorize selection. Selection is governed by the
agent's effective `modelPolicy.allow`, which may come from the agent entry or
`agents.defaults`.

`install` applies declared models to the bound agent:

- Sets the primary model and thinking effort from `default`.
- Binds declared models to the agent's established runtime route without resolving credentials.
- Extends a restrictive per-agent `modelPolicy.allow` only as needed, preserving inherited permissions. Unrestricted or matching wildcard policies need no repair.
- Preserves global defaults, fallbacks, other agents, unrelated model settings, and existing sessions.

> [!NOTE]
> An incompatible or ambiguous runtime binding blocks installation. Removing
> profiles later does not undo defaults or policy entries.

`doctor` checks configuration, selection policy, model presence, and effort
support without authentication or inference. OpenClaw owns runtime health.
Explicit unavailability produces a warning; unknown availability is not failure.
Inspection errors remain distinct from known unsupported models or efforts.

Complete work tiers enable [GitHub issue model routing](channels/github/ADVANCED.md#model-routing)
for new issue conversations. A default-only manifest keeps ordinary model behavior.

For standalone Codex task selection, see [Codex model routing](./CODEX.md#model-routing).

### `memory`

`memory` is optional. Omitting it leaves the bound agent's existing OpenClaw
memory search configuration untouched. When present, `search.provider` is
required:

| Field      | Type                      | Required | Default | Behavior                                                                  |
| ---------- | ------------------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `api-key`  | environment name          | no       | none    | Reads one declared Agent System environment binding; valid with `openai`. |
| `model`    | string                    | no       | none    | Overrides OpenClaw's embedding model; valid only with `openai`.           |
| `provider` | `none`, `local`, `openai` | yes      | none    | Selects keyword-only, local embedding, or OpenAI embedding search.        |

`install` sets the bound agent's provider and fallback, plus the optional model
and API-key reference, while preserving other memory settings and agents. The
`none` provider retains keyword search. Configure `local` through OpenClaw before
expecting semantic search:

```sh
openclaw models --agent tanaabot auth login --provider llama-cpp --method local
```

An OpenAI `api-key` becomes an agent-and-binding-scoped `SecretRef`. Use a
declared dotenv file or stored 1Password credential so it survives restarts.
Agent System resolves only that reference when OpenClaw loads its secret snapshot.

> [!NOTE]
> Source-linked installs use the checkout's built standalone provider because
> OpenClaw cannot load plugin integrations from a `config` origin. Build before
> installation; restart the Gateway after changing the provider form or binding.
> An operator who can rewrite `openclaw.json` can copy the reference.

Doctor preserves the memory database and checks readiness by provider:

- `none`: keyword index.
- `local`: local provider availability.
- `openai`: the configured credential and one bounded embedding probe; an unrelated fallback credential cannot establish readiness.

Authentication, permission, billing/quota, and transport failures omit upstream
error bodies. Index identity and synchronization drift are separate findings.

Use OpenClaw's explicit memory commands when you intend to mutate the index:

```sh
# inspect the bound agent without rebuilding its index.
openclaw memory status --agent tanaabot --deep --json

# rebuild only when doctor reports index drift and you intend the write.
openclaw memory status --index --agent tanaabot
```

### `environment`

| Field          | Type                    | Required | Default | Behavior                                                              |
| -------------- | ----------------------- | -------- | ------- | --------------------------------------------------------------------- |
| `dotenv`       | string or string list   | no       | none    | Ordered workspace-relative dotenv files.                              |
| `op`           | string or string list   | no       | none    | Ordered 1Password Environment IDs merged after `set`.                 |
| `path-prepend` | string or string list   | no       | none    | Ordered workspace-relative executable directories.                    |
| `required`     | string list             | no       | none    | Names that fail complete environment resolution when absent or empty. |
| `set`          | string or `from-op` map | no       | none    | Explicit values merged over dotenv values.                            |

Schema-owned YAML keys use kebab-case. Environment names and user-defined
identifiers remain literal and are never casing-converted. See
[Environment Resolution](#environment-resolution) for source precedence and resolution behavior, and
[Path](#path) for executable projection.

### `backup`

Defaults for [workspace backup commands](./CLI.md#openclaw-agent-system-backup-create).
Loading the manifest creates no backups.

| Field                   | Type                         | Required | Default                 | Description                                                      |
| ----------------------- | ---------------------------- | -------- | ----------------------- | ---------------------------------------------------------------- |
| `backup.exclude`        | string array                 | no       | `[]`                    | Workspace-relative glob patterns applied last; exclusions win.   |
| `backup.git-ignore`     | boolean                      | no       | `false`                 | Apply local Git-ignore rules before restoring includes.          |
| `backup.include`        | string array                 | no       | `[]`                    | Workspace-relative glob patterns that restore filtered entries.  |
| `backup.openclaw-state` | `auto`, `required`, or `off` | no       | `auto`                  | Capture an existing agent database, require it, or omit it.      |
| `backup.output`         | string                       | no       | `.agent-system/backups` | Local destination; relative paths resolve against the workspace. |

```yaml
backup:
  output: .agent-system/backups
  git-ignore: true
  openclaw-state: auto
  include:
    - MEMORY.md
    - memory/**
    - DREAMS.md
    - GOALS.md
  exclude:
    - scratch/**
    - previous-backups/**
```

CLI options override manifest fields, which override defaults; there is no
backup-specific environment layer. Include/exclude options replace their manifest
lists; `--include=` and `--exclude=` clear them. Includes cannot override mandatory
exclusions. Exclude previous custom destinations explicitly.

See the [backup command](./CLI.md#openclaw-agent-system-backup-create) for coverage,
destination restrictions, and sensitive-archive handling.

### Setup

Use top-level `setup-host` for host executables and other dependencies needed
before the agent and its managed tools are reconciled. Use top-level
`setup-agent` for work that needs the configured agent and managed tools.
Both run through `install`, with optional checks for repeat installation and
Doctor. The old top-level `setup` is deprecated: it supplies `setup-agent`
only when `setup-agent` is absent. If both are present, `setup-agent` wins;
the unused `setup` declaration is still schema-validated.
Omit setup declarations when first-party configuration already handles the
work. Setup scripts can change files or external services; their authors must
make checks read-only and applies safe to repeat.

| Top-level key | Type              | Required | Default | Behavior                                                                  |
| ------------- | ----------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `setup`       | setup declaration | no       | none    | Deprecated fallback for `setup-agent`; ignored when `setup-agent` exists. |
| `setup-agent` | setup declaration | no       | none    | Runs after managed-tool prerequisites.                                    |
| `setup-host`  | setup declaration | no       | none    | Runs before agent and managed-tool reconciliation.                        |

#### Syntax

Use the short mapping for one checked operation:

```yaml
setup-agent:
  shell: zsh
  check: test -d repos
  apply: mkdir -p repos
```

Either top-level key may use `file` to name one YAML file relative to the
containing `agent.yaml`. The file contains the setup value itself, without a
second wrapper:

```yaml
# agent.yaml
setup-agent:
  file: ./setup.yaml
```

```yaml
# setup.yaml
shell: bash
steps:
  - id: directories
    check: test -d repos
    apply: mkdir -p repos
```

The referenced file may use any inline setup form shown below: a scalar script,
a short mapping, or named steps. `file` cannot be combined with inline fields or
another file reference. Absolute paths, URLs, and paths escaping the workspace
(including through symlinks) are rejected. Commands still run from the bound
workspace, not from the setup file's directory.

| Form                                                                | Meaning                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `setup-agent: mkdir -p repos` or a YAML block scalar                | One unchecked `apply` script using `sh`                                       |
| `check: test -d repos` / `apply: mkdir -p repos`                    | Script using the selected shell                                               |
| `check: [test, -d, repos]` / `apply: [mkdir, -p, repos]`            | Literal argument array, without shell parsing or expansion                    |
| `apply: { command: mkdir, args: [-p, repos], timeout-seconds: 60 }` | Direct executable with optional arguments and timeout; also valid for `check` |

Use `steps` for ordered operations. Strings inherit the section's shell unless a
step overrides it; direct commands ignore shell selection. The manifest is
validated before either phase runs. This example requires `./scripts/dependencies`:

```yaml
setup-host:
  shell: bash
  steps:
    - id: host-tools
      check: brew bundle check --file=Brewfile
      apply: brew bundle --file=Brewfile

setup-agent:
  shell: bash
  steps:
    - id: directories
      check: test -d repos && test -d artifacts
      apply: |
        mkdir -p repos
        mkdir -p artifacts
    - id: dependencies
      runtimes: [openclaw]
      check: [./scripts/dependencies, check]
      apply:
        command: ./scripts/dependencies
        args: [install]
        timeout-seconds: 600
```

Strings, block scalars, and the short mapping normalize to one step named
`default`. Named steps require a unique lowercase kebab-case `id` and an `apply`;
`check` is optional. `steps` must be nonempty and cannot mix with short-mapping
fields. Bare arrays and command objects are not setup shorthand: place them
under `check` or `apply`.

#### Shells, executables, and limits

`shell` accepts only `sh`, `bash`, or `zsh`; the default is `sh` on every platform,
including macOS. The selected shell must already be installed. Strings are
written to private temporary scripts, run with these fixed arguments, and
removed afterward:

| Shell  | Invocation                                        |
| ------ | ------------------------------------------------- |
| `bash` | `bash --noprofile --norc -e -o pipefail <script>` |
| `sh`   | `sh -e <script>`                                  |
| `zsh`  | `zsh -f -e -o PIPE_FAIL <script>`                 |

There are no custom shell wrappers or automatic login-shell selection. Every
command defaults to a 600-second timeout. Only the direct command object accepts
`timeout-seconds`, an integer from `1` through `3600`; strings and arrays retain
the default.

Commands start in the bound workspace with closed stdin and a 64 KiB combined
output capture limit. Timeouts terminate the command's process tree. Ordinary
runs report step ids and diagnostic codes without raw command output. When
GitHub Actions runner debug is enabled, setup commands receive only the exact
`RUNNER_DEBUG=1` signal. Standalone Codex relays bounded `debug: ` lines from
captured standard error to its own standard error. Standard output, other
standard-error lines, command declarations, arguments, and unrelated environment
values remain private. The interactive confirmation deliberately shows the
declared commands, so keep secrets out of declarations.

`setup-host` receives a minimal host environment for home, locale, and temporary
paths, using trusted host executables without managed launchers, agent credentials,
or resolved manifest secrets. It runs from the bound workspace before OpenClaw agent
and tool reconciliation. It still has the installing OS user's filesystem access;
the shell and package manager must already be available on the host.

`setup-agent` under OpenClaw receives a minimal host environment for home, locale,
temporary paths, and OpenClaw profile selection, plus managed command bindings.
Its `PATH` places managed launchers before trusted host executable directories.
Bare `git` and `gh`
use host executables when a descendant leaves agent scope; see the
[command-routing contract](./CLI.md#trust-boundary). The completed
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
both, including bare strings and blocks. Put the filter on the short mapping or
individual named steps, never the `steps` container:

```yaml
setup-agent:
  runtimes: [openclaw]
  check: test -d repos
  apply: mkdir -p repos
```

Lists must be nonempty and contain unique supported values. The invoking
integration selects the runtime from trusted context. OpenClaw always selects
`openclaw`, including for OpenClaw-hosted Codex; the
[standalone Codex adapter](./CODEX.md#skills) selects
`codex`. Model selection, installed binaries, and manifest prose cannot override
that choice.

All declarations are validated. Nonmatching steps run neither command and report
`status: skipped`, `code: setup-not-applicable`, and their `stepId`; they are not
drift or failure. Filtering precedes preparation, so no matching agent-bound steps
means no setup-only managed-tool prerequisite checks. Other configured components
still run normally, and applicable steps retain their declaration order within
`setup-host` and `setup-agent`.
There is no skip exit code or `when` expression.

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

OpenClaw installation checks stored 1Password access, runs `setup-host`, registers
the agent and managed tools, then runs `setup-agent`. Missing managed-tool
prerequisites block agent setup; remaining lifecycle components follow it.

To clone as the agent, first declare its [Git identity and SSH
keys](./tools/git/README.md#configuration-reference) and [GitHub username, token,
and public keys](./tools/github/README.md#configuration-reference). Supply host
executables directly or install them in `setup-host`; credential sources and
key files must be available before agent-bound setup. Then add:

```yaml
setup-agent:
  steps:
    - id: clone-project
      runtimes: [openclaw]
      check: test -d repos/project/.git
      apply: |
        gh api user --jq .login
        mkdir -p repos
        git clone git@github.com:your-org/project.git repos/project
```

Replace `your-org/project` with the target repository. Within agent scope,
managed `gh` and `git` use the declared agent identities without operator-identity
fallback. The process still runs as the installing OS user. This example requires
OpenClaw's managed tools.

## Automation Contract (Proposed)

This is the research contract for [#193](https://github.com/tanaabased/openclaw-agent-system/issues/193),
under [#192](https://github.com/tanaabased/openclaw-agent-system/issues/192).
It is **not shipped syntax**: the current parser rejects `automations`. The parser
belongs to #194, runtime adapters to #195/#196, and operator commands and installed
proof to #197. The following defaults are design decisions for those implementers,
not claims of native support. The [support gates](#automation-support-gates) must
be resolved before enabling either adapter.

### Declaration and Payloads

`automations` is an optional list of jobs or `{ file: ./automations.yaml }` naming
a YAML list. Omission and `[]` both declare no jobs. Once reconciliation exists,
either disables previously owned jobs for that workspace/runtime; neither touches
unmanaged jobs. A referenced YAML file cannot include another YAML file. Each
prompt file resolves relative to the YAML file containing its reference, while
execution always uses the trusted workspace root. Apply the existing loader's
size, encoding, YAML, regular-file, and workspace/symlink containment checks.
Load and validate all references before any native mutation, even for disabled
jobs. A missing or invalid declaration is an error, never an empty list.

| Field             | Type / values                                              | Required           | Default | Contract                                                                                                           |
| ----------------- | ---------------------------------------------------------- | ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `enabled`         | boolean                                                    | no                 | `true`  | Desired enablement; completed one-shots remain consumed.                                                           |
| `id`              | string matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`               | yes                | none    | Unique within the entire declaration, including disjoint runtime filters.                                          |
| `overlap`         | `allow`, `skip`                                            | no                 | `allow` | Whether a due occurrence may start while the same job is running. `skip` drops that occurrence without queuing it. |
| `overrides`       | object with `codex` / `openclaw` keys                      | no                 | none    | Typed, runtime-specific prompt settings described below.                                                           |
| `payload`         | discriminated object                                       | long form only     | none    | Exactly one of `kind: command` or `kind: prompt`.                                                                  |
| `prompt`          | nonblank string or `{ file: path }`                        | prompt short form  | none    | Inline prompt or UTF-8 Markdown content.                                                                           |
| `run`             | nonblank shell string, argv array, or `{ command, args? }` | command short form | none    | Reuses setup execution shapes, not setup checks or lifecycle steps.                                                |
| `runtimes`        | nonempty unique list of `openclaw`, `codex`                | no                 | both    | Non-applicable jobs are skipped; applicable unsupported jobs block reconciliation.                                 |
| `schedule`        | string or schedule object                                  | yes                | none    | Deterministic grammar below.                                                                                       |
| `shell`           | `sh`, `bash`, `zsh`                                        | no                 | `sh`    | Valid only with a shell-string `run`; use setup runner shell flags.                                                |
| `timeout-seconds` | integer, 1–3600                                            | no                 | `1800`  | Requested wall-clock execution limit; no unlimited sentinel.                                                       |

Short form supplies exactly one of `run` and `prompt`. Long form supplies
`payload: { kind: command, run: ..., shell?: ... }` or
`payload: { kind: prompt, prompt: ... }`; `shell` then belongs inside the payload.
Reject mixtures, unknown keys, blank prompts/files, empty argv, NULs, and unsafe
executables using setup's existing checks. Job-level timeout is the only timeout;
the `run` object does not accept setup's nested `timeout-seconds`. There is no
arbitrary `env`, `cwd`, credential, agent-selector, or native JSON escape hatch.

```yaml
automations:
  - id: hourly-review
    schedule: every 1 hour
    prompt: Review outstanding work and report actionable changes.
  - id: backup
    runtimes: [openclaw]
    schedule: '0 2 * * *'
    run: |
      ./scripts/backup-upload.sh
      ./scripts/backup-verify.sh
      ./scripts/backup-prune.sh
```

The shell stops on failure; the backup example's repository-owned scripts must
make verification fail before pruning can proceed. It does not supply a backup
implementation or establish scheduler authorization.

```yaml
# .agent-system/agent.yaml
automations:
  file: ./automations.yaml
```

```yaml
# .agent-system/automations.yaml
- id: daily-review
  enabled: true
  runtimes: [openclaw, codex]
  schedule:
    cron: '0 9 * * 1-5'
    timezone: America/New_York
    missed-run: skip
  timeout-seconds: 1800
  overlap: allow
  payload:
    kind: prompt
    prompt:
      file: ../automations/daily-review.md
  overrides:
    codex:
      target: independent
- id: delayed-report
  schedule: in 1 hour
  payload:
    kind: command
    run: { command: node, args: [scripts/report.mjs] }
```

Prompt jobs default to `target: independent`: a fresh run without the installer's
conversation. Each runtime override accepts only `target`, `model`, and `effort`.
`target` is `independent` or `{ thread: nonblank-native-id }`; the latter must name
an existing conversation verified within that runtime's trusted ownership scope.
There is no implicit `current` target or automatic conversation creation on a
lookup failure. For example, `overrides: { codex: { target: { thread: existing-id } } }`
does not select an OpenClaw session. Omitted model/effort use runtime defaults;
explicit strings must be validated against the selected runtime/model without
substitution. Command jobs reject `overrides`. Overrides cannot replace IDs,
workspace, payload, schedule, authorization, timeout, or overlap. Readback compares
declared overrides and resolved native targeting; an override hidden in a native
session must not silently defeat a declared model or effort.

### Schedule Grammar

Only the following forms are accepted. Trim surrounding schedule whitespace and
collapse ASCII whitespace between grammar tokens; never ask a model to parse it.

| Short form               | Equivalent long form                                       | Normalized discriminator |
| ------------------------ | ---------------------------------------------------------- | ------------------------ |
| `'0 9 * * 1-5'`          | `{ cron: '0 9 * * 1-5', timezone: UTC, missed-run: skip }` | `cron`                   |
| `every 1 hour`           | `{ every: 1 hour, missed-run: skip }`                      | `every`                  |
| `in 1 hour`              | `{ in: 1 hour, missed-run: skip }`                         | `after`                  |
| `'2026-10-01T14:00:00Z'` | `{ at: '2026-10-01T14:00:00Z', missed-run: skip }`         | `at`                     |

Long form requires exactly one of `cron`, `every`, `in`, or `at`; its only other
keys are `timezone` and `missed-run`. Durations are a positive decimal integer
without leading zeros, one space, and `second(s)`, `minute(s)`, `hour(s)`, or
`day(s)` with singular/plural agreement. Units are lowercase; a day is exactly
86,400 seconds. Converted milliseconds must be a safe integer. No fractions,
compound durations, month/year units, bare `1h`, or natural-language dates.

Cron has exactly five numeric fields: minute 0–59, hour 0–23, day-of-month 1–31,
month 1–12, weekday 0–6 (Sunday 0). Each accepts `*`, a number, an ascending
inclusive range, comma lists of those, or `*/n` / `a-b/n` with a positive step
no larger than the field's domain. Reject six-field cron, macros, names, wraparound
ranges, `?`, `L`, `W`, and `#`. Day-of-month and weekday combine with OR when both
are restricted. Reject schedules with no possible Gregorian occurrence, such as
`0 9 30 2 *`; February with a restricted weekday can still match through OR.
Normalize expanded numeric sets so equivalent spellings have identical schedule fingerprints; retain
whether each day field is unrestricted for the OR rule.

`timezone` is a valid IANA zone and applies only to cron, defaulting explicitly
to `UTC` rather than host local time. A missing local time at a DST jump is
skipped; a repeated local time fires once, at its earlier instant. There is no
jitter. `at` requires a valid RFC 3339 timestamp with seconds and `Z` or numeric
offset; normalize it to UTC, reject leap seconds and offset-less dates. Fractional
seconds are limited to milliseconds. `every` uses elapsed time, not wall-clock
DST arithmetic: first due time is the initial successful activation anchor plus
the interval, and subsequent times stay anchored rather than following completion.

`missed-run` is `skip` (default) or `run-once`. At activation or resume, `skip`
consumes missed one-shots and advances recurring jobs to their next future occurrence. `run-once`
coalesces all missed occurrences into one immediate attempt, then resumes cadence;
it never drains an unbounded backlog. Scheduler interruption recovery counts as
a missed occurrence only before execution was admitted. An admitted run with an
unknown outcome is reported for operator action, not automatically replayed.
Adapters must prove these semantics or reject the combination before writes.

### Ownership and Reconciliation

Use an Agent System-owned, versioned, non-secret ledger scoped by runtime profile,
canonical workspace, trusted agent identity, and manifest ID. Native job names are
labels, never ownership proof. Record native ID, declaration key where supported,
last applied native revision, desired content hash, schedule generation, resolved
interval anchor / one-shot time, consumed occurrence, and pending reconciliation
operation. Do not store provider tokens, environment values, or run output there.
Moving a workspace or losing its ledger requires explicit recovery; never adopt
jobs by display name or silently recreate possibly completed jobs.

For each applicable runtime, compute SHA-256 over versioned canonical JSON of the
normalized effective job: defaults materialized, object keys sorted, set-valued
fields sorted, argv order preserved, referenced prompt content loaded, and only
that runtime's overrides applied. Preserve prompt and shell-script whitespace;
YAML formatting/comments and equivalent schedule spellings alone are not drift.
Reference path changes with identical effective content do not restart a schedule.
Do not hash credentials or unrelated manifest sections. A script invoked by path
remains live workspace code; this contract hashes its declaration, not a recursive
snapshot of arbitrary executable dependencies.

Persist schedule identity separately from content identity: normalized kind and
cron expression/timezone, interval, delay, or timestamp. `missed-run` is execution
policy, not a new trigger identity. Resolve `in` once,
when first activating the schedule, not while parsing or during Doctor. Disabled
new jobs have no activation anchor. A prompt/model/timeout edit, reinstall, native
UI drift repair, or removal/reintroduction retains the existing generation and
one-shot consumption. Only an explicit manifest schedule change creates a new
generation; toggling `enabled` does not rearm a consumed one-shot. A delay changed
back to an earlier value is another intentional schedule change. To repeat an
unchanged consumed job, use an explicit manual run or a new ID.

Admission consumes a one-shot occurrence even if it fails, times out, or finishes
with an unknown outcome. Native durable admission/history must let recovery prove
whether execution could have started; absence of a successful result is not proof
that a second attempt is safe. Manual execution must preserve the pending scheduled
occurrence and must not revive an already consumed one.

| Observed change                                          | Required reconciliation                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Unchanged desired and native content                     | No native write; preserve timestamps, failure state, and completion.                                                |
| Payload/reference content changed                        | Update owned settings; retain schedule generation and consumed state.                                               |
| Native UI edit to a declared setting                     | Doctor reports drift; explicit sync restores desired settings using observed revision checks.                       |
| Removed ID / removed runtime applicability               | Disable the retained owned job; preserve mapping and history. Reintroduction reuses it.                             |
| Native job missing or ownership ambiguous                | Block and request recovery; do not invent completion state or touch a similarly named job.                          |
| Completed one-shot with desired `enabled: true`          | Keep consumed and non-runnable; native disabled state is not enablement drift.                                      |
| Native safety auto-disable                               | Report blocked; unchanged sync must not erase failure counters or re-enable it. Require explicit operator recovery. |
| Native write succeeded but ledger acknowledgement failed | Recover by stable ownership/idempotency key and readback; do not issue another blind create.                        |

Validate the complete applicable projection before writes. Serialize sync per
ownership scope, journal intent before mutation, and acknowledge only verified
readback. Recheck binding, effective content, and native revision at each mutation;
stop on concurrent change. Unsupported readback, idempotent creation, or conditional
update is a support gap, not permission to edit a private scheduler database.
Partial failures report what was applied and what remains; retries of reconciliation
must not execute jobs. Disable prevents new admissions; it is not a promise to undo
effects from an already running occurrence. History retention remains bounded by
native retention policy; this contract does not delete history during sync.

### Execution Contract

Each OpenClaw occurrence needs fresh trusted agent/workspace binding and current
authorization before invocation-scoped credentials are resolved. Never persist or
reuse an install turn's capability token. Reusing setup's process machinery does
not confer that authority. Codex uses the ambient profile and native permissions.

Keep the proposed 30-minute default and a 1–3600-second manifest bound. OpenClaw's
command/agent-turn timeout path accepts 1800 seconds; that is not its native
default. Its code-mode `script` payload has a separate 900-second cap and is not
an equivalent shell-command adapter. Codex scheduled timeout support is unproven.
Timeout means cancellation plus bounded process-tree cleanup, with the timeout
recorded even if cleanup fails; delivery must not cause payload execution to repeat.

There are no automatic retries of failed, timed-out, or unknown admitted
occurrences. Future regular occurrences and explicit operator runs are distinct.
Keep execution (`succeeded`, `failed`, `skipped`, `unknown`) separate from delivery
(`not-requested`, `delivered`, `suppressed`, `failed`, `unknown`); delivery failure
cannot convert successful execution into an execution error or rearm a one-shot.
`overlap: allow` concerns the same job, not a global concurrent-jobs limit. An
existing conversation may serialize turns; reject incompatible target/overlap
combinations rather than silently queuing independent occurrences.

### Automation Support Gates

Evidence inspected on 2026-09-29: the installed OpenClaw `2026.9.6` and Codex CLI
`0.154.0` packages match [package.json](./package.json) and [bun.lock](./bun.lock).
The desktop app is a separate, unpinned product; see [Codex evidence](./CODEX.md#automation-research).
This is package/source and protocol inspection, not live scheduler acceptance.

| Operation / requirement                     | OpenClaw 2026.9.6 evidence                                                                                                                                          | Agent System conclusion                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create/read/update/disable/list/run/history | Native `cron.add`, `cron.get`, `cron.update` (`enabled: false`), `cron.list`, `cron.run`, `cron.runs`; operator CLI uses `openclaw automations`, with `cron` alias. | Operator interfaces exist; no permitted external-plugin reconciliation path established.                                                             |
| Plugin API                                  | `api.runtime.gateway.request` rejects arbitrary external plugins. `plugin-sdk/cron-store-runtime` exports store load/save helpers.                                  | Neither is an admissible integration: do not bypass the Gateway restriction with store writes or spawned Gateway CLI commands.                       |
| Zero-model commands                         | `runCronCommandJob` calls `runCommandWithTimeout` directly; `command` payloads are operator-admin jobs.                                                             | Native zero-model execution exists. It does not supply Agent System binding, policy-before-credentials, or invocation-scoped managed-tool authority. |
| Prompt context                              | Explicit `isolated` creates a fresh transcript; `current` / `session:<id>` have different persistence semantics.                                                    | Independent runs have a candidate mapping; exact existing-thread targeting and tool authority still need installed proof.                            |
| Ownership                                   | `cron.add` reconciles `declarationKey`; native jobs expose `configRevision`; `deleteAfterRun: false` retains successful one-shots.                                  | Useful native primitives, conditional on supported access and full partial-failure/consumption proof.                                                |
| Overlap                                     | `isJobDue` excludes active jobs; manual admission returns `already-running`.                                                                                        | `allow` is unsupported. Global `maxConcurrentRuns` does not fix it.                                                                                  |
| Retry / recovery                            | Recurring failure backoff is 30s, 1m, 5m, 15m, 60m; startup can recover interrupted one-shots.                                                                      | No per-job switch proving the contract's no-replay guarantee was found. Treat as unsupported pending an upstream contract or explicit scope change.  |
| Schedule                                    | Native `at`, `every`, and 5/6-field cron; host-zone default and top-of-hour staggering; runtime-owned catch-up.                                                     | Specify UTC and zero staggering where possible. Desired DST and missed-run policies are not proven configurable; do not claim parity.                |
| Failure reporting                           | Native history distinguishes payload `status` from `completionStatus` and delivery status.                                                                          | Preserve those distinctions; verify mapping through the eventual supported adapter.                                                                  |

Reproduction anchors inside the pinned OpenClaw package (inspection only):

- `docs/plugins/sdk-runtime/gateway-and-nodes.md`, `api.runtime.gateway`: external-plugin restriction.
- `docs/automation/cron-jobs/{payloads,schedules,managing-jobs,how-it-works}.md`: native CLI, authorization, targeting, delivery, and recovery contracts.
- `dist/cron-DcDJigA2.mjs`, `cronHandlers`: native request handlers.
- `dist/server-cron-Dd6AX5Mc.mjs`, `runCronCommandJob`: direct process execution.
- `dist/service-C-O17TZr.mjs`, `add`, `resolveCronJobTimeoutMs`, and `already-running` admission: reconciliation, timeouts, and overlap.
- `dist/jobs-scheduling-BuJ7Yxlw.mjs`, `isJobDue` and `DEFAULT_ERROR_BACKOFF_SCHEDULE_MS`: active-job exclusion and failure backoff.
- `dist/runtime-api-CkahAQr_.d.ts`, `CronJobSchema`: declaration key, revision, schedule, payload, and retained-job fields.

**Recommendation:** preserve the agreed product contract and block adapter delivery
on these gaps. #195 needs an upstream-supported external-plugin scheduling and
authority seam plus compatible execution semantics. #196 needs a supported native
desktop reconciliation interface and scheduled command payload; an immediate
command API is insufficient. A narrower feature requires an explicit change to
#192, not a quiet fallback inside an adapter. No new scheduler, private-store
writer, model-driven command wrapper, or cross-runtime duplicate suppression is
part of this contract. #194 can implement deterministic normalization against this
proposal after contract review, but cannot represent blocked runtimes as supported.

### Acceptance Handoff

The implementation issues must turn these cases into focused tests with injected
runtime boundaries and fixed clocks; they are not passing implementation tests today.

| Owner     | Required cases                                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #194      | Short/long equivalence; YAML-relative prompt paths; containment and invalid references; duplicate IDs; unknown/mixed payload keys; prompt changes versus formatting-only changes; rejected `1h`, `tomorrow`, offset-less timestamps, six-field cron, and impossible dates. |
| #194      | UTC/offset equivalence; `every` versus `in`; cron OR semantics; DST spring gap and fall repetition; fixed elapsed-day intervals; safe-integer overflow; default and override normalization.                                                                                |
| #195/#196 | Create/readback; unchanged no-op; native drift; removal/reintroduction; unmanaged-job preservation; lost ledger/job; concurrent edit; create-success/ledger-failure recovery; completed and failed/unknown one-shot preservation.                                          |
| #195/#196 | Effective-content changes retain anchors; explicit schedule changes rearm; initially disabled delay anchors only on activation; skip/coalesced catch-up; auto-disable recovery; timeout cleanup; same-job overlap; no scheduler replay; distinct delivery failures.        |
| #195/#196 | Zero model requests for command jobs; trusted workspace/agent and current authorization; policy before credential resolution; no bulk credential environment; unavailable unattended permission is actionable.                                                             |
| #197      | GitHub Actions-only OpenClaw installed acceptance and a verified Codex path; demonstrate supported mappings and report remaining parent blockers without declaring parity.                                                                                                 |

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
unrelated actions. [Credential storage](./CLI.md#credential-storage)
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

> [!NOTE]
> Existing baseline order wins; stale paths can accumulate. Doctor reports caller
> directories that Install would append, but extra, reordered, or nonexistent
> baseline entries alone are not drift. PATH health does not prove executable availability.

Start a new Codex session after PATH changes; existing sessions do not hot-reload
the workspace configuration. Agent System disables login-shell
execution and sets the deterministic PATH without otherwise changing Codex's
inherited-environment policy. Remote, sandboxed, ACP, MCP, and third-party
surfaces retain their own path and mount contracts.
