# Agent System Issue Dispatch Tool

<a id="issue-dispatch"></a>

<p align="center">
  <img src="../../skills/task-launch/assets/icon-large.svg" alt="Agent System Issue Dispatch" width="180" />
</p>

Use the task skills to start, assess, implement, or retire issue work through its native
workflow. For assessment or implementation in the current chat, choose the corresponding
skill below.

- [Requirements](#requirements)
- [Configuration](#configuration)
- [`agent_system_dispatch`](#agent_system_dispatch)
  - [Parameters](#parameters)
  - [Usage](#usage)

## Requirements

Use the active OpenClaw agent and native conversation, or a trusted standalone
Codex workspace binding. OpenClaw manual launch requires session enrollment through
[Install](../install/README.md#agent_system_install) with `manualSessionDispatch: true`;
this does not enable scheduled intake. Codex may require
[registering the prepared project](../../CODEX.md#issue-assessment).

## Configuration

Use the [GitHub workflow configuration](../../channels/github/CONFIG.md)
for modes, stage skills, guidance, and delivery. [Model profiles](../../MANIFEST.md#models)
select the configured model and effort. There is no separate Dispatch manifest section.

## `agent_system_dispatch`

Start with the skill for the requested operation; its returned context
supplies the current request, required inputs, and recovery instructions.

| Capability                                           | Action                                | Owning instructions                                                                           |
| ---------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Assess an issue in the current checkout              | `assessment`                          | [Task Assessment](../../skills/task-assessment/SKILL.md)                                      |
| Implement an authorized plan in the current checkout | `implementation`                      | [Task Implementation](../../skills/task-implementation/SKILL.md)                              |
| Launch or reuse managed issue work                   | `launch`                              | [Task Launch](../../skills/task-launch/SKILL.md) and [launch reference](#manual-issue-launch) |
| Reply to an exact GitHub destination                 | `reply`                               | [GitHub Reply](../../skills/github-reply/SKILL.md)                                            |
| Retire one managed task                              | `retire`                              | [Task Retirement](../../skills/task-retirement/SKILL.md)                                      |
| Update an issue with verified progress               | `reply` with `purpose: status-update` | [Task Update](../../skills/task-update/SKILL.md)                                              |

The installed workflow also uses this tool internally. Follow the owning skill and
returned task context rather than assembling an action sequence. Exact variants are
in the [tool schema](./tool-schema.ts); shared behavior and recovery are in the
[GitHub workflow guide](../../channels/github/README.md).

<a id="manual-issue-launch"></a>

Use `$agent-system-task-launch` with an issue URL, `owner/repo#number`, repository
plus number, or a number with an explicit or independently verified repository context.
The issue may be unassigned or assigned to somebody else. Existing repository access,
agent eligibility, native authorization, and lifecycle checks still apply.

The launcher creates or reuses the managed issue chat and checkout. It uses the
configured mode, stage skills, guidance, and model profiles;
explicit supported choices override the corresponding defaults. It changes no issue
assignment or scheduler. Local recovery records remain, and normal managed assessment
summaries and PRs may be public. Manual launch alone grants no automatic feedback.
It has no assigner-derived default PR assignee; explicit named recipients still
apply. A recipient setting that requires an assignment actor must be corrected
before manual launch.

### Parameters

These parameters cover `launch`. Use the owning skill and
[tool schema](./tool-schema.ts) for other actions.

| Parameter    | Type   | Required                 | Default                  | Description                                                                                                                  |
| ------------ | ------ | ------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `action`     | string | yes                      | none                     | `launch`.                                                                                                                    |
| `assessment` | object | for final preparation    | none                     | Existing model-routing complexity assessment and reason.                                                                     |
| `digest`     | string | for final preparation    | none                     | Digest from the latest routing-required result.                                                                              |
| `fallback`   | string | no                       | none                     | Existing explicit `default` profile selection when a requested work tier is not configured; never a model-failure fallback.  |
| `id`         | string | after context            | none                     | Retained launch receipt.                                                                                                     |
| `mode`       | string | no                       | current configuration    | `plan`, `work`, or `auto`; omitted mode defaults to Auto when unconfigured.                                                  |
| `operation`  | string | yes                      | none                     | `context`, `prepare`, or `reconcile`.                                                                                        |
| `projects`   | array  | for Codex preparation    | none                     | Native saved-project inventory, independently checked against repository remotes. Can supply unambiguous repository context. |
| `repository` | string | when otherwise ambiguous | none                     | Explicit `owner/repository` for an issue number.                                                                             |
| `routing`    | object | no                       | configured model profile | Supported explicit `model` and/or `effort`, resolved through shared model routing.                                           |
| `stages`     | object | no                       | current configuration    | Assessment/implementation `skill` and/or inline or contained-file `guidance`.                                                |
| `target`     | string | yes                      | none                     | Issue URL or supported issue reference.                                                                                      |
| `title`      | string | for final preparation    | none                     | Concise alphanumeric issue title for native presentation.                                                                    |

### Usage

Begin a manual launch without assigning the issue:

```json
{ "action": "launch", "operation": "context", "target": "owner/repo#3" }
```

Begin with explicit planning mode and a repository-qualified number:

```json
{
  "action": "launch",
  "operation": "context",
  "target": "3",
  "repository": "owner/repo",
  "mode": "plan"
}
```

Follow the returned preparation instructions, then verify that the same launch completed.
Reused chats keep their stage and completed assessment. Recover an incomplete or
uncertain attempt before starting another.
