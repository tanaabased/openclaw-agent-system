# Documentation Design

Use this guide before editing or auditing documentation. It defines where material
belongs, when a change is justified, and how references are presented.

## Structure and Ownership

Keep companion guides at the repository root. These locations are ownership
boundaries, not a checklist of files to update; leave aligned documents unchanged.

| Document                                                             | Owns                                                                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [README.md](./README.md)                                             | Product positioning, installation, version compatibility, the common manifest workflow, and first verification.                                                                     |
| [MANIFEST.md](./MANIFEST.md)                                         | Workspace manifest discovery, schema, setup, environment resolution, and path projection.                                                                                           |
| [CLI.md](./CLI.md)                                                   | Common commands and execution boundaries.                                                                                                                                           |
| [CONFIG.md](./CONFIG.md)                                             | Operator-owned OpenClaw plugin settings.                                                                                                                                            |
| [CODEX.md](./CODEX.md)                                               | Standalone Codex installation, binding, context, setup, model routing, and development. Keep OpenClaw-hosted Codex behavior with its owning OpenClaw feature.                       |
| `tools/<capability>/README.md`                                       | Each tool's complete configuration, invocation, policy, lifecycle, and security guide.                                                                                              |
| `channels/<provider>/README.md`                                      | Each channel's shipped configuration, routing, lifecycle, security, and limitations. Add a focused companion only when a distinct channel-owned contract overloads the common path. |
| [channels/github/DESIGN.md](./channels/github/DESIGN.md)             | Target notification message flow, lifecycle types, stable machine identifiers, modes, states, context boundaries, and publication behavior.                                         |
| [channels/github/PRESENTATION.md](./channels/github/PRESENTATION.md) | Reusable human-visible notification components and styling; no lifecycle or feature behavior.                                                                                       |
| [DEVELOPMENT.md](./DEVELOPMENT.md)                                   | OpenClaw source installation, DevGuard, runtime logging, validation, and coding standards.                                                                                          |
| [API.md](./API.md)                                                   | Public planning surface for the future cross-plugin Tool API; explicitly not yet available.                                                                                         |
| [CHANGELOG.md](./CHANGELOG.md)                                       | Implemented changes.                                                                                                                                                                |
| `DOCUMENTATION.md`                                                   | Documentation ownership, change gates, and reference formats.                                                                                                                       |
| `AGENTS.md`                                                          | Essential repository constraints and required reading for conditional work.                                                                                                         |
| `.github/OPTIMIZATION.md`                                            | Repository-only audit guidance and accepted optimization decisions.                                                                                                                 |

Keep root summaries short and link to the owning tool or channel guide. Link shared
manifest rules, such as model routing, instead of reproducing them. Use contextual
links to standalone Codex guidance rather than spreading it across OpenClaw docs.

## README Marketing

- Keep the README opening and Overview as stable marketing copy. Change their wording or emphasis only when the user explicitly requests positioning changes or verified product behavior makes a claim false; documentation cleanup, reference splitting, and skill/tool inventory changes are not sufficient reasons. Mechanical link repairs are allowed without rewriting the copy.
- Preserve the opening's three-paragraph message: repository-owned identity, environment, credential configuration, and setup activated by cloning and running `openclaw agent-system install`; GitHub issue-to-pull-request work; then the minimal standalone Codex plugin. Keep repository portability, one-command setup, and assigning agents work through GitHub visible in the Overview.

## Before Editing

Treat existing documentation as a maintained interface. Before editing, identify
one concrete reason: an explicit documentation request, a verified mismatch with
shipped behavior, or a broken reference. Name the affected reader and owning
section in the work summary. If none applies, leave the document alone.

