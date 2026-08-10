---
name: agent-system-git-worktree
description: Agent System guidance for preparing, using, finding, or removing deterministic Git worktrees for an agent task.
license: MIT
metadata:
  type: integration
  owner: tanaab
  tags:
    - tanaab
    - integration
    - git
  openclaw:
    emoji: '🌳'
    homepage: https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/git-worktree
    requires:
      bins:
        - git
    install:
      - id: brew
        kind: brew
        formula: git
        bins:
          - git
        label: Install Git (brew)
---

# Agent System Git Worktree

## Overview

Use `agent_system_git_worktree` to prepare, list, or remove deterministic worktrees when the active manifest enables `git.worktrees`. Use `agent_system_git` with the returned path for all ordinary repository work.

## When to Use

- Prepare or resume isolated work identified by a stable repository id and work id.
- Find existing managed worktrees after a new session or context compaction.
- Remove a managed worktree when the operator asks to clean it up.

## When Not to Use

- Use `$agent-system-git-cli` for status, diff, commits, branches, fetch, pull, or push.
- Do not invent repository ids, stable work identifiers, clone URLs, or base refs when the prompt does not provide enough context.
- Do not use raw `git worktree` mutation or direct filesystem deletion as a substitute for this tool.

## Prerequisites

- The active agent manifest configures `git.worktrees` and has been installed.
- The request supplies a stable repository id and work identifier.
- Preparing a missing managed clone also requires a supported network clone URL.
- `git` is installed; SSH authentication is available when the remote requires it.

## Inputs

Prepare one worktree from an existing ref. When a task id is available, use `<task-id>-<brief-kebab-case-description>` as the stable work id when a description is available and `<task-id>` otherwise. Agent System derives the branch and directory name.

```json
{
  "action": "prepare",
  "repository": {
    "id": "agent-system",
    "cloneUrl": "https://github.com/tanaabased/openclaw-agent-system.git"
  },
  "workId": "123-fix-agent-path-resolution",
  "baseRef": "origin/main"
}
```

List all managed worktrees or narrow the result to one repository.

```json
{ "action": "list", "repositoryId": "agent-system" }
```

Remove one deterministic worktree.

```json
{ "action": "remove", "repositoryId": "agent-system", "workId": "123-fix-agent-path-resolution" }
```

## Outputs

`prepare` returns the repository id, work id, branch, canonical path, and `created` or `existing` status. `list` returns active worktrees discovered from Git. `remove` returns `removed` after ordinary non-forced Git removal succeeds.

## Failure Handling

- Repeat `prepare` with the same identifiers to reuse a matching worktree safely.
- Treat an occupied path, conflicting origin, missing ref, or branch mismatch as an operator-visible conflict; do not relocate, retarget, prune, or force it.
- If removal fails, use `agent_system_git` with the worktree path to inspect status, diffs, and unpushed work before retrying or asking the operator.
- Never bypass policy with raw Git, `exec`, direct deletion, `--force`, or another working-directory mechanism.
- A managed checkout is not inherently trusted; inspect repository guidance before executing repository-owned code.

## Workflow

1. Confirm the repository id, work identifier, base ref, and optional clone URL from the request or notification, then include a brief kebab-case description in the stable work id when available.
2. Invoke `agent_system_git_worktree` with `prepare`; reuse an `existing` result.
3. Pass the returned canonical `path` as `cwd` on every `agent_system_git` call for that work.
4. Use ordinary Git status, branch, diff, commit, fetch, and push operations through `agent_system_git`.
5. Keep the worktree after the task unless removal is explicitly requested.
6. Before removal, inspect and preserve any work that should survive; then invoke non-forced `remove`.

## Bundled Resources

- `agents/openai.yaml`: Codex-facing display metadata and default prompt.
- `agents/assets/`: skill icons.

## Validation

- Confirm the returned repository id and work id match the request.
- Confirm the returned branch equals the final directory name in the returned path.
- Confirm subsequent `agent_system_git` calls use the exact returned path as `cwd`.
- Confirm a repeated preparation returns the same path with `existing` status.
- Confirm removal succeeds without force and no further worktree is listed for that path.
