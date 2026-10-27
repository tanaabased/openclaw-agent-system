# Agent System Issue Dispatch Tool

<a id="issue-dispatch"></a>

<p align="center">
  <img src="../../skills/task-launch/assets/icon-large.svg" alt="Agent System Issue Dispatch" width="180" />
</p>

Use the task skills to start, assess, implement, or retire issue work through its native
workflow. For assessment or implementation in the current chat, choose the corresponding
skill below.

## Requirements

Use the active OpenClaw agent and native conversation, or the corresponding trusted
standalone Codex runtime adapter. OpenClaw manual launch uses existing session enrollment;
see [Setup and Recovery](#setup-and-recovery).

## Configuration

Use the [GitHub workflow configuration](../../channels/github/ADVANCED.md#configuration-reference)
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

The same tool supplies operations for the installed workflow:

| Purpose                                      | Actions                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| Continue implementation and deliver its PR   | `handoff`, `implementation-context`, `implementation-result`, `delivery` |
| Coordinate admitted work                     | `check`, `next`, `prepare`, `start`, `assess`, `report`                  |
| Handle verified issue and linked-PR feedback | `feedback`                                                               |
| Inspect and recover existing work            | `inspect`, `reconcile`, `retry`, `present`                               |
| Retain assessment and its summary            | `context`, `result`, `summary`                                           |

These are workflow operations, not an interchangeable command sequence. Use the
saved task context and the owning skill; a receipt, plan, or tool name alone does
not authorize implementation or publication. Exact request variants remain in the
[tool schema](./tool-schema.ts). Shared behavior and operator recovery belong in
the [GitHub workflow guide](../../channels/github/ADVANCED.md).

## Manual Issue Launch

Use `$agent-system-task-launch` with an issue URL, `owner/repo#number`, repository
plus number, or a number with an explicit or independently verified repository context.
The issue may be unassigned or assigned to somebody else. Existing repository access,
agent eligibility, native authorization, and lifecycle checks still apply.

The launcher creates or returns the normal managed issue conversation and checkout.
Configured Plan/Work/Auto, stage skills/guidance and native model profiles apply;
explicit supported choices override the corresponding defaults. It changes no issue
assignment or scheduler. Local recovery records remain, and normal managed assessment
summaries and PRs may be public. Manual launch alone grants no automatic feedback.

### `agent_system_dispatch` — `launch`

Create/reuse operator-initiated managed issue work in OpenClaw. Standalone Codex
uses `dispatchRuntime` from trusted context with `launch context|prepare|reconcile`
before its exact `--plugin-data` argument and JSON on stdin.

#### Parameters

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

#### Usage

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

Follow the returned routing/preparation instructions with the same target, receipt
and current digest. In Codex, project preparation can return a new routing digest
before final native creation. A prepared Codex creation request is executed unchanged
once through native `create_thread`; then reconcile the original launch. OpenClaw
uses the existing enrolled session adapter directly and starts its assessment turn.

An existing destination retains its current stage; revisiting does not rerun setup or a
completed assessment. If creation or a send is incomplete or uncertain, the workflow
checks the original attempt before trying again. If its owner is inactive or unclear,
recover that workflow rather than creating a replacement.

### Setup and Recovery

OpenClaw launch reuses existing session enrollment. A manual-only installation can
request [Install](../install/README.md#agent_system_install) with
`manualSessionDispatch: true` and approve the existing session-access disclosure.
The operator CLI equivalent is `openclaw agent-system install --manual-session-dispatch`.
This explicit setup option does not declare or activate intake. Launch never enrolls
or replaces credentials silently; Doctor remains read-only.

A missing Codex saved project returns the exact prepared folder to register. Keep
that preparation and retry the same launch after registration. Invalid skills,
explicit settings, absent assignment-actor recipients and native denials identify
the correction; none authorize a substitute identity, private API, or new attempt.

Manual origin has no assigner-derived default PR assignee. Explicit named recipients
remain in effect. A configuration explicitly requesting an assignment actor is invalid
when there was no assignment actor; correct that configuration before launch.
