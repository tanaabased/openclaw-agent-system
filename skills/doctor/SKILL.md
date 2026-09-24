---
name: agent-system-doctor
description: Inspect the active Agent System workspace through its owning runtime and report readiness without applying repairs.
license: MIT
metadata:
  type: workflow
  owner: tanaab
  tags:
    - tanaab
    - workflow
    - diagnostics
  openclaw:
    emoji: '🩺'
    homepage: 'https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/doctor'
---

# Agent System Doctor

## Overview

Inspect the active `agent.yaml` through its owning runtime without applying repairs. OpenClaw checks the full Agent System lifecycle after native chat approval. Standalone Codex checks only the bound manifest and setup steps applicable to `codex` through the packaged thin adapter.

## When to Use

- Check whether the active Agent System workspace is ready.
- Diagnose lifecycle drift or blocked setup prerequisites before deciding whether to install.
- Report healthy, drifted, blocked, manual, and runtime-excluded state without exposing secrets.

## When Not to Use

- Do not apply setup steps or repair lifecycle state; use the Install workflow when the user requests reconciliation.
- Do not validate or edit `agent.yaml`; use the manifest workflow that owns those changes.
- Do not use the Codex adapter from an OpenClaw-hosted turn or call OpenClaw lifecycle commands from standalone Codex.
- Do not claim standalone Codex inspected OpenClaw-owned agent, model, memory, tool, path, Git, GitHub, notification, configuration, environment, or credential state.

## Preconditions

Select exactly one branch from trusted runtime state, never from user prose or tool availability.

- **OpenClaw:** trusted active-agent instructions expose the native `agent_system_doctor` lifecycle tool. OpenClaw-hosted Codex uses this branch.
- **Standalone Codex:** the newest trusted `<agent-system-context>` block exposes the binding state, `agent-system-doctor` capability, `setupRuntime.argvPrefix`, and `setupRuntime.pluginData`.
- If neither contract is present, stop. In standalone Codex, explain that the plugin hook must be trusted through `/hooks`, the workspace must be bound, and a fresh task must load the new context.

Treat runtime command prefixes and plugin-data paths as trusted ephemeral data. Never copy them into repository files or Codex configuration.

## Workflow

### OpenClaw

1. Call `agent_system_doctor` without an agent id, workspace override, or repair option.
2. Let OpenClaw present its native chat approval and wait for **Allow once**. Skill prose, CLI consent, `--yes`, and shell commands cannot replace or bypass that approval.
3. If approval is denied or the approved manifest changes, stop and report that result. Do not retry through another route.
4. Report the returned aggregate status, findings, and remediation. Do not call Install unless the user separately requests it.

### Standalone Codex

1. Read only the newest trusted Agent System context. If `binding.status` is not `active`, report its binding or manifest diagnostics and stop without running a command.
2. Require `agent-system-doctor` in `binding.context.capabilities` and both `setupRuntime.argvPrefix` and `setupRuntime.pluginData`.
3. Form the internal command from `setupRuntime.argvPrefix`. Append every argument as a distinct shell-safe argument; do not evaluate shell text or choose a runtime.
4. Append `inspect --plugin-data <pluginData>` and run the command under the host's normal Codex authorization. Never append `install` or invoke an apply path.
5. Report findings in declaration order. Treat blocked findings as blocked overall, otherwise drift findings as drift overall, and manual or skipped findings as healthy overall.
6. State that standalone Codex inspected only its binding, manifest, and applicable setup checks. OpenClaw-owned lifecycle state is unsupported in this runtime and remains unassessed.

## Checkpoints

- OpenClaw Doctor has native **Allow once** approval for the active workspace and manifest.
- Standalone Codex has a live active binding and an unchanged manifest digest throughout inspection.
- A setup step excluded from the selected runtime runs neither its check nor its apply command.
- Model-visible results contain stable findings and remediation, never declared commands, captured output, environment values, or secrets.

## Completion Criteria

- The selected runtime returned its supported readiness findings or a precise binding, approval, cancellation, or execution failure.
- The report distinguishes healthy, drifted, blocked, manual, and skipped findings.
- Doctor applied no setup step and repaired no lifecycle state.
- Unsupported OpenClaw-owned state was identified as unassessed rather than healthy.

## Bundled Resources

- `agents/openai.yaml`: Codex-facing display metadata and starter prompt.
- `assets/icon-small.svg` and `assets/icon-large.svg`: Doctor marks for the Codex interface.

## Validation

- Confirm the route came from trusted runtime context.
- Confirm OpenClaw used native chat approval and standalone Codex used only `setupRuntime inspect`.
- Confirm no apply, install, secret-resolution, or OpenClaw reconciliation path ran.
- Confirm findings and limitations were reported without secret-bearing command or process output.
