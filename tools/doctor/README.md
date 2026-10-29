# Agent System Doctor Tool

<p align="center">
  <img src="../../skills/doctor/assets/icon-large.svg" alt="Agent System Doctor" width="180" />
</p>

Doctor inspects the active agent's configuration and runs declared setup checks without
applying repairs. It uses the same service as the operator CLI and requires native chat
approval through OpenClaw. A verified activated owned prompt automation uses the
same tool without recurring approval; see
[automation authorization](../../MANIFEST.md#openclaw-execution-and-ownership).

<a id="configuration"></a>

## Requirements

Use a registered OpenClaw workspace with a valid [manifest](../../MANIFEST.md)
and a chat surface supporting [native approval](../../CLI.md#chat-approval).
If the tool is unavailable because its grant is missing, run Install once from an operator terminal. There is no separate
tool configuration; callers cannot select another agent or workspace.

Use the [Doctor skill](../../skills/doctor/SKILL.md) to select the runtime,
including standalone Codex. Scheduler inspection requires
[operator CLI Doctor](../../CLI.md#openclaw-agent-system-doctor); the native tool
reports `automation-requires-operator-sync`.

## `agent_system_doctor`

For interactive calls, request approval, then inspect the active workspace. Declared checks require
approval even though Doctor applies no repairs; see [chat approval](../../CLI.md#chat-approval).

### Parameters

| Parameter   | Type    | Required | Default      | Description                                                                                          |
| ----------- | ------- | -------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `timeoutMs` | integer | no       | host default | OpenClaw-hosted Codex tool-call budget, from `1` through `600000` ms. Pass `600000` for ten minutes. |

### Usage

Inspect the active agent and run its applicable setup checks:

```json
{ "timeoutMs": 600000 }
```

Results include status, findings, and suggested fixes. Inspection may resolve
credentials but never repairs prerequisites.

> [!IMPORTANT]
> Doctor runs the setup checks you provide. Write those commands to be read-only;
> Doctor does not prevent a check from changing files or services.

`timeoutMs` sets the hosted Codex call budget, not the
[approval window](../../CLI.md#chat-approval) or [setup timeout](../../MANIFEST.md#setup).
Omission retains the host default (90 seconds in OpenClaw-hosted Codex).

See [Doctor behavior](../../CLI.md#openclaw-agent-system-doctor) for drift and
provider-probe behavior and [setup check results](../../MANIFEST.md#checks-installation-and-retries)
for readiness meanings.
