import { automationHash } from './automation-hash.ts';
import { nativeObject } from './automation-gateway.ts';
import type { AssessmentSummary } from './assessment-summary-state.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';

/** only an exact non-executed summary command can be excluded from implementation denial checks. */
export default function codexSummaryDenial(
  items: unknown[],
  threadId: string,
  turnId: string,
  summaries: AssessmentSummary[] = [],
) {
  const denied = items.filter((item) => codexTurnApprovalDenied([item]));
  if (denied.length !== 1) return items;
  const item = denied[0];
  if (
    !nativeObject(item) ||
    item.type !== 'commandExecution' ||
    item.status !== 'declined' ||
    typeof item.id !== 'string' ||
    item.processId != null ||
    item.exitCode != null
  )
    return items;
  const summary = summaries.find(
    (entry) =>
      entry.code === 'assessment-summary-native-approval-denied' &&
      entry.binding.workflow === 'issue-assignment' &&
      entry.turnId === turnId &&
      entry.binding.threadId === threadId &&
      entry.previewDigest !== undefined &&
      entry.publicText !== undefined &&
      entry.publicationCommand !== undefined &&
      entry.publicationCommand === item.command &&
      !entry.attempt &&
      !entry.receipt,
  );
  if (!summary) return items;
  summary.nativeDenial = { turnId, callId: item.id, commandDigest: automationHash(item.command) };
  return items.filter((entry) => entry !== item);
}
