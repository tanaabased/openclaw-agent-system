---
name: agent-system-install
description: Install one Agent System workspace through OpenClaw or reconcile standalone Codex setup and repository automations.
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

Install the active `agent.yaml` through the owning runtime. OpenClaw reconciles the full Agent System lifecycle after native chat approval. Standalone Codex reconciles applicable setup and plans repository automations for authorized native app writes.

## When to Use

- Inspect installation state before an Agent System install.
- Apply the active manifest through OpenClaw or standalone Codex.
- Report which setup steps were healthy, applied, skipped, or failed.

## When Not to Use

- Do not validate or edit `agent.yaml`; use the manifest workflow that owns those changes.
- Do not use the Codex adapter from an OpenClaw-hosted turn or call OpenClaw lifecycle commands from standalone Codex.
- Do not use standalone Codex to reconcile OpenClaw-owned agent registration, models, memory, tool access, path projection, Git, GitHub, notifications, configuration, or managed credentials. Codex-owned issue intake uses native host authorization and the existing automation reconciliation branch.

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

1. Read only the newest trusted Agent System context. Require `binding.status` to be `active`, `agent-system-install` in `binding.context.capabilities`, and both `setupRuntime.argvPrefix` and `setupRuntime.pluginData` for setup. If the binding or manifest is inactive, skip setup; explicitly authorized cleanup of a previously owned intake job may use the Codex automations branch and its trusted runtime prefix.
2. Form the internal command from `setupRuntime.argvPrefix`. Append every argument as a distinct shell-safe argument; do not evaluate shell text or choose a runtime.
3. Append `inspect --plugin-data <pluginData>`, run the command, and summarize its JSON findings. Do not expose declared commands, command output, secrets, or environment values.
4. Apply only when the user has explicitly requested installation. Append `install --plugin-data <pluginData>` to a fresh copy of the trusted prefix and run it under the host's normal Codex command authorization.
5. Stop on the first failed step. Do not retry it through OpenClaw, direct shell execution, another runtime selection, or an edited command.
6. Report outcomes in declaration order: `setup-unchanged` as healthy, `setup-applied` as applied, `setup-not-applicable` as skipped, and an error as failed with its stable code and `stepId` when present.

#### Codex automations

For an explicit automation-only sync, use this sequence without running setup
install. The `sync` route aliases the same deterministic inventory/plan used
below; native writes still require prepare/acknowledge and exact saved readback.
A request to run a job now must report `automation-run-now-unsupported`; do not
create an equivalent manual task unless the user explicitly requests one.

1. Require `automationRuntime` from the newest trusted context. Use its exact `argvPrefix` and `pluginData`; never infer a workspace or substitute the current conversation. If the installed context lacks this route, report that a plugin update and fresh task are required.
2. Discover `automation_update` and call `list_projects`. For explicitly declared thread targets, call `read_thread` for each exact ID. Pass the decoded native result objects as `projects` and `threads` to the internal `plan --plugin-data <pluginData>` command. Deliver one JSON object through standard input, never interpolate prompts into shell arguments. This helper reads saved definitions and profile defaults and computes all desired fields; do not author the diff yourself.
3. An `aligned` plan needs no schedule writes. A `blocked` plan stops schedule writes. Resolve `intake-permission-*` findings through the permission onboarding below before creating or activating the intake schedule. For `automation-thread-model-drift`, ask the operator to apply the requested model and effort through that existing chat’s native controls, then replan. Never claim a transient app-server update persisted, send an unauthorized model turn, or replace the chat to clear drift. A known partial conversation creation may use step 4 for recovery; resolve other conditions first. A headless session returns `requires-native-app-sync`; do not replace native tools with scheduler-file writes or a fabricated CLI. Report the concrete actions and digest, and apply only within the user's installation authorization. A changed scope or additional action requires renewed authorization.
4. When the plan reports `automation-thread-sync-required` or `automation-thread-name-drift`, pass its fresh digest and lookup inputs to `threads-sync --plugin-data <pluginData>` within the authorized installation scope. This reconciles native conversations only, using the ambient Codex app-server; it never writes schedules or runs a model. Report that shared IDs produce separate per-automation Codex histories. New chats receive declared model and effort settings at creation. Replan afterward. A known partial conversation creation may resume through this same route; an ambiguous create without its native ID remains blocked—never clear its journal or blindly create again.
5. Before each schedule action, refresh native project/thread lookups and the plan. Require the remaining actions to match the authorized remainder, then pass its fresh `digest` and lookup objects to `prepare --plugin-data <pluginData>`. The helper journals one action and returns the exact native request. Invoke `automation_update` with that request unchanged. No name-based adoption, deletion, or generated substitute prompt is permitted.
6. Pass the returned native result and prepared digest as `{ "digest": "...", "receipt": <native result> }` to `acknowledge --plugin-data <pluginData>`. The helper verifies saved settings before recording success. Stop on any tool failure, unreadable state, or divergence; retain and report earlier verified actions. Never infer saved settings from a rendered `view` card.
7. If a response was lost after a possible write, call `acknowledge` with only the pending digest. Recovery requires the unique exact pending marker and expected saved definition; unrelated edits or a changed valid manifest do not invalidate that completed effect. Replan before any further native write. If the write definitively failed without changing its target, `cancel` with that digest can clear the pending operation. A pending create also requires no new native IDs, so an unmarked partial create cannot cause a blind duplicate. Older journals retain their whole-scheduler cancellation check. A divergent target remains blocked; never blindly create again or clear the journal by editing files.
8. Repeat until the final plan is `aligned`. Report saved-configuration convergence separately from scheduled execution. Execution and delivery telemetry are unavailable through this adapter. Routing-kind migrations first pause and retain the old schedule, then create the replacement; never skip the pause/readback step. Removed declarations pause owned jobs and retain their mapping; reintroduced IDs reuse them. Existing notification preferences remain native-owned.

