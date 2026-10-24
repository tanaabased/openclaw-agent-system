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
    record.assessmentSummaries?.find(
      (entry) => entry.code && /denied|cancelled/.test(entry.code),
    ) ??
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
        instruction:
          state === 'blocked' && summary?.code && /denied|cancelled/.test(summary.code)
            ? 'Report the retained summary hold and diagnostic separately from implementation progress. Do not retry, compose, publish, reconcile or use another publication route while this hold remains. Supported verified recovery or renewed authorization is required for publication. Continue independently authorized implementation only through fresh native context; broader denial, cancellation and lost authority remain stops.'
            : state === 'blocked'
              ? 'Report the summary diagnostic separately from implementation progress. Restore the named access, authority or skill before recovery through the owning summary operation. Never bypass a denial or changed source; summary recovery grants no implementation authority.'
              : 'Recover this unfinished summary through the owning summary operation: reconcile an attempted post, otherwise compose. Do not repeat assessment or change the implementation stage.',
      };
}
