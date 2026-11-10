import type { CodexWorkContext } from './codex-continuation-context.ts';
import workflowFailure from './workflow-failure.ts';

/** Observe already-attempted requests. Conversation progress never creates a new send. */
export default async function reconcileCodexRequests(context: CodexWorkContext) {
  const outcomes = [];
  for (const record of context.records) {
    if (context.input.id && record.id !== context.input.id) continue;
    const work = record.continuation;
    const requests = [
      ...(record.nativeRequests ?? []),
      ...(work?.attempt && !work.attempt.ended
        ? [{ kind: 'implementation', attempt: work.attempt }]
        : []),
      ...(work?.publicationAttempt && !work.publicationAttempt.ended
        ? [{ kind: 'delivery', attempt: work.publicationAttempt }]
        : []),
      ...(record.autoDecision && !record.autoDecision.ended
        ? [{ kind: 'decision', attempt: record.autoDecision.attempt }]
        : []),
      ...(record.summaryRecovery && !record.summaryRecovery.ended
        ? [{ kind: 'summary', attempt: record.summaryRecovery.attempt }]
        : []),
    ];
    for (const { kind, attempt } of requests) {
      try {
        const receipt = await context.continuationNative(
          record.sourceThreadId,
          attempt,
          record.assessmentSummaries,
        );
        if (receipt.status === 'verified') {
          attempt.turnId = receipt.turnId;
          if (receipt.ended) attempt.ended = true;
          if (receipt.ended && kind === 'decision' && record.autoDecision)
            record.autoDecision.ended = true;
          if (receipt.ended && kind === 'summary' && record.summaryRecovery)
            record.summaryRecovery.ended = true;
          await context.save();
        }
        outcomes.push({ id: record.id, kind, ...receipt });
      } catch (error) {
        outcomes.push({
          id: record.id,
          kind,
          ...workflowFailure(error, 'continuation-reconciliation-unavailable'),
        });
      }
    }
  }
  return { status: 'reconciled' as const, outcomes };
}
