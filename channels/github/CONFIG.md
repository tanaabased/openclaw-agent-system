# GitHub Workflow Configuration

This guide covers workflow and notification settings in the workspace's `github`
mapping. Start with the [setup guide](./README.md). Account, token, signing keys,
CLI settings, and tool policy share that mapping but belong to the
[GitHub tool configuration reference](../../tools/github/README.md#configuration-reference).
Workflows require a literal `github.username`; standalone Codex uses native host
GitHub authorization without consuming the manifest token or managing OpenClaw credentials.

- [`github`](#github)
- [`github.issue-assignment`](#githubissue-assignment)
- [`github.project-pickup`](#githubproject-pickup)
- [`github.review-request`](#githubreview-request)
- [Common Types](#common-types)
  - [Identity Lists](#identity-lists)
  - [Workflow Customization](#workflow-customization)

<a id="configuration-reference"></a>
<a id="version-3-fields"></a>

## `github`

These fields select repository scope, runtimes, and intake limits. Add
[`issue-assignment`](#githubissue-assignment) to declare assignment-driven work;
omitting it creates no assignment automation.

### `allowed-repository-owners`

| Type                                       | Required | Default |
| ------------------------------------------ | -------- | ------- |
| [Identity list](#identity-lists), nonempty | yes      | none    |

Select the users or organizations whose repositories the workflow may use. These
are repository owners, not the people allowed to assign work. For example,
`['@tanaabased', '@pirog']` includes repositories owned by either account, subject
to the agent's GitHub permissions. It does not grant access to private repositories.

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

## `github.project-pickup`

Declares the policy for one repository and milestone. It requires `issue-assignment`
and a repository within `allowed-repository-owners`; it does not expand GitHub access
or approved assignment and feedback authors.

> [!IMPORTANT]
> Choose one installation and runtime for this coordinator. Inspect its existing
> installation identity using the [instance commands](../../CLI.md#openclaw-agent-system-instance-inspect)
> or [Codex identity actions](../../CODEX.md#workspace-setup), then set `coordinator`
> below. Run Install there and approve the native pickup schedule. Doctor checks its
> saved enrollment and schedule. Missing or mismatched designation cannot activate pickup.

| Field                | Required       | Meaning                                                                                                                                                                                        |
| -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paused`             | no             | Defaults to `false`; pauses new pickup immediately. Run Install to synchronize the saved native job.                                                                                           |
| `coordinator`        | for activation | `{runtime: codex, instance-id: <installation UUID>}` or runtime `openclaw`. Other installations reject activation.                                                                             |
| `schedule`           | yes            | Existing [recurring schedule syntax](../../MANIFEST.md#automations): cron with an optional IANA timezone, or `every`. One-shot schedules are rejected. Native adapter limitations still apply. |
| `window-minutes`     | yes            | Positive integer duration for each pickup window, at least `github.interval-minutes`.                                                                                                          |
| `selection.guidance` | no             | Inline text or `{file: relative/path.md}`, following [guidance rules](#workflow-customization). Selection guidance cannot override eligibility or authority.                                   |
| `projects`           | yes            | Exactly one entry with `repository: owner/name` and `milestone: {number: 10, policy: only}`. The milestone number must be positive. Other policies and multi-project selection are rejected.   |

Install adds one `PROJECT PICKUP` job alongside assignment intake, using the intake
cadence. Each eligible window can select and self-assign at most one actionable,
unassigned issue in the configured milestone. Verified pickup enters the existing
assessment and Work workflow; ordinary assignments keep their configured mode.
Missed windows are not replayed. Accepted issue work may finish after a window or pause.
Codex uses the low model profile; OpenClaw uses its default automation profile.

The pilot retains its original repository, milestone, schedule, timezone and window
anchor. Install rejects changes to those enrolled values; restore them to resume.
Pause and selection guidance can change without reenrollment. Before transferring
pickup, settle pending pickup operations with the original owner, stop its native
job, and verify it is stopped. Then designate the new installation. Existing issue
work stays with its original runtime; do not copy or delete journals to transfer it.
Conflicting workspaces on one installation are rejected. There is no automatic
failover, account-wide concurrency cap, or protection against independently divergent
configuration or copied private installation identities.

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

## `github.review-request`

This optional object is reserved. Declaring it warns and activates no independent
review workflow; it does not block issue-assignment work.

| Field      | Type                                              | Required | Default                                  | Description                                             |
| ---------- | ------------------------------------------------- | -------- | ---------------------------------------- | ------------------------------------------------------- |
| `allowed`  | [Identity list](#identity-lists), users only      | no       | `[]`                                     | Reserved request actors.                                |
| `feedback` | [Workflow customization](#workflow-customization) | no       | `agent-system:agent-system-github-reply` | Reserved reply customization.                           |
| `paused`   | boolean                                           | no       | `false`                                  | Reserved scheduler setting.                             |
| `review`   | [Workflow customization](#workflow-customization) | no       | none                                     | Reserved review customization; no default review skill. |

## Common Types

### Identity Lists

Use a list of GitHub identities for repository owners, assignment actors, or
reviewers. Each entry can be a name, node ID, or pinned object:

| Entry type | Format                    | Meaning                                                                |
| ---------- | ------------------------- | ---------------------------------------------------------------------- |
| string     | `'@name'`                 | Resolve a user or organization by name. Quote the leading `@` in YAML. |
| string     | GitHub node ID            | Select an identity by its immutable provider ID.                       |
| object     | Name field plus `node-id` | Require both the name and ID to match.                                 |

Object entries use these fields. Exactly one name field and `node-id` are required;
names omit `@`. The four name fields are aliases, not different permission types.

| Field     | Type   | Required       | Default | Description                                          |
| --------- | ------ | -------------- | ------- | ---------------------------------------------------- |
| `login`   | string | one name field | none    | GitHub user or organization login.                   |
| `name`    | string | one name field | none    | Alias for `login`.                                   |
| `node-id` | string | yes            | none    | Immutable GitHub node ID, not a numeric database ID. |
| `org`     | string | one name field | none    | Alias for `login`.                                   |
| `owner`   | string | one name field | none    | Alias for `login`.                                   |

Use names for a compact list, or block syntax when it is easier to read. These
examples belong under `github`:

```yaml
allowed-repository-owners: ['@tanaabased', '@pirog']
issue-assignment:
  allowed:
    - '@pirog'
```

Use node IDs directly when you already have them. The IDs in these examples are
placeholders; replace them with the identities' actual GitHub node IDs:

```yaml
allowed-repository-owners:
  - O_kgDOExample
issue-assignment:
  allowed:
    - U_kgDOExample
```

Pin both name and ID with an object. String and object entries can share a list:

```yaml
allowed-repository-owners:
  - org: tanaabased
    node-id: O_kgDOExample
  - '@pirog'
issue-assignment:
  allowed:
    - login: pirog
      node-id: U_kgDOExample
```

Repository owners may be users or organizations; actors and reviewers must be
users. Duplicate identities produce one effective grant or recipient. Bare names,
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
