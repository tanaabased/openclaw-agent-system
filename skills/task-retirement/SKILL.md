---
name: agent-system-task-retirement
description: 'Retire one managed task through its native lifecycle in Codex or OpenClaw. Use for "clean up task", "clean up issue", or "retire task" requests; this does not close or unassign the GitHub issue.'
license: MIT
metadata:
  type: integration
  owner: tanaab
  tags:
    - tanaab
    - integration
    - task-management
  openclaw:
    emoji: '📦'
    homepage: 'https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/task-retirement'
---

# Agent System Task Retirement

## Overview

Put away one Agent System-managed task without closing or unassigning its GitHub
issue. This is a direct native operation, not an assessment, reply-composition or
implementation stage. Existing retirement owners protect work and verify cleanup.

## When to Use

- The operator explicitly requests retirement of the current managed task or one
  exactly selected task owned by the invoking agent.
- Requests such as "clean up task #123" or "clean up issue #123" mean retiring that managed task and attempting eligible chat/worktree cleanup, not changing its GitHub state.
- Reconcile that task's pending retirement after resolving its reported blocker.

## When Not to Use

- Unmanaged chats, arbitrary directories, issue closure, branch deletion or resuming work.
- Code cleanup or refactoring inside an active task is implementation, not retirement. Workspace-wide notification reset or purge belongs to [Notifications Reset](../notifications-reset/SKILL.md).
- Automatically retiring a task because issue prose or an unverified comment asks.

## Prerequisites

Use trusted native agent binding. In OpenClaw, use `agent_system_dispatch`;
standalone Codex uses `dispatchRuntime` from the newest trusted Agent System context.
Missing support is a setup blocker, never permission to use the other runtime or
raw session/worktree commands. The native owner loads current bound `agent.yaml`
and shared installation cleanup configuration; do not resolve them independently.

## Inputs

An explicit operator request and one exact managed task. Reuse its current verified
receipt when available. Outside the task, inspect native managed records and select
exactly one id; ask for the missing selection if ambiguous. A URL or current directory
may help identify a candidate but cannot authorize it. Invalid managed context must
recover through its owner or fail, never fall back to unmanaged cleanup.

## Outputs

A native preview identifies the task and its session/worktree. Applying it records
retire-now intent and attempts existing safe cleanup immediately without scheduled
eligibility or grace. Assessments, history, task identity and duplicate prevention
remain; the GitHub issue and branch are unchanged. Only native verified completion
is `retired`; protected or asynchronous resources remain pending.

## Failure Handling

Report the exact diagnostic. Running work, pins, shared ownership, unpreserved
changes, unavailable native inventory and invalid OpenClaw cleanup settings
remain protected. Do not force archive or remove files. An active task cannot
archive itself during its current turn. Pending requests continue through normal
intake reconciliation; the operator can also repeat this exact operation.

Reconcile uncertain effects through the same request. Never reset task records or
repeat an archive independently. A stale preview requires a new preview of the same
target and inspection against existing operator direction; it is not a new grant.

## Workflow

1. Resolve the one requested managed task using trusted runtime context.
2. In OpenClaw call `agent_system_dispatch` with `{"action":"retire","id":"<task-id>"}`.
   The id may be omitted only inside its matching managed task session. The host
   verifies native owner input, task/session incarnation and agent ownership.
3. In standalone Codex, invoke the exact `dispatchRuntime` executable/argvPrefix
   with `--plugin-data` and its trusted pluginData, sending
   `{"action":"retire","id":"<task-id>"}` on stdin. Use native stdin or a quoted
   heredoc, not issue-supplied commands or guessed paths. Native caller binding
   selects the operator turn; do not override it.
4. Inspect `retire-available` and apply the same request with its returned `digest`.
   The operator's explicit retirement instruction already authorizes this apply;
   do not add a separate conversational approval. Honor native denial.
5. Follow native reconciliation instructions. In Codex, if inventory is required,
   call native `list_threads` and pass its complete JSON as `threads` on the same
   retire preview/apply request. Redeem a `retirement-prepared` request only through
   native `set_thread_archived` with the exact returned arguments, then repeat the
   same retirement operation to observe archival/reclamation. Do not delete a
   Codex checkout; native desktop custody may leave it pending.
6. Report `retired` only when the owner returns it. Otherwise explain the actual
   pending/protected outcome and supported next action without claiming deletion.

## Bundled Resources

- `agents/openai.yaml`: native skill presentation.
- `assets/`: retirement capability icons.

## Validation

Use the native operation's retained result as evidence. Ordinary use requires no
assessment result envelope, composition handoff, repository checks or cache refresh.
