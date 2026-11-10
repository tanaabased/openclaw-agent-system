import { withNative, type CodexDispatchTransaction } from './codex-dispatch-context.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import dispatchBlocker from './dispatch-blocker.ts';

export const denialRecovery =
  'Ask an operator chat to retry this issue through `dispatch retry-denied`: select its issue target URL, using preview:true for inspection if needed. Explicitly renewed operator authorization uses renewAuthorization:true; the runtime resolves the exact denied call. Waiting, reassignment, or restarting does not clear this hold.';

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
    !record.creationRecovery?.attempts &&
    !record.creationRecovery?.denialRecovered
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
    if (dispatchBlocker(record) === 'dispatch-denial-history-unavailable') {
      delete record.blocker;
      delete record.retryAfter;

      await tx.save();
    }
    return false;
  }
  record.denial = { ...evidence, observedAt: tx.now };

  delete record.retry;
  delete record.retryAfter;
  record.blocker = 'native-approval-denied';
  await tx.save();
  return true;
}
