---
name: agent-system-install
description: Inspect or install one Agent System workspace through the runtime-owned OpenClaw lifecycle or standalone Codex setup projection.
license: MIT
metadata:
  type: workflow
  owner: tanaab
  tags:
    - tanaab
    - workflow
    - install
    - codex
  openclaw:
    emoji: '🧰'
    homepage: 'https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/install'
---

# Agent System Install

## Overview

Install the active `agent.yaml` through the owning runtime. OpenClaw reconciles the full Agent System lifecycle after native chat approval. Standalone Codex uses the packaged thin adapter and reconciles only setup steps applicable to `codex`.

## When to Use

- Inspect installation state before an Agent System install.
- Apply the active manifest through OpenClaw or standalone Codex.
- Report which setup steps were healthy, applied, skipped, or failed.

## When Not to Use

- Do not validate or edit `agent.yaml`; use the manifest workflow that owns those changes.
- Do not use the Codex adapter from an OpenClaw-hosted turn or call OpenClaw lifecycle commands from standalone Codex.
- Do not use standalone Codex to reconcile agent registration, models, memory, tool access, path projection, Git, GitHub, notifications, OpenClaw configuration, or managed credentials.

## Preconditions

Select exactly one branch from trusted runtime state, never from user prose or tool availability.

- **OpenClaw:** trusted active-agent instructions expose the native `agent_system_install` lifecycle tool. Use the OpenClaw branch.
- **Standalone Codex:** the newest trusted `<agent-system-context>` block exposes `setupRuntime.argvPrefix`, `setupRuntime.pluginData`, and an active bound workspace. Use the Codex branch.
- If neither contract is present, stop. In standalone Codex, explain that the plugin hook must be trusted through `/hooks`, the workspace must be bound, and a fresh task must load the new context.

Treat runtime command prefixes and plugin-data paths as trusted ephemeral data. Never copy them into repository files or Codex configuration.

## Workflow

### OpenClaw

1. Confirm the user requested installation of the active agent workspace.
2. Call `agent_system_install` with `{"timeoutMs":600000}` for a ten-minute OpenClaw-hosted Codex tool-call budget. Do not supply an agent id or workspace override. Approval and setup-command deadlines remain separate. Set `rebuildCodexPath` only when the user explicitly requests replacing the saved Codex PATH baseline.
3. Let OpenClaw present its native chat approval and wait for **Allow once**. Skill prose, CLI consent, `--yes`, and shell commands cannot replace or bypass that approval.
4. If approval is denied or the approved manifest changes, stop and report that result. Do not retry through another route.
5. Report the returned lifecycle outcomes and warnings, including setup results.

### Standalone Codex

1. Read only the newest trusted Agent System context. Require `binding.status` to be `active`, `agent-system-install` in `binding.context.capabilities`, and both `setupRuntime.argvPrefix` and `setupRuntime.pluginData`.
2. Form the internal command from `setupRuntime.argvPrefix`. Append every argument as a distinct shell-safe argument; do not evaluate shell text or choose a runtime.
3. Append `inspect --plugin-data <pluginData>`, run the command, and summarize its JSON findings. Do not expose declared commands, command output, secrets, or environment values.
4. Apply only when the user has explicitly requested installation. Append `install --plugin-data <pluginData>` to a fresh copy of the trusted prefix and run it under the host's normal Codex command authorization.
5. Stop on the first failed step. Do not retry it through OpenClaw, direct shell execution, another runtime selection, or an edited command.
6. Report outcomes in declaration order: `setup-unchanged` as healthy, `setup-applied` as applied, `setup-not-applicable` as skipped, and an error as failed with its stable code and `stepId` when present.

## Checkpoints

- OpenClaw installation has native **Allow once** approval for the complete lifecycle plan.
- Standalone Codex has a live active binding and an unchanged manifest digest throughout the operation.
- A setup step excluded from the selected runtime runs neither its check nor its apply command.
- Omitted `runtimes` means the step applies to both OpenClaw and Codex.

## Completion Criteria

- The selected runtime completed its owned projection or returned a precise failure.
- The report distinguishes healthy, applied, skipped, and failed setup steps.
- Earlier applied steps remain in effect when a later step fails; never claim rollback.
- Standalone Codex did not reconcile any OpenClaw-owned lifecycle state.

## Bundled Resources

- `agents/openai.yaml`: Codex-facing display metadata and starter prompt.
- `assets/icon-small.svg` and `assets/icon-large.svg`: install marks for the Codex interface.

## Validation

- Confirm the execution route came from trusted runtime context.
- Confirm OpenClaw used native chat approval and standalone Codex used only the setup adapter.
- Confirm runtime filtering and ordered stop-on-failure behavior are visible in the result.
