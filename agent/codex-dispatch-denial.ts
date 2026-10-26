import { withNative, type CodexDispatchTransaction } from './codex-dispatch-context.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';

export const denialRecovery =
  'Ask an operator chat to retry this issue through `dispatch retry-denied`: preview with its retained id, then apply the returned digest. Renew authorization for the exact denied call when required. Waiting, reassignment, or restarting does not clear this hold.';

export default async function reconcileIntakeDenial(
  record: DispatchRecord,
  tx: CodexDispatchTransaction,
  observingPreparation = false,
) {
  if (record.denial) return true;
  if (
    !record.manualIssue &&
    !record.request &&
    record.project &&
    record.context &&
    !record.preparationObservation &&
    !record.recoveredDenials?.length &&
    !record.deniedCreations?.length &&
    !record.unsubmittedCreations?.length
  )
    throw new Error('dispatch-denial-history-unavailable');
  const anchored = Boolean(record.preparationObservation || record.creationAfterItemId);
  if (
    (!anchored && (!record.manualIssue || record.request)) ||
    record.threadId ||
    record.receiptThreadId ||
    record.clientThreadId ||
    record.worktree ||
    record.handoff
  )
    return false;
  const evidence = anchored
    ? await withNative(tx.current, tx.deps, async (native) => {
        const denial = await native.intakeDenial(record, observingPreparation);
        if (denial && record.request) {
          const found = await native.find({
            sourceThreadId: record.sourceThreadId,
            prompt: record.request.prompt,
            createdAfter: record.createdAt,
            observationOnly: true,
          });
          if (found) throw new Error('dispatch-denial-execution-unresolved');
        }
        return denial;
      })
    : undefined;
  if (!evidence) {
    if (
      record.result?.outcome === 'operator-setup-blocker' &&
      record.result.code === 'dispatch-denial-history-unavailable'
    ) {
      delete record.result;
      delete record.retryAfter;
      record.phase = record.request ? 'creating' : 'routing';
      await tx.save();
    }
    return false;
  }
  record.denial = { ...evidence, observedAt: tx.now };
  record.phase = 'blocked';
  delete record.retry;
  delete record.retryAfter;
  record.result = {
    version: 1,
    outcome: 'operator-setup-blocker',
    code: 'native-approval-denied',
    summary: 'This issue has a retained native approval denial.',
    remediation: denialRecovery,
    evidence: [
      {
        source: 'Native approval',
        status: 'observed',
        detail: 'Verified non-execution of ' + evidence.operation + '.',
      },
    ],
    progress: {
      completed: [],
      remaining: ['Recover the exact denied action before retrying this issue.'],
    },
  };
  await tx.save();
  return true;
}
