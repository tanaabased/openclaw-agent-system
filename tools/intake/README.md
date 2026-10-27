# Assignment Intake

`agent_system_intake` inspects or scans GitHub issue assignments for the active
OpenClaw agent. It records discovery and admission evidence; it does not create
task sessions, implement issues, or publish replies. [Issue Dispatch](../dispatch/README.md)
owns the managed task workflow. Start with [GitHub setup](../../channels/github/README.md)
to enable scheduled intake.

## Configuration

Declare [GitHub workflow configuration](../../channels/github/ADVANCED.md#configuration-reference)
and use Install to activate the owning automation. The tool uses trusted agent and
workspace binding; callers cannot select another agent or supply credentials.
Standalone Codex uses its [native intake adapter](../../CODEX.md#github-notification-policy).

## `agent_system_intake`

### Parameters

| Parameter      | Type                          | Required | Default | Description                                                                                                                           |
| -------------- | ----------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `action`       | `inspect`, `check`, or `scan` | yes      | none    | Inspect retained local state, or perform a bounded connected assignment scan.                                                         |
| `policyDigest` | string                        | no       | none    | Optional compatibility field for `check` and `scan`: 64 lowercase hexadecimal characters. It does not override or freeze live policy. |

`inspect` accepts only `action` and reads saved baseline, checkpoint, records, and
blockers without contacting GitHub. Both `check` and `scan` use the persistent
scan path and may update discovery state; `check` is not a dry run. Scans require
installed workflow readiness and matching GitHub identity. Current manifest policy
governs admission on every scan.

### Usage

Inspect saved state without advancing discovery:

```json
{ "action": "inspect" }
```

Run a bounded assignment scan after activation:

```json
{ "action": "scan" }
```

Results distinguish readiness and blockers from admitted assignment records.
Admission does not prove that a task chat exists or that an assessment is complete.
Do not use scanning as a substitute for Install or for dispatch recovery.

For operator commands that inspect or advance the complete workflow, use the
[notification command reference](../../channels/github/ADVANCED.md#cli).