- A feature or bug fix authorizes only the documentation needed to explain its changed contract. It does not authorize a broader rewrite, reorder, new guide, or voice cleanup.
- Find the existing owner before adding prose. Correct or link it; do not restate it elsewhere. Repeat command option rows where needed for a self-contained reference.
- Preserve examples, defaults, supported values, caveats, and the [README marketing gate](#readme-marketing). Moving content does not authorize rewriting it.
- Stop expanding a documentation change when it would require a new ownership decision; propose that change separately. Do not edit the conventions merely to make an unrelated diff conform.

## Command References

Keep explanatory code comments fully lowercase; preserve required casing in
commands, identifiers, environment-variable names, and expected values.

Use this order for every command in root, tool, and channel guides:

1. A heading and navigation link containing the full command in backticks.
2. A short description of the operation.
3. **Options:** a table with `Option or argument`, `Required`, `Default`, and `Description`. Include every applicable Agent System option; use `none` for no default and state when there are no command-specific options. Do not reproduce the underlying Git or GitHub CLI’s complete option inventory.
4. **Usage:** a syntax block followed by runnable shell examples with lowercase comments explaining their purpose.
5. Only necessary output, failure, precedence, or operational details after usage.

Give independently invocable subcommands their own entries. Keep aliases with
the canonical command. Put tool-owned launcher variables in the tool guide and
shared execution boundaries after the root command reference. Native tool guides
use the same order with **Parameters** and JSON examples instead of CLI options
and shell examples; JSON has no comments, so explain examples immediately above them.

### CLI Example

Use this Markdown shape; the complete contract remains in
[`openclaw agent-system validate`](./CLI.md#openclaw-agent-system-validate).

````markdown
## `openclaw agent-system validate`

Validate a workspace manifest without resolving credentials or applying changes.

### Options

| Option or argument | Required | Default             | Description                            |
| ------------------ | -------- | ------------------- | -------------------------------------- |
| `--agent <id>`     | no       | workspace discovery | Select an installed agent's workspace. |
| `--json`           | no       | off                 | Write one structured result to stdout. |

### Usage

```text
openclaw agent-system validate [--agent <id>] [--json]
```

```sh
# validate the current workspace manifest without changing state.
openclaw agent-system validate --json
```

The result identifies the selected workspace and reports validated declarations.
````

### Native Tool Example

The same order applies to [`agent_system_doctor`](./tools/doctor/README.md#agent_system_doctor):

````markdown
## `agent_system_doctor`

Request approval, then inspect the active workspace without applying repairs.

### Parameters

No parameters. Pass an empty object; unknown fields are rejected.

### Usage

Inspect the active agent and run its applicable setup checks:

```json
{}
```

The tool returns status, findings, and remediation.
````

## Configuration References

For each field or coherent object, show its exact key, type or supported values,
required state, and default. Preserve whether omission means no action, inherited
configuration, or a literal default. A scalar may use a one-row metadata table;
an object uses one row per field. Put examples and non-obvious interactions after
the table. Link shared manifest types and resolution rules to their owner.

### Scalar Example

A scalar reference can use the heading as its exact key, as in
[`schema-version`](./MANIFEST.md#schema-version):

```markdown
### `schema-version`

| Type    | Required | Default |
| ------- | -------- | ------- |
| integer | yes      | `1`     |

Identifies the manifest schema. Version `1` is the only accepted value.
```

### Object Example

Name the owning configuration path before listing fields, as in
[`githubNotifications`](./CONFIG.md#githubnotifications):

````markdown
## `githubNotifications`

Set under `plugins.entries.agent-system.config` in OpenClaw configuration.

| Field                  | Type    | Required | Default | Description                                       |
| ---------------------- | ------- | -------- | ------- | ------------------------------------------------- |
| `maxCommentCharacters` | integer | no       | `8000`  | Incoming comment limit, from `1` through `64000`. |

```sh
# reject incoming comments longer than twelve thousand characters.
openclaw config set plugins.entries.agent-system.config.githubNotifications.maxCommentCharacters 12000 --strict-json
```

Overlong comments are rejected without executing truncated prose.
````

## Before Committing

Before committing, compare the diff to its stated reason and remove incidental
edits. Verify commands and defaults against registration, schemas, and tests;
check local links and fragments, preserve complete reference coverage, and run
formatting. Package changes also require package checks. Report what was verified
and what remains untested; do not add prose or tests solely to demonstrate activity.