Before v2 intake activation, invoke `intakeRuntime` with `permission --plugin-data <pluginData>`.
This read-only check returns the exact scanner `argv`, native rule status, and a digest.
If consent is missing, explain its recurring host access and request native reusable
approval for that exact command using the native execution tool's full-argv prefix
proposal. A one-time approval is insufficient. On a first install, the scan reports
`intake-activation-required` without contacting GitHub. Never write rules yourself,
shorten the prefix to Node or the runtime, or relax sandbox/approval settings.
If native reusable consent is unavailable or denied, leave activation blocked.

Reinspect after approval completes and require `configured: true` before requesting
a restart. If the command runs without a human prompt but consent remains missing,
ask the operator to select native **Ask for approval** for onboarding and retry the
exact scanner proposal; automatic review can allow a run without saving consent.
Never change the chat's permission mode yourself.

After verifying saved consent, ask the operator to restart Codex and explicitly confirm the
reload. Reinspect permission, then pass `{ "digest": "<fresh digest>", "confirmReload": true }`
on stdin to `intakeRuntime permission-acknowledge --plugin-data <pluginData>` only
with that direct confirmation. This records an operator acknowledgment, not native
execution proof. Missing or changed scanner rules, paths, workspace, or profile require
fresh onboarding. Replan after acknowledgment. Verify unattended operation through
a separately authorized real scheduled poll; do not infer it from rule files,
acknowledgments, successful manual scans, or another chat's permissions. Unrelated
command approvals do not invalidate scanner acknowledgment.

For v2 issue intake, include the reserved `github-issue-assignment` job and retained
chat in the authorized plan. Its model and effort come from `models.low`. Use native
sidebar tools to reuse or create `AGENT SYSTEM` and place the exact owned
`ISSUE ASSIGNMENTS` chat there; preserve its workspace and history. Sidebar
placement does not change the binding. Acknowledgment initializes the baseline after native
readback and provider checks; if it fails, retain the pending action and report
that the native job may already be active. After policy revocation, acknowledge
the exact native effect and replan to pause it. This recovery also works with a
missing or invalid manifest; it never authorizes setup or infers ownership by title.

For `automation-thread-host-access-required` or `intake-permission-host-access-required`, report that the native app-server needs approved host access to its Codex state directory and retry the same trusted operation through native approval. Never expose captured stderr or repair this by changing profile permissions.

Use the ambient Codex profile and its permissions. Prompt jobs may explicitly run scripts but remain model-backed. Do not convert command declarations, invent timeout guarantees, change profile permissions, or create managed Codex credentials. See [Codex automations](../../CODEX.md#repository-automations) for supported schedules and recovery diagnostics.

## Checkpoints

- OpenClaw installation has native **Allow once** approval for the complete lifecycle plan.
- Standalone Codex has a live active binding and a fresh digest-bound plan before each native write. Recovery may record an exact prepared effect after a valid manifest change, but cannot authorize another write.
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
- Confirm OpenClaw used native chat approval and standalone Codex used its setup adapter and authorized native automation operations.
- Confirm runtime filtering and ordered stop-on-failure behavior are visible in the result.
