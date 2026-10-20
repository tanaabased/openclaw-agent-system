import type { SharedDispatchRecord } from './dispatch-state.ts';
import publicResponseState from './public-response-state.ts';

/** the saved source revision is the durable obligation, including before composition starts. */
export default function pendingPublicResponse(record: SharedDispatchRecord) {
  if (
    record.retired ||
    record.retirement ||
    record.reset ||
    !record.result?.fullAssessment ||
    !record.assessmentRevision
  )
    return;
  const summary =
    record.assessmentSummaries?.find((entry) => entry.attempt && !entry.receipt) ??
    record.assessmentSummaries?.find((entry) => entry.revision === record.assessmentRevision);
  const state = publicResponseState({
    attempted: Boolean(summary?.attempt),
    receipt: summary?.receipt,
    code: summary?.code,
  });
  return state === 'delivered'
    ? undefined
    : {
        kind: 'assessment-summary' as const,
        revision: summary?.revision ?? record.assessmentRevision,
        state,
        summary,
      };
}
