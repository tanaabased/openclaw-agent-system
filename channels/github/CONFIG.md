# GitHub Workflow Configuration

This guide covers workflow and notification settings in the workspace's `github`
mapping. Start with the [setup guide](./README.md). Account, token, signing keys,
CLI settings, and tool policy share that mapping but belong to the
[GitHub tool configuration reference](../../tools/github/README.md#configuration-reference).
Workflows require a literal `github.username`; standalone Codex uses native host
GitHub authorization without consuming the manifest token or managing OpenClaw credentials.

- [`github`](#github)
- [`github.issue-assignment`](#githubissue-assignment)
- [`github.issue-pickup`](#githubissue-pickup)
- [Common Types](#common-types)
  - [Identity Lists](#identity-lists)
  - [Workflow Customization](#workflow-customization)

<a id="configuration-reference"></a>
<a id="version-3-fields"></a>

## `github`

These fields select repository scope, runtimes, and intake limits. Add
[`issue-assignment`](#githubissue-assignment) to declare assignment-driven work;
omitting it creates no assignment automation.

### `routing`

Use an ordered list of repository name patterns to select new automated work in
Codex and OpenClaw. The first matching rule wins: a positive pattern permits local
work by default, and a leading `!` excludes it. Use a single-entry mapping to
choose `local`, `swarm`, an installation UUID, or a nonempty list of unique UUIDs.
No match, including `routing: []`, admits no new work.

Use a full rule to name a match or limit it to specific workflows. The rule
matches when the repository matches `match` and the current workflow appears in
`workflows`. Omit `workflows` to apply the rule across workflows. Put exceptions
before broader rules and put an explicit `*/*` last if you want a fallback.

| Field       | Values                                                                       | Required |
| ----------- | ---------------------------------------------------------------------------- | -------- |
| `id`        | Unique name without whitespace. Matched-rule diagnostics include this name.  | no       |
| `match`     | Repository pattern without a leading `!`.                                    | yes      |
| `workflows` | Use `issue-assignment` or `issue-pickup` for scheduled work.                 | no       |
| `target`    | `local`, `deny`, `swarm`, `{instance: UUID}`, or `{instances: [UUID, ...]}`. | yes      |

```yaml
routing:
  - '!tanaabased/archive-*'
  - id: assignment-exception
    match: 'tanaabased/openclaw-agent-system'
    workflows: [issue-assignment]
    target: { instance: '11111111-1111-4111-8111-111111111111' }
  - 'tanaabased/*':
      - '11111111-1111-4111-8111-111111111111'
      - '22222222-2222-4222-8222-222222222222'
  - pirog/me
```

The named rule sends assignments for one repository to a specific installation.
The broader rule sends other matching work to either member of the pool.

Patterns match the entire current `owner/repository` name, case-insensitively.
`*` matches zero or more characters within either segment; it never crosses `/`.
Quote exclusions and patterns beginning with `*`. URLs, `**`, other glob syntax,
multi-entry mappings, exclusion mappings, readable instance names, and mixed
UUID/keyword lists are not supported. UUIDs use their full lowercase form.

Routing follows current names, without pinning owner or repository IDs. A rename
or transfer changes which rules match; a replacement reusing a name can match the
same rule. Scope changes apply to new admissions without Install and preserve
already admitted work and its original owner. Routing does not grant GitHub access,
approve assignment actors, or enable unsupported workflows.

`swarm` coordinates assignment-driven work and issue pickup across participating
installations using claim comments and a second native pass before starting work. Use `swarm`
for that repository on every participant sharing the receiving account. This is a
comment-only proof of concept: incomplete concurrent reads can still produce
overlapping work. Pickup allowances are per installation.

A UUID restricts new claims to that installation; a list restricts them to that
pool. Both use the same claim coordination as `swarm`, including singleton pools.
List order gives no priority and never broadcasts work. An excluded installation
does not try later rules. Use instance inspection to obtain the UUID; renaming an
instance preserves it, while rotating it requires updating routes explicitly.

If the selected installation is offline, paused or full, work waits. Changing a route
does not transfer a task already in progress. Use the original installation to
[recover a stranded task](../../tools/dispatch/README.md#manual-issue-launch).

### `interval-minutes`

| Type                | Required | Default |
| ------------------- | -------- | ------- |
| integer, `1`–`1440` | no       | `5`     |

Sets how often the native assignment automation runs and the cadence used to detect
overdue intake. Run Install after changing it to update the saved schedule.

### `max-concurrent-items`

| Type                  | Required | Default |
| --------------------- | -------- | ------- |
| integer, at least `1` | no       | `3`     |

Limits how much work this intake coordinator can run at once. Other runtimes and
machines have separate limits; this is not an account-wide cap. Excess assignments wait for capacity.
Changes apply to subsequent intake without Install and do not cancel running work.
Each run starts work within the slots available when it begins; quick completions
do not refill that run's allowance. Running work occupies capacity until inactivity
is verified. An issue-specific failure does not stop unrelated eligible work.

### `runtimes`

| Type                                              | Required | Default             |
| ------------------------------------------------- | -------- | ------------------- |
| nonempty unique list of `openclaw` and/or `codex` | no       | `[openclaw, codex]` |

Select which runtime installations reconcile this workflow. Use `[openclaw]` for
an OpenClaw agent, `[codex]` for a bound Codex profile, or both when the workspace
is used by both runtimes. This selects workflow ownership; it does not install or
bind either runtime. Apply setup changes through Install in the selected runtime.

Avoid running duplicate intake for the same agent across installations. Installation
identity does not elect a single owner for an assignment or prevent duplicate starts.
Inspect the original owner of retained work before changing installations; rotating
an installation UUID does not transfer that work. OpenClaw provides
[instance commands](../../CLI.md#openclaw-agent-system-instance-inspect); Codex provides
[native identity actions](../../CODEX.md#workspace-setup).

### `schema-version`

| Type         | Required | Default |
| ------------ | -------- | ------- |
| integer, `3` | no       | `3`     |

Workflow declarations default to `3`, the only supported version. Explicit unsupported
versions are rejected. GitHub CLI-only configuration does not require this field.

<a id="githubproject-pickup"></a>

## `github.issue-pickup`

Declares pickup policy for exact repositories or `owner/*` namespaces, with optional milestone restrictions. It requires `issue-assignment`
and each repository must be included by `routing`.
Pickup uses the existing GitHub access and approved assignment and feedback authors.

> [!IMPORTANT]
> Set placement through `github.routing`. Run Install on each intended participant
> and approve its native pickup schedule. Doctor checks that installation’s saved
> enrollment and schedule; routing alone does not activate pickup.

| Field                           | Required | Meaning                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effort`                        | no       | Optional [automation effort](../../MANIFEST.md#automations). Inherits the selected profile’s effort; a direct model reference inherits `models.default.effort`.                                                                                                                                                      |
| `model`                         | no       | String: `default`, `low`, `medium`, `high`, or a `provider/model` reference. Defaults to `default` in both runtimes. Uses [automation model rules](../../MANIFEST.md#automations).                                                                                                                                   |
| `paused`                        | no       | Defaults to `false`; pauses new pickup immediately. Run Install to synchronize the saved native job.                                                                                                                                                                                                                 |
| `start`                         | no       | Daily local start time; defaults to `"03:00"`. Accepts `"3 am"`, `"3 A.M."`, `"3:00am"` and 24-hour clocks.                                                                                                                                                                                                          |
| `window`                        | no       | Duration, default `"2 hours"`; accepts seconds, minutes, hours, days, short units (`"2h"`) and compounds (`"1 hour 30 minutes"`). Maximum 24 hours. `duration` is an alias.                                                                                                                                          |
| `end`                           | no       | Closing clock time instead of a duration. An earlier or equal time closes the following day. Supplied duration fields must agree.                                                                                                                                                                                    |
| `scans`                         | no       | Defaults to `8`, evenly distributed from the start up to—but excluding—the closing time, rounded down to minute slots. Multiple scans need at least one minute each.                                                                                                                                                 |
| `selection.guidance`            | no       | Inline text or `{file: relative/path.md}`, following [guidance rules](#workflow-customization). Selection guidance cannot override eligibility or authority.                                                                                                                                                         |
| `thread`                        | no       | Persistent coordination chat: a name string or `{name, id}`, using the existing [automation thread convention](../../MANIFEST.md#automations). Defaults to `ISSUE PICKUP`. Run Install to reconcile a changed choice; missing conversations use the native automation recovery flow.                                 |
| `projects`                      | yes      | One or more distinct entries. Each `repository` is an exact `owner/name` or `owner/*` namespace selector. Other glob forms are not supported. Accessible repositories must also pass `routing`; archived, disabled, and issue-disabled repositories are excluded from namespace discovery.                           |
| `projects[].limit`              | no       | Positive integer, default `1`, or `{quantity: N, scope: selection}`. Counts assignments across that entry per window and installation. `scope: repo` gives each discovered repository its own allowance. Omitted `scope` means `selection`.                                                                          |
| `projects[].milestone.ids`      | no       | One milestone identifier or a nonempty list. Use `repo#number` relative to the selected owner, or `owner/repo#number`. A positive numeric identifier is also accepted for an exact repository. Every reference must remain inside the entry's scope.                                                                 |
| `projects[].milestone.number`   | no       | Existing alternative for a positive repository-local number or nonempty list of distinct numbers; available for exact repository entries. At least `ids` or `number` is required when `milestone` is set. Both feed the same union.                                                                                  |
| `projects[].milestone.policy`   | no       | `only` (default) restricts selection to the milestone union; `prefer` considers that union before fallback work in the same entry.                                                                                                                                                                                   |
| `projects[].filters.labels`     | no       | Case-insensitive label patterns, such as `["bug*", "!blocked", "!needs-*"]`. Every positive pattern must match a label; any matching `!` exclusion wins. `*` matches zero or more characters; other metacharacters are literal. Negative-only lists allow other issues; omitted or empty means no label restriction. |
| `projects[].filters.types`      | no       | List of native GitHub issue-type names, such as `["Bug", "Customer Request"]`. Any listed name matches case-insensitively, including organization-defined types. Omitted or empty means no type restriction. Type and label filters must both match; labels never imply a native type.                               |
| `projects[].selection.guidance` | no       | Inline text or `{file: relative/path.md}`, using the same guidance rules. Applies only to repositories selected by that entry, after built-in and global selection guidance; cannot widen eligibility or limits.                                                                                                     |

Exact repository entries replace wildcard defaults for that repository, including filters,
guidance, milestones, and allowance, regardless of list order. An issue is scanned
and charged once. Separately declared entries have independent allowances.

Omit `milestone` to consider all otherwise eligible issues in the entry's scope,
including issues without a milestone. Within `tanaabased/actions`, `1`, `actions#1`,
and `tanaabased/actions#1` identify the same milestone. Namespace entries require
repository-qualified identifiers. Use the `#` delimiter without spaces; `actions1`
is not an identifier. Malformed, closed, or inaccessible references remain errors
and never enable broader selection or fallback.

For example, allow two assignments total across a namespace, with a separate allowance
and milestone restriction for one repository:

```yaml
projects:
  - repository: tanaabased/*
    limit: 2
    milestone:
      ids: [actions#1, canon#2]
      policy: prefer
  - repository: tanaabased/actions
    limit: { quantity: 1, scope: repo }
    milestone: { ids: actions#3 }
```

With `prefer`, pickup considers the listed union before other work within the entry;
preferred work in one entry does not outrank other entries. Failed preferred-work
reads prevent fallback for that entry. The scan card identifies the selected
repository and preferred or fallback choice.

Install adds one `📥 ISSUE PICKUP` job alongside assignment intake. The default native
schedule has eight daily starts: 03:00, 03:15, 03:30, 03:45, 04:00, 04:15, 04:30 and
04:45 local time. Each scan can select and self-assign at most one actionable,
unassigned issue across the configured repositories, subject to ordinary work capacity.
Each entry's `limit` is the maximum number of confirmed assignments per window
on that installation, across the selection or per repository according to `scope`.
Once an allowance is exhausted, later scans skip the affected selection.
Completing an issue leaves the used count in place. The scan card shows how many
assignments used out of each allowance, its scope, eligible issue counts,
and any read warnings. Unreadable or unscanned repositories show an unavailable count.
If one repository cannot be read, readable repositories remain selectable and the card
preserves GitHub's diagnostic. Correct access or configuration for the next scan.
Unreadable repository-specific guidance excludes that repository; unreadable global
guidance stops selection. Full guidance appears only in debug output.

Verified pickup enters the existing
assessment and Work workflow; ordinary assignments keep their configured mode.
Missed windows are not replayed. Accepted issue work may finish after a window or pause.
Both runtimes use `models.default` for issue pickup unless `model` overrides it.
Explicit `effort` wins over inherited effort. These settings select the pickup
coordinator, not the models that assess or implement individual issues. Existing
[standalone Codex limitations](../../MANIFEST.md#automations) still apply.

Label and issue-type filters apply together in both runtimes. An issue needs a native
GitHub type to match a type filter. If no issue qualifies, pickup skips the scan.
The scan card shows read errors separately from empty results.

Repository, milestone, limit, filter, guidance, and route edits apply on the next run.
Assignments already counted in the window still count. Run Install after changing
the schedule, chat, or model. Existing issue work stays with its original runtime.

## `github.issue-assignment`

Declares assignment intake and the workflow it starts. This object is optional;
when present, even `{}` tells Install to set up the workflow. Add approved actors to
`allowed` before assignments can start.

### `allowed`

| Type                                         | Required | Default |
| -------------------------------------------- | -------- | ------- |
| [Identity list](#identity-lists), users only | no       | `[]`    |

Approve the people who may start work by assigning an issue to the agent. The
assignment actor matters, not the issue author. These users also become approved
feedback authors on tracked issues and their linked PRs. An empty list stops new
assignments from starting but keeps the installed automation. Author changes apply
live. Removing an actor does not cancel work already accepted; further feedback still
requires a currently approved author.

### `assessment`

| Type                                              | Required | Default                                     |
| ------------------------------------------------- | -------- | ------------------------------------------- |
| [Workflow customization](#workflow-customization) | no       | `agent-system:agent-system-task-assessment` |

Customize how the agent investigates an issue and produces its assessment or plan.
All three modes use assessment. Guidance can set planning priorities; changing the
skill does not change which mode may proceed to implementation.

### `effort` and `model`

| Field    | Type or supported values                                         | Required | Default                                                                          |
| -------- | ---------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `effort` | [Automation effort](../../MANIFEST.md#automations)               | no       | Selected profile’s effort; `models.default.effort` for a direct model reference. |
| `model`  | String: `default`, `low`, `medium`, `high`, or `provider/model`. | no       | `low` in standalone Codex; `default` in OpenClaw.                                |

Choose the assignment coordinator’s model independently of issue assessment and
implementation routing. Explicit settings win; omitted fields keep the defaults
above. An effort-only setting keeps the runtime’s default model profile.
Run Install to apply changes to the existing native job and chat. Profile changes
also need Install. Selection follows the shared [automation model rules](../../MANIFEST.md#automations),
including standalone Codex provider and effort limits.

### `feedback`

| Type                                              | Required | Default                                  |
| ------------------------------------------------- | -------- | ---------------------------------------- |
| [Workflow customization](#workflow-customization) | no       | `agent-system:agent-system-github-reply` |

Customize public replies to approved GitHub feedback. Authors come from `allowed`
and `reviewers`; this object does not replace that set or provide a feedback-off
switch. Omission or `{}` keeps the default reply skill and the same approved authors.
See [Chatting](./README.md#chatting) for comment examples and reply behavior.
Author and instruction changes apply live. Feedback observed while nobody is
approved does not become a backlog when authors are added again.

### `implementation`

| Type                                              | Required | Default                                         |
| ------------------------------------------------- | -------- | ----------------------------------------------- |
| [Workflow customization](#workflow-customization) | no       | `agent-system:agent-system-task-implementation` |

Customize how the agent carries out an authorized plan. The workflow still owns
push, PR delivery, and recovery; a replacement implementation skill does not grant
additional publication or repository permissions.

### `mode`

| Type                      | Required | Default |
| ------------------------- | -------- | ------- |
| `plan`, `work`, or `auto` | no       | `auto`  |

- **Plan** assesses the issue and waits for direction before implementation.
- **Work** continues an actionable plan through implementation and PR delivery.
- **Auto** chooses Plan or Work with a recorded decision.

Mode changes apply live to the first implementation transition. They do not return
already-started implementation to planning or cancel running turns. No mode grants
merge or deployment permission. You can authorize implementation from Plan mode by asking in the issue chat or
through verified GitHub feedback from an approved author.
Clarification pauses work until answered; it does not require a new workflow.

### `paused`

| Type    | Required | Default |
| ------- | -------- | ------- |
| boolean | no       | `false` |

Set `true` and run Install to stop future scheduled occurrences; set `false` and
run Install to resume the same automation and chat. Accepted runs and running issue
turns may finish. Pause preserves retained work and feedback authority. Install
follows this value and can reverse a pause made only in the native UI.

### `reviewers`

| Type                                         | Required | Default |
| -------------------------------------------- | -------- | ------- |
| [Identity list](#identity-lists), users only | no       | `[]`    |

Request reviews from these users when delivering a PR. They also become approved
feedback authors, so choose them as people who may direct the agent's work.
GitHub UI changes and CODEOWNERS requests do not grant that authority.

<a id="pull-request-recipients"></a>

Delivery assigns the original assignment actor to the PR and adds these reviewers
without removing existing assignees or review requests. Completed reviews are not
requested again. [Manual launch](../../tools/dispatch/README.md#manual-issue-launch) has no assignment
actor and therefore no assigner-derived default assignee.

## Common Types

### Identity Lists

Use a list of GitHub user identities for assignment actors and reviewers. Each
entry can be a name, node ID, or pinned object:

| Entry type | Format                    | Meaning                                                |
| ---------- | ------------------------- | ------------------------------------------------------ |
| string     | `'@name'`                 | Resolve a user by name. Quote the leading `@` in YAML. |
| string     | GitHub node ID            | Select an identity by its immutable provider ID.       |
| object     | Name field plus `node-id` | Require both the name and ID to match.                 |

Object entries use these fields. Exactly one name field and `node-id` are required;
names omit `@`. The four name fields are aliases, not different permission types.

| Field     | Type   | Required       | Default | Description                                          |
| --------- | ------ | -------------- | ------- | ---------------------------------------------------- |
| `login`   | string | one name field | none    | GitHub user login.                                   |
| `name`    | string | one name field | none    | Alias for `login`.                                   |
| `node-id` | string | yes            | none    | Immutable GitHub node ID, not a numeric database ID. |
| `org`     | string | one name field | none    | Alias for `login`.                                   |
| `owner`   | string | one name field | none    | Alias for `login`.                                   |

Use names for a compact list, or block syntax when it is easier to read. These
examples belong under `github`:

```yaml
routing: ['tanaabased/*', 'pirog/*']
issue-assignment:
  allowed:
    - '@pirog'
```

Use node IDs directly when you already have them. The IDs in these examples are
placeholders; replace them with the identities' actual GitHub node IDs:

```yaml
routing: ['tanaabased/*']
issue-assignment:
  allowed:
    - U_kgDOExample
```

Pin both name and ID with an object. String and object entries can share a list:

```yaml
routing: ['tanaabased/*', 'pirog/*']
issue-assignment:
  allowed:
    - login: pirog
      node-id: U_kgDOExample
```

Actors and reviewers must be users. Duplicate identities produce one effective
grant or recipient. Bare names,
numeric IDs, incomplete objects, and conflicting pins are rejected.

Validate checks syntax offline. Connected operations verify identities before use.
A resolved `@name` stays pinned to its node ID through renames; reuse of the old
name does not grant another account access. Use a new node ID to select a different
account. For object pins, update the name after a rename so both fields still match.
Failed lookups report errors rather than empty allowlists.

<a id="assessment-selection"></a>
<a id="stage-skills-and-guidance"></a>

### Workflow Customization

Use the same object for `assessment`, `implementation`, and `feedback`. Omission
or `{}` keeps the stage's default skill without extra guidance. The shared
[skill and guidance rules](../../MANIFEST.md#skill-and-guidance-values) cover skill
IDs, file resolution, and size limits.

| Field      | Type                       | Required | Default       | Description                                               |
| ---------- | -------------------------- | -------- | ------------- | --------------------------------------------------------- |
| `guidance` | string or `{file: string}` | no       | none          | Additional instructions for the selected skill.           |
| `skill`    | skill ID                   | no       | stage default | Replacement skill discovered through the calling runtime. |

The following examples belong under `github`. Add guidance while retaining the
default assessment skill:

```yaml
issue-assignment:
  assessment:
    guidance: |
      Challenge unnecessary scope.
      Prefer small, independently reviewable changes.
```

Keep longer instructions in files relative to the bound agent workspace:

```yaml
issue-assignment:
  implementation:
    guidance:
      file: guidance/implementation.md
  feedback:
    guidance:
      file: guidance/github-replies.md
```

Select a skill available in the calling runtime, optionally with additional guidance.
Replace the example skill ID with your installed skill:

```yaml
issue-assignment:
  assessment:
    skill: company:issue-assessment
    guidance: Focus on the smallest useful change.
```

A custom assessment skill may return ordinary analysis without Agent System
commands or required headings. Invalid selections block that stage; correct them
and refresh context in the same chat.

<a id="implementation-and-review-selection"></a>

Assessment is shared by Plan, Work, and Auto. Customization does not grant
implementation or publication authority, enable independent review requests, or
define arbitrary stage graphs.
