---
name: agent-system-task-review
description: 'Review a GitHub pull request independently, diagnose defects and CI failures, and publish a formal review without implementing repairs. Use for an admitted review request or an explicit request to start an independent PR review.'
license: MIT
metadata:
  type: workflow
  owner: tanaab
  tags:
    - tanaab
    - workflow
    - task-management
  openclaw:
    emoji: '🔎'
    homepage: 'https://github.com/tanaabased/openclaw-agent-system/tree/main/skills/task-review'
---

# Agent System Task Review

## Overview

Review one PR independently of its author. Read code and CI evidence, identify
consequential defects, and publish a formal review. The author owns repairs;
the runtime owns request authorization, routing, native creation and publication receipts.

## Required Reading

- **Always:** [Review Standard](https://github.com/tanaabased/canon/blob/main/references/review-standard.md)
  for evidence loading, scope, coverage and reporting. Load the applicable owning
  skills and their required references before judging changed behavior. Missing
  guidance limits the affected assessment, not unrelated work.
- **Before examining code:** applicable repository instructions and their required
  references. Reuse complete reads; a summary or truncated read is not enough.
- **Before replying to admitted feedback:** [GitHub Reply](../github-reply/SKILL.md).
  Use the configured composer and exact authorized source, not a generic PR comment.

## When to Use

- A native reviewer chat has verified review context for one PR.
- An operator explicitly asks to start an independent review of a PR.

## When Not to Use

- Implementing repairs, committing, pushing, merging, deploying, or executing CI reruns.
- Reviewing unrelated repositories or replacing the author's task ownership.
- Completing a task or milestone merely because CI passes.

## Preconditions

Use trusted native context directly. If it is missing, request `dispatch review context`
in standalone Codex through its supplied dispatch runtime. Do not reconstruct binding
IDs, select another workspace, or launch a duplicate chat.

For explicit launch without an existing reviewer chat, use `dispatch review launch`
with the exact PR URL, then the returned readiness and routing instructions. A manual
launch does not need a review-request event or a running schedule. OpenClaw's native
review adapter is a separate capability; preserve an explicit unavailable result.
Optional `overrides: {model, effort}` selects an explicit provider/model and effort.
Otherwise use the shared routing assessment returned by the runtime, including verified
Complexity from a unique linked issue. Do not copy the author's model or substitute a
diff-size heuristic. If manual launch is waiting for CI without an active review coordinator,
resume it with the same PR target after checks settle; do not activate a schedule implicitly.

## Workflow

1. Identify the exact PR head, base, author, linked requirements and review scope.
   Inspect the diff and relevant definitions, callers, tests and operational contracts.
   A short diff can still change a critical invariant. Read-only code access is the
   default; do not modify implementation files or execute repository scripts that
   mutate state. Respect native and provider restrictions.
2. Inspect CI for the exact head or a verified merge revision. While relevant checks
   run, stay quiet: no review comments, code changes or reruns. Failed observations
   are unavailable evidence, not absent CI. Once checks finish, review failures as
   evidence even when they do not pass. Distinguish a demonstrated code defect from
   infrastructure failure or a suspected flaky test. Request a targeted repair for a demonstrated defect. For a plausible transient failure, check the discussion and this chat before asking the author or operator for one rerun. Do not repeat that request or execute it yourself. Leave unexplained failures explicit.
3. Look for defects, regressions, missing useful coverage and unnecessary complexity.
   Trace consequential findings far enough to show an affected scenario and explain
   the consequence. Prefer a specific minimal repair over speculative redesign.
   Separate must-fix findings from nonblocking suggestions; style preferences alone
   do not justify requesting changes. Report substantive coverage gaps honestly.
4. Group findings into one formal review. Put precise findings on relevant changed
   lines; keep the summary focused on disposition, CI and cross-cutting conclusions.
   Mention the verified PR author when requesting repairs so the existing authorized
   author-feedback path can handle them. An @mention is not itself an authority grant.
5. Choose `REQUEST_CHANGES` for must-fix defects, `COMMENT` for useful findings or
   unresolved evidence without a justified approval, or `APPROVE` after a complete
   review with no unresolved substantive defects and acceptable current CI. First-pass
   approval needs no separate flag. Passing CI alone is not sufficient.
6. Publish through `dispatch review publish`, supplying only
   `draft: {event, body, comments: [{path, line, side, body, startLine?, startSide?}]}`.
   Use `LEFT` or `RIGHT` for diff sides. The runtime binds the chat, destination and
   reviewed revision, rechecks CI, and reads back GitHub's actual review. An uncertain
   result uses `dispatch review reconcile` without another draft. Do not repeat the
   write or bypass a denial through raw GitHub commands.
7. Report the actual published review and its permalink. Approval ends this pass,
   not the reviewer chat. Authorized feedback uses the same model and conversation.
   Revisit prior findings when new evidence arrives. An authorized explanation can resolve a finding without a commit. Inspect the exact updated diff on GitHub if the checkout is older; never move an inline finding to another diff automatically. Do not install per-PR schedules or send idle-chat nudges. An explicit operator request to retire this
   review uses `dispatch review retire` with its PR URL and the returned native handoff.

## Checkpoints

- The review targets the admitted PR and exact revision, independent of author work.
- CI has settled before publication; failed CI remains unresolved evidence.
- Findings distinguish must-fix defects, suggestions and unknowns.
- No implementation, push, merge, deployment or executed rerun occurred.
- Native/provider denials and uncertain effects remain with their original owners.

## Completion Criteria

A formal review is verified on GitHub, or the exact publication obstacle remains
visible with the original candidate intact. A prose summary claiming success is not
publication. Do not call a limited or incomplete investigation an approval.

## Bundled Resources

- [GitHub Reply](../github-reply/SKILL.md): source-bound feedback composition.
- `agents/openai.yaml` and `assets/`: native skill presentation.

## Validation

Check the reviewed revision, substantive evidence, CI interpretation, disposition,
inline locations and GitHub readback. Report unexamined scope and unrun checks.
Skill-author validation is maintenance work, not a prerequisite for ordinary reviews.
