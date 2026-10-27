# Documentation Design

Use this guide before editing or auditing documentation. It defines where material
belongs, when a change is justified, and how references are presented.

## Structure and Ownership

Keep repository-wide companion guides at the repository root. These locations are ownership
boundaries, not a checklist of files to update; leave aligned documents unchanged.

| Document                                                             | Owns                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/OPTIMIZATION.md`                                            | Repository-only audit guidance and accepted optimization decisions.                                                                                                                                         |
| `AGENTS.md`                                                          | Essential repository constraints and required reading for conditional work.                                                                                                                                 |
| [API.md](./API.md)                                                   | Public planning surface for the future cross-plugin Tool API; explicitly not yet available.                                                                                                                 |
| [CHANGELOG.md](./CHANGELOG.md)                                       | Implemented changes.                                                                                                                                                                                        |
| `channels/<provider>/README.md`                                      | Each channel's common setup, configuration example, verification, and essential limitations. Use a sibling `ADVANCED.md` as the first expansion for complete references and less-common operational detail. |
| [channels/github/ADVANCED.md](./channels/github/ADVANCED.md)         | GitHub workflow fields and defaults, notification commands, shared workflow behavior, and operator recovery.                                                                                                |
| [channels/github/PRESENTATION.md](./channels/github/PRESENTATION.md) | Reusable human-visible notification components and styling; no lifecycle or feature behavior.                                                                                                               |
| [cli/PRESENTATION.md](./cli/PRESENTATION.md)                         | Shared CLI palette, spacing, diagnostic placement, and authoring verification.                                                                                                                              |
| [CLI.md](./CLI.md)                                                   | Complete core command references, a linked index of component commands, and shared execution boundaries.                                                                                                    |
| [CODEX.md](./CODEX.md)                                               | Standalone Codex installation, binding, context, setup, model routing, and development. Keep OpenClaw-hosted Codex behavior with its owning OpenClaw feature.                                               |
| [CONFIG.md](./CONFIG.md)                                             | Operator-owned installation settings and OpenClaw plugin options.                                                                                                                                           |
| [DEVELOPMENT.md](./DEVELOPMENT.md)                                   | OpenClaw source installation, DevGuard, runtime logging, validation, and coding standards.                                                                                                                  |
| `DOCUMENTATION.md`                                                   | Documentation ownership, change gates, and reference formats.                                                                                                                                               |
| [MANIFEST.md](./MANIFEST.md)                                         | Workspace discovery, shared fields and value rules, setup, environment resolution, path projection, and links to component configuration owners.                                                            |
| [README.md](./README.md)                                             | Product positioning, installation, version compatibility, the common manifest workflow, and first verification.                                                                                             |
| `tools/<capability>/README.md`                                       | Each tool's complete configuration, invocation, policy, lifecycle, and security guide.                                                                                                                      |
| [UPGRADING.md](./UPGRADING.md)                                       | Release transitions, migration requirements, backup precautions, and cutover warnings.                                                                                                                      |

Keep root summaries short and link to the owning tool or channel guide. Link shared
manifest rules, such as model routing, instead of reproducing them. Use contextual
links to standalone Codex guidance rather than spreading it across OpenClaw docs.

The README owns the complete shipped skill and tool inventory and a command-family
index. Skills own agent execution instructions; tool guides explain their public
interfaces without duplicating runtime protocol choreography. Component command
options and examples belong in their tool or channel guide, linked from `CLI.md`.

Keep shared skill/guidance value rules and automation declaration/schedule syntax
in `MANIFEST.md`. GitHub workflow fields and its derived assignment automation belong
in the channel guide; Git, GitHub CLI, and Google fields belong in their tool guides.
`CLI.md` owns operator automation commands; `CODEX.md` owns Codex-specific setup,
automation support, and limitations. Link shared workflow behavior to the channel
guide rather than maintaining a second reference in `CODEX.md`.

## Documentation Voice

Use one project voice across the README, companion guides, and tool/channel docs: clear,
warm, direct, and practical. Take Emori's unfamiliar-reader style as the reference:
respect the reader, question inflated claims, and give a useful next step. This house
style takes precedence over an individual agent's conversational voice. It stands on its
own; authors do not need another agent's configuration.

- Lead with what the reader can do or needs to know. Follow with the reason,
  consequence, or next step. Address the reader as “you” when it makes an instruction
  clearer; name the tool or runtime when it performs the action.
- Use familiar words and active verbs. Prefer “Install updates the saved schedule”
  to “schedule reconciliation is performed.” Keep terms such as reconciliation,
  binding, and receipt when the distinction matters, and explain the practical effect.
- Use normal sentence capitalization, exact product and identifier casing, and
  natural contractions. Keep established headings and anchors stable; code comments
  follow the lowercase convention below.
- Be personable without assuming familiarity. Skip teasing, profanity, catchphrases,
  sales language, and performative enthusiasm. Setup, security, failure, and recovery
  guidance should be calm and specific.
- Keep paragraphs focused. Use lists for steps or parallel choices and tables for
  lookup details. Cut repetition rather than making the reader assemble a sentence
  from fragments or a string of slash-separated terms.
- State limits directly and pair failures with the next supported action. Preserve
  every consequential condition, default, warning, and permission boundary. Never
  trade accuracy for a smoother sentence or turn an unverified outcome into success.
- Keep configured state, an accepted request, execution, and verified completion
  distinct. Voice edits do not change commands, schemas, examples, or runtime behavior.
  Leave already-clear passages alone and respect the README marketing gate.

For example:

| Before                                      | House style                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| “Unchanged jobs receive no mutation.”       | “Install leaves unchanged jobs alone.”                                                       |
| “A queued refresh is an admission receipt.” | “A `queued` refresh means the scheduler accepted the request; the run may still be pending.” |

Before handing off a voice edit, read it as someone setting up or recovering the product
for the first time. They should be able to identify the action, its limits, and the next
step without knowing the implementation history.

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

Alphabetize lookup tables by their identifying name or machine ID, ignoring
Markdown formatting. Preserve chronological, precedence, and execution order
where that order carries meaning.

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

| Parameter   | Type    | Required | Default      | Description                                                                                          |
| ----------- | ------- | -------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `timeoutMs` | integer | no       | host default | OpenClaw-hosted Codex tool-call budget, from `1` through `600000` ms. Pass `600000` for ten minutes. |

### Usage

Inspect the active agent and run its applicable setup checks:

```json
{ "timeoutMs": 600000 }
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
[`opCache`](./CONFIG.md#opcache):

````markdown
## `opCache`

Set under `plugins.entries.agent-system.config` in OpenClaw configuration.

| Field        | Type    | Required | Default | Description                                      |
| ------------ | ------- | -------- | ------- | ------------------------------------------------ |
| `maxEntries` | integer | no       | `128`   | Maximum cached entries, from `1` through `1024`. |

```sh
# set the maximum cached entry count.
openclaw config set plugins.entries.agent-system.config.opCache.maxEntries 64 --strict-json
```

The limit bounds entries retained by the configured cache mode.
````

## Before Committing

Before committing, compare the diff to its stated reason and remove incidental
edits. Verify commands and defaults against registration, schemas, and tests;
check local links and fragments, preserve complete reference coverage, and run
formatting. Package changes also require package checks. Report what was verified
and what remains untested; do not add prose or tests solely to demonstrate activity.
