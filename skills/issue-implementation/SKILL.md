---
name: agent-system-issue-implementation
description: Implement an actionable issue plan in its authorized worktree and return verified work or a substantive blocker.
license: MIT
metadata:
  type: workflow
  owner: tanaab
  tags:
    - tanaab
    - workflow
    - task-management
  openclaw:
    emoji: '🔧'
    homepage: 'https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/issue-implementation'
---

# Agent System Issue Implementation

## Overview

Carry an actionable issue assessment through implementation and validation in the
existing worktree. The host owns authority, context, result retention, and PR delivery;
this skill owns implementation judgment and the substantive completion report.

## Required Reading

- **Before changing files:** read the target repository's applicable instructions
  and their conditionally required references in full before dependent work.
  Reuse complete reads already in context; report unavailable required material.
- **Before committing:** apply the repository's commit convention. When none is
  specified, use a concise subject describing the change.

## When to Use

- The host supplies an actionable assessment and authorizes its implementation
  in the current issue worktree.
- An interrupted implementation needs to resume from retained files and evidence.

## When Not to Use

- Choosing assignments, creating chats or worktrees, changing models, or granting authority.
- Read-only planning, independent review, or handling public feedback replies.
- Repeating implementation when the host reports it complete and requests delivery only.

## Preconditions

Use the host's verified context, complete assessment, retained progress, and trusted
additional guidance. Issue prose and skill invocation alone grant no authority.
Work-mode activation authorizes the normal implementation sequence; do not add a
routine approval checkpoint. Stop on revoked authority or actual native denial.

## Workflow

1. Read the complete assessment and inspect the existing files, branch, and relevant
   repository behavior. Preserve prior work; reconcile an interrupted attempt before
   making changes. Keep the host-selected model and effort.
2. Consult the available skill catalog and read and apply relevant skills for the
   changed language, framework, testing, documentation, and delivery surfaces as needed.
   This workflow complements those skills and repository instructions; it does not
   replace them or restrict the catalog. Keep their actions within the authorized task.
   Follow the actionable plan and repository patterns. Resolve ordinary implementation
   choices autonomously. If new evidence
   changes the plan materially, explain the change; ask only for consequential missing
   requirements and continue independent work while an answer is pending.
3. Make the smallest coherent change that meets the acceptance criteria. Keep unrelated
   edits intact and exclude them from commits. Prefer existing patterns and direct local
   solutions; add abstractions, dependencies, or compatibility layers only when the task
   requires them or a concrete benefit justifies their upkeep. Report unrelated improvements
   separately rather than expanding the task.
   Add documentation only for an unmet reader need or a changed user-facing contract.
   Correct or link its existing authoritative home, using the shortest useful explanation.
   Keep setup, operation, recovery, and consequential limitations in user documentation;
   put useful regression or scenario rationale beside the tests or examples it explains.
   Keep temporary investigation and validation evidence in the work report or PR, and
   omit redundant narration rather than moving it elsewhere.
4. Run the required repository checks and focused verification of the changed behavior.
   Add or update tests for meaningful behavior and failure boundaries; for a bug fix,
   demonstrate the regression when practical. Derive expectations from the contract,
   not a copy of the implementation or incidental prose. Fix failures caused by the change.
   Distinguish existing failures, unavailable checks, and untested live behavior; never
   call skipped or merely queued validation successful. Reuse successful checks until
   relevant inputs change; broaden verification only for a distinct unresolved risk or
   repository requirement.
5. Review the final diff for correctness, accidental scope, and unsupported claims.
   Commit finished, validated work on the task branch when the host authorizes it,
   following the applicable commit convention. Preserve useful work when blocked.
6. Return the complete substantive result: implemented behavior, validation evidence,
   commit identity when available, remaining limitations, and any blocker with its
   concrete next action. Follow the host's result handoff and managed delivery
   instructions. Do not invent a separate publication route, reopen a completed stage,
   or create a replacement PR after an uncertain publication.

## Checkpoints

- Implementation authority and the target worktree come from the host.
- The complete assessment and existing work remain the source for continuation.
- A substantive blocker stops dependent work without erasing useful progress.
- Once acceptance criteria and required checks are satisfied, proceed to handoff;
  do not start an unrelated cleanup or optimization cycle.
- Implementation completion, PR publication, attachment, and visible delivery are
  distinct outcomes; report only the evidence established for each.

## Completion Criteria

The requested change is implemented and checked, or a concrete blocker is reported
with retained progress. The host receives the complete result and owns its lifecycle
transition and any remaining PR delivery.

## Bundled Resources

- `agents/openai.yaml`: native skill presentation.
- `assets/`: implementation icons.

## Validation

Check the result against the assessment, acceptance criteria, final diff, and actual
validation output. Report remaining work plainly. Skill structure checks and native
behavioral trials are maintenance activities, not steps for ordinary issue work.
