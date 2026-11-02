# Agent System Assignment Intake Tool

<a id="assignment-intake"></a>

<p align="center">
  <img src="./assets/icon-large.svg" alt="Agent System Assignment Intake" width="180" />
</p>

`agent_system_intake` inspects or scans GitHub issue assignments for the active
OpenClaw agent. It saves discovered assignments and whether they qualify for work. It does not create
task chats, implement issues, or publish replies; use [Issue Dispatch](../dispatch/README.md)
for those operations. Start with [GitHub setup](../../channels/github/README.md)
to enable scheduled intake.

- [Requirements](#requirements)
- [Configuration](#configuration)
- [`agent_system_intake`](#agent_system_intake)
  - [Parameters](#parameters)
  - [Usage](#usage)

## Requirements

Use a trusted OpenClaw agent binding. Scans require installed workflow readiness
and matching GitHub identity. Standalone Codex uses its
[native intake adapter](../../CODEX.md#github-notification-policy).

## Configuration

Declare the [GitHub workflow](../../channels/github/README.md) and activate it through
Install. Scans use current manifest policy; callers cannot select another agent or
supply credentials.

## `agent_system_intake`

Inspect saved assignments or scan GitHub for eligible work.

### Parameters

| Parameter      | Type                                    | Required | Default | Description                                                                                                                           |
| -------------- | --------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `action`       | `inspect`, `check`, `scan`, or `pickup` | yes      | none    | Inspect retained state, scan assignments, or select and self-assign one project issue from its verified native pickup job.            |
| `policyDigest` | string                                  | no       | none    | Optional compatibility field for `check` and `scan`: 64 lowercase hexadecimal characters. It does not override or freeze live policy. |

`inspect` accepts only `action` and reads the saved baseline, checkpoint, records, and
blockers without contacting GitHub.

> [!IMPORTANT]
> Both `check` and `scan` contact GitHub and may update saved discovery state.
> `check` is not a dry run.

`pickup` requires the designated installation's active native job; ordinary tool calls
cannot activate it. A `selection-required` result accepts `selection` with the returned
`id`, `digest`, chosen `issueNodeId` (or `null`) and a short `rationale`. It may self-assign
one issue on GitHub. Reconcile an uncertain assignment through the same operation,
never a separate GitHub command. See [project pickup setup](../../channels/github/CONFIG.md#githubproject-pickup).

### Usage

Inspect saved state without advancing discovery:

```json
{ "action": "inspect" }
```

Scan assignments after installing the workflow:

```json
{ "action": "scan" }
```

Results report readiness, blockers, and admitted assignments separately. Admission does
not prove that a task chat exists or that an assessment is complete. Do not use scanning
as a substitute for Install or for dispatch recovery.

For operator commands that inspect or advance the complete workflow, use the
[notification command reference](../../channels/github/CLI.md).
