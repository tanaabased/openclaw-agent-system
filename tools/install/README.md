# Agent System Install Tool

<p align="center">
  <img src="../../skills/install/assets/icon-large.svg" alt="Agent System Install" width="180" />
</p>

Install applies the active agent's configuration and setup after native chat
approval, using the same service as the operator CLI. A verified activated owned
prompt automation uses the same tool without recurring approval; see
[automation authorization](../../MANIFEST.md#openclaw-execution-and-ownership).

Approval also covers provisioning or enabling the release-pinned shared Codex
prerequisite in this OpenClaw profile. If an existing shared version conflicts, an
operator must resolve it explicitly; see
[Install behavior](../../CLI.md#openclaw-agent-system-install).

<a id="configuration"></a>

## Requirements

Use a registered OpenClaw workspace with a valid [manifest](../../MANIFEST.md)
and a chat surface supporting [native approval](../../CLI.md#chat-approval).
If the tool is unavailable because its grant is missing, run Install once from an operator terminal. There is no separate
tool configuration; callers cannot select another agent or workspace.

Use the [Install skill](../../skills/install/SKILL.md) to select the runtime,
including standalone Codex. To update OpenClaw automations, run
[Install from an operator terminal](../../CLI.md#openclaw-agent-system-install) with
the Gateway running. The chat tool reports `automation-requires-operator-sync`
when this step is needed.

## `agent_system_install`

For interactive calls, request approval, then apply the active workspace's configuration and setup. See
[chat approval](../../CLI.md#chat-approval) for consent lifetime, cancellation, and
supported chat surfaces.

### Parameters

| Parameter               | Type    | Required | Default      | Description                                                                                          |
| ----------------------- | ------- | -------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `manualSessionDispatch` | boolean | no       | `false`      | Explicitly enroll existing session access for manual issue launch without enabling intake.           |
| `rebuildCodexPath`      | boolean | no       | `false`      | Replace the saved Codex PATH baseline with the invoking environment.                                 |
| `skipSetup`             | boolean | no       | `false`      | Skip every setup check and apply; reconcile other components.                                        |
| `skipSetupAgent`        | boolean | no       | `false`      | Skip agent setup checks and applies; reconcile other components.                                     |
| `skipSetupHost`         | boolean | no       | `false`      | Skip host setup checks and applies; reconcile other components.                                      |
| `timeoutMs`             | integer | no       | host default | OpenClaw-hosted Codex tool-call budget, from `1` through `600000` ms. Pass `600000` for ten minutes. |

### Usage

Install the declared configuration and applicable setup:

```json
{ "timeoutMs": 600000 }
```

Enroll session access for manual issue launch, with chat approval:

```json
{ "manualSessionDispatch": true, "timeoutMs": 600000 }
```

This reuses existing enrollment and its disclosed grants; it enables no schedule.

Install other components while skipping setup:

```json
{ "skipSetup": true, "timeoutMs": 600000 }
```

`skipSetup` skips both setup phases; the phase-specific flags can be combined.
Install still applies other components and checks their requirements. The approval
prompt shows the setup scope, session enrollment, and any PATH rebuild.

`timeoutMs` sets the hosted Codex call budget, not the
[approval window](../../CLI.md#chat-approval) or [setup timeout](../../MANIFEST.md#setup).
Omission retains the host default (90 seconds in OpenClaw-hosted Codex).

Results include installation outcomes and warnings. Cancellation stops subsequent
steps and cancellable setup commands; completed external changes remain in place.

See [Install behavior](../../CLI.md#openclaw-agent-system-install) and
[setup retry rules](../../MANIFEST.md#checks-installation-and-retries) for the
shared lifecycle contract. Native calls do not accept CLI flags such as `--yes`.
