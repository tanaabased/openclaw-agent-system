# Agent System Doctor Tool

<p align="center">
  <img src="../../skills/doctor/assets/icon-large.svg" alt="Agent System Doctor" width="180" />
</p>

Doctor inspects the active agent's configuration and runs declared setup checks
without applying repairs. It calls the same service as the operator CLI after
OpenClaw grants one native chat approval.

## Overview

| Interface                                                                   | Purpose                                        |
| --------------------------------------------------------------------------- | ---------------------------------------------- |
| `agent_system_doctor`                                                       | Native tool for the active OpenClaw agent      |
| [`openclaw agent-system doctor`](../../CLI.md#openclaw-agent-system-doctor) | Operator command; `status` is an alias         |
| [Doctor skill](../../skills/doctor/SKILL.md)                                | Select the owning runtime and guide inspection |

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

## `agent_system_doctor`

Request approval, then inspect the active workspace. Declared checks require
approval even though Doctor applies no repairs; see [chat approval](../../CLI.md#chat-approval).

### Parameters

No parameters. Pass an empty object; unknown fields are rejected.

### Usage

Inspect the active agent and run its applicable setup checks:

```json
{}
```

The tool returns the aggregate status, findings, and remediation. It may resolve
credentials needed for inspection; it never calls Install or repairs prerequisites.
For setup, it reports unchecked steps as manual and other-runtime steps as skipped.
A check's read-only behavior remains its author's responsibility.

See [Doctor behavior](../../CLI.md#openclaw-agent-system-doctor) for drift and
provider-probe behavior and [setup check results](../../MANIFEST.md#checks-installation-and-retries)
for readiness meanings.

## Further Reading

- [Install tool](../install/README.md): apply declared configuration and setup
- [CLI trust boundary](../../CLI.md#trust-boundary): agent and operator execution
- [Approval validation](../../DEVELOPMENT.md#lifecycle-approval): supported harnesses and installed checks
