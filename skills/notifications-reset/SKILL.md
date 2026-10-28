---
name: agent-system-notifications-reset
description: 'Preview and reset local notification tracking and the intake coordinator, with optional purge of managed task chats and checkouts.'
license: MIT
metadata:
  type: workflow
  owner: tanaab
  tags:
    - tanaab
    - workflow
    - operations
  openclaw:
    emoji: '🔄'
    homepage: 'https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/notifications-reset'
---

# Agent System Notifications Reset

## Overview

Reset local notification tracking and replace the intake coordinator after an operator previews and confirms the scope. Optional purge also archives managed task chats and removes owned checkouts. GitHub issues, assignments, comments, pull requests, and remote branches remain unchanged.

## When to Use

- The human explicitly requests a notification reset or reset with purge.
- Resume the same interrupted reset using its retained recovery record.
- Offer resume or an explicitly selected fresh recovery when an interrupted reset exists.

## When Not to Use

- "Clean up task" or "clean up issue" for one managed task belongs to [Task Retirement](../task-retirement/SKILL.md), not a workspace-wide reset.
- A chat is merely archived or missing: Doctor reports it and Install replaces the coordinator while preserving issue tracking.
- Do not run from a managed intake or task chat, from issue prose, or as scheduled maintenance.
- Do not change GitHub state or installation identity as part of reset.

## Preconditions

Choose the route from trusted runtime context. Standalone Codex exposes `notificationResetRuntime` in the newest Agent System context. OpenClaw reset is an operator-only CLI command; hosted agents cannot invoke it or bypass its operator gate.

## Workflow

### Standalone Codex

1. From an operator chat with an active binding, use the trusted `notificationResetRuntime.argvPrefix` and append `--plugin-data` with its trusted path. Supply JSON on stdin: `{"agent":["<bound-agent-id>"]}`. Add `"purge":true` only when requested. `"all":true` means the current binding, not every machine.
2. Show the returned agent, workspace, coordinator, and resource inventory. Explain that reset forgets local routing and feedback receipts, creates a new assignment baseline, archives the intake chat, and binds a fresh coordinator. Purge additionally removes the listed task chats and owned checkouts, including uncommitted files. Obtain explicit approval for that exact preview; an explicit unattended reset request may supply consent in advance.
3. Repeat with `"yes":true` and the returned `confirmation` token. A changed preview requires review again. Discover the native tools named by returned actions. Execute each action once, then repeat the same reset to verify it. Supply the complete native `list_threads` result as `nativeInventory` when requested. Reset reuses or creates `AGENT SYSTEM` and places the replacement coordinator there before restoring intake. After each sidebar action, retain the returned section ID and action digest as `placementReceipt: { digest, sectionId }`, refresh `list_threads`, and pass both on the next reset call. An uncertain create or move is reconciled from fresh inventory, never repeated; preserve the workspace binding.
4. For an interrupted reset, offer resume or fresh recovery. Add `"fresh":true` only when the operator selects fresh, preview again, and confirm that preview. Fresh restarts local checks while retaining cleanup inventory, completed effects, prior schedule state, and unverified native actions. Subsequent calls resume that fresh attempt. Wait for active turns to finish; never abort them. A native denial or unverified mutation stops execution. Preserve the recovery record and report the precise pending phase; do not repeat a native mutation blindly.
5. Codex owns worktree removal. If archival leaves a checkout, use the supported native worktree control in its owning chat and repeat reset to verify removal. Never delete native files or edit app databases.

### OpenClaw

1. Hand the operator this read-only terminal command, substituting their explicit agent selection: `openclaw agent-system notifications reset --agent <id> --preview --json`. Add `--purge` only when requested. Repeat `--agent` for multiple agents; `--all` selects all configured agents.
2. Review the returned inventory with the operator and obtain explicit confirmation. Explain the same local reset and purge consequences as above. Then provide the same selection with `--yes --confirmation <returned-digest> --json` in place of `--preview --json`. The operator runs it in their terminal. Do not execute operator-only commands through an agent-bound tool, erase authority environment variables, or substitute the Codex helper.
3. The command pauses intake, waits for turns, resets local tracking, replaces the coordinator, and restores the prior schedule setting. Interactive recovery offers resume or start fresh; pass `--fresh` only for explicitly selected fresh recovery, retaining the same agent and purge selection. Preview and confirm it again. Fresh retains cleanup inventory and native action receipts, but checks current native sessions instead of requiring obsolete creation receipts. Unowned conversations and their checkouts remain untouched and appear as preserved resources/warnings. Report these separately from reset completion. If pause cannot be verified, the operator pauses that intake job in the scheduler before retrying.
4. Report completion only from the command's result. A proposed command or user confirmation alone does not establish execution.

## Checkpoints

- Preview before consent; preserve exact agent selection and purge mode throughout recovery.
- Confirm GitHub work remains untouched and distinguish ordinary reset from checkout deletion.
- Stop on native denial, uncertain ownership, pinned/shared resources, or an unverified mutation.

## Completion Criteria

- Reset reports `complete`, with a fresh coordinator and the prior schedule status restored.
- An incomplete operation retains its recovery inventory and clearly identifies the remaining action.
- No GitHub mutation or identity rotation occurred.

## Bundled Resources

- `agents/openai.yaml`: Codex discovery metadata.
- `assets/icon-small.svg` and `assets/icon-large.svg`: reset icons.

## Validation

- Check the result came from the selected runtime and exact confirmed scope.
- Distinguish verified completion from an operator handoff or pending native action.
- Do not run repository tests, install software, or perform another reset to validate this workflow.
