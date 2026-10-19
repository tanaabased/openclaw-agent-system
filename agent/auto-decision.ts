import { feedbackWorkStarted } from './feedback-work.ts';
import { retainedIssueProgression } from './issue-progression.ts';

/** a live mode edit requests a decision, never an implementation grant. */
export function needsAutoDecision(
  record: Parameters<typeof retainedIssueProgression>[0] &
    Parameters<typeof feedbackWorkStarted>[0],
  mode: string | undefined,
) {
  return (
    mode === 'auto' &&
    record.result?.outcome === 'plan-ready' &&
    !record.result.decision &&
    !record.retired &&
    !record.retirement &&
    !record.reset &&
    !record.handoff &&
    record.continuation?.phase !== 'cancelled' &&
    !retainedIssueProgression(record) &&
    !feedbackWorkStarted(record)
  );
}

export const autoDecisionInstructions =
  'The live workflow now uses Auto. Reuse the complete retained assessment and plan, reconcile newer conversation direction, and choose decision.mode plan or work with bounded reasons. Preserve the assessment; revise it only where new evidence requires it. Submit the complete result with previousResultDigest through the verified assessment context. This request authorizes assessment only, not implementation. Do not ask for routine permission to make the Auto decision. Preserve the issue, chat, worktree, model and effort.';
