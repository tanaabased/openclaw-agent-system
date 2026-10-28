---
name: agent-system-task-launch
description: 'Start or resume work from a GitHub issue or existing same-repository pull request in Codex or OpenClaw. Use for "work on task", "work on issue", "continue this PR", or "start task" requests that launch managed work, without assigning it or enabling scheduled intake.'
license: MIT
metadata:
  type: workflow
  owner: tanaab
  tags:
    - tanaab
    - workflow
    - task-management
  openclaw:
    emoji: '🚀'
    homepage: 'https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/task-launch'
---

# Agent System Task Launch

## Overview

Start the existing managed task workflow from an explicit operator request instead of a GitHub assignment. Reuse its task chat, contained checkout, assessment, Plan/Work/Auto progression, and normal PR delivery.

## Required Reading

- **Always:** [Launch usage](../../tools/dispatch/README.md#manual-issue-launch) for the request and recovery contract. Read this section before launching; reuse a complete read already in context.

## When to Use

- The operator explicitly asks to start managed work on one accessible open GitHub issue, with or without an assignment.
- The operator supplies an open same-repository PR URL to continue that PR, not to review it independently.
- Requests such as "work on task #123", "work on issue #123", or "pull down issue #123" mean starting its managed workflow when no narrower assessment or implementation request is specified.
- The operator retries partial setup or asks to return to already managed work.

## When Not to Use

- Assessing or planning an issue in this chat: use [Task Assessment](../task-assessment/SKILL.md).
- Implementing an actionable plan in the existing task checkout: use [Task Implementation](../task-implementation/SKILL.md), including "continue working" requests in that active task.
- Cleaning up or retiring a managed task: use [Task Retirement](../task-retirement/SKILL.md). Direct replies and PR reviews also belong to their separate workflows.
- Scheduled discovery or selecting work that the operator has not requested.

## Preconditions

Use the trusted invoking agent and host context. An issue need not be assigned, but the request grants no additional repository access or work eligibility. Never assign the issue or enable intake to make launch succeed.

## Workflow

1. Resolve the requested issue or PR URL, owner/repo#number, repository plus number, or number with verified repository context. Use the current managed target or independently verified project remotes when unambiguous. Ask for missing repository context instead of guessing from a group name or provider prose. PR continuation starts at its verified current head and retains that PR as the update destination; forks, closed PRs and conflicting targets are unsupported.
2. In OpenClaw call agent_system_dispatch with action launch, operation context, and target; include repository only when needed. In standalone Codex use dispatchRuntime from the newest trusted context, followed by launch context before its exact --plugin-data argument, sending JSON on stdin. Never infer executable or credential paths.
3. Supply supported explicit mode, routing model/effort, and assessment/implementation stages only when requested. Omitted fields inherit current agent.yaml defaults independently. Preserve the returned receipt; do not silently replace invalid explicit selections.
   Only an explicit operator request for another task permits `fresh: true`. Keep that choice inside Task Launch; automatic intake never selects it. The original task stays active. In either runtime, include an explicitly selected same-repository `pullRequest` URL to start from its verified fetched head and later update that PR. Otherwise fresh launch does not select another task's PR. Retain the returned `id` for every subsequent preparation/reconciliation; a retry is not another launch.
4. For an existing destination, open or report it and continue its current stage through its owning context when this is that conversation. If dispatch is pending, reconcile the original launch as instructed; do not repeat completed setup or assessment. Invalid, inactive, wrong-target or ambiguous ownership never implicitly authorizes a fresh launch. Use an explicit receipt to choose among intentional additional tasks.
5. For routing-required, inspect the returned current profiles and assess the bounded context. If only the configured default profile exists, select it explicitly with fallback: default; do not invent a tier or use a fallback after an invalid explicit choice. Call launch prepare with the same target/id, digest, assessment and concise title. Codex also needs the native saved-project inventory; project preparation may return another routing-required result with its new digest. Use that response rather than repeating completed preparation.
6. In OpenClaw prepare creates/reconciles the native task session and starts its ordinary assessment turn. For an uncertain result, call launch reconcile with the same target/id. In Codex a prepared result returns the existing native create_thread request: execute it unchanged once, then launch reconcile. Never repeat uncertain creation; reconcile the original attempt without a receipt when its outcome is unknown.
7. Report the verified destination and actual ready/pending/setup state. Missing Codex project registration names the exact folder to register. Missing OpenClaw session enrollment requires an explicitly approved Install with manualSessionDispatch: true (CLI: --manual-session-dispatch), not automatic enrollment or a notification declaration. Keep partial resources and retry their original receipt after setup.
8. The task conversation owns the remaining assessment and configured Plan/Work/Auto journey. Follow its normal result, implementation and PR-delivery handoffs. The launching conversation must not run a parallel implementation or claim that requested native settings were verified when readback is unavailable.

For an explicit replacement request, use `agent_system_dispatch` in OpenClaw or `dispatchRuntime` in standalone Codex with action `recover` from a separate operator chat with the exact predecessor `id` and `pullRequest` URL. Preview, then apply its returned `digest` within the operator's request. Continue the returned successor `launch` request through the ordinary steps above. Recovery preserves old work and assessment, supersedes only that installation's predecessor, and refuses active or uncertain effects. Retrying uses the same successor; it never disables an unreachable computer. An exact accepted local assignment claim follows the successor through its owning claim adapter; external or uncertain claims block replacement. Collaboration needs fresh launch plus PR selection, not replacement.

## Checkpoints

- Native operator input, agent binding and current provider access precede launch effects.
- No fake assignment, assigner, automation occurrence or intake receipt is created.
- Manual launch grants no new background feedback or scheduling. Normal managed summaries and PRs may be public; local recovery records remain.
- Existing PR work updates only its original source branch and PR. Preserve its base, title, body and draft/review state unless separately directed; never create a replacement, force-push, add an issue-closing link or mark a draft ready. Changed heads require fresh verification; divergent collaborator work or a changed prepared checkout stops unsafe delivery.
- Native denials stop the affected operation. Never use private APIs, another identity, or direct session-store edits to recover.

## Completion Criteria

Return the existing or newly verified task chat, or an actionable pending/setup result preserving the original attempt. Launch is not evidence that implementation or PR delivery has finished.

## Bundled Resources

- agents/openai.yaml: host presentation.
- assets/: launch capability icons.

## Validation

Check the requested target, unchanged assignment/scheduling, destination identity, retained attempt and truthful native status. Installed acceptance, skill validation and packaging checks are maintenance work, not routine launch steps.
