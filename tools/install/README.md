# Agent System Install Tool

<p align="center">
  <img src="../../skills/install/assets/icon-large.svg" alt="Agent System Install" width="180" />
</p>

Install reconciles the active agent's declared configuration and setup, including
dependency installation and workspace configuration. It calls the same service
as the operator CLI after OpenClaw grants one native chat approval.

## Overview

| Interface                                                                     | Purpose                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------ |
| `agent_system_install`                                                        | Native tool for the active OpenClaw agent        |
| [`openclaw agent-system install`](../../CLI.md#openclaw-agent-system-install) | Operator command                                 |
| [Install skill](../../skills/install/SKILL.md)                                | Select the owning runtime and guide installation |

## Requirements

- Agent System installed and enabled in OpenClaw
- A registered agent workspace with a valid manifest
- A chat surface supporting OpenClaw plugin approval

The native OpenClaw harness and OpenClaw-hosted Codex use this tool. Standalone
Codex uses the [setup-only adapter](../../CODEX.md#skills).
If an existing agent lacks the tool grant, run the operator CLI Install once.

## Configuration

There is no separate manifest section for this tool. It uses the active agent's
[manifest](../../MANIFEST.md) and existing OpenClaw tool restrictions. Callers
cannot select another agent, workspace, manifest, or approval policy.

## `agent_system_install`

Request approval, then reconcile the active workspace. See [chat approval](../../CLI.md#chat-approval)
for consent lifetime, cancellation, and supported chat surfaces.

### Parameters

| Parameter          | Type    | Required | Default | Description                                                          |
| ------------------ | ------- | -------- | ------- | -------------------------------------------------------------------- |
| `skipSetup`        | boolean | no       | `false` | Skip every setup check and apply; reconcile other components.        |
| `rebuildCodexPath` | boolean | no       | `false` | Replace the saved Codex PATH baseline with the invoking environment. |

### Usage

Install the declared configuration and applicable setup:

```json
{}
```

Install other components while skipping setup:

```json
{ "skipSetup": true }
```

Replace the saved Codex PATH baseline:

```json
{ "rebuildCodexPath": true }
```

Both optional parameters may be combined. The approval description identifies
setup scope and any requested PATH rebuild before execution.

The tool returns structured installation outcomes and warnings. Installation may
resolve declared credentials, change configuration, and run setup commands.
Cancellation stops subsequent lifecycle steps and cancellable setup commands;
completed external effects are not rolled back. An approved setup script remains
operator-authored code, including the files or external services it reads.

See [Install behavior](../../CLI.md#openclaw-agent-system-install) and
[setup retry rules](../../MANIFEST.md#checks-installation-and-retries) for the
shared lifecycle contract. Native calls do not accept CLI flags such as `--yes`.

## Further Reading

- [Doctor tool](../doctor/README.md): inspect without repairs
- [CLI trust boundary](../../CLI.md#trust-boundary): agent and operator execution
- [Approval validation](../../DEVELOPMENT.md#lifecycle-approval): supported harnesses and installed checks
