import { omit } from 'lodash-es';

import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import { settledFeedback } from '../agent/retain-dispatch-history.ts';

type Record = DispatchRecord & OpenClawDispatchRecord;

/** remove conversation copies while retaining native custody and exact unfinished operations. */
export default function cutover638Active<R extends SharedDispatchRecord>(source: R) {
  const record = structuredClone(source) as unknown as Record;
  const pending: string[] = [];
  // A launch without a verified native destination still owns its original prepared inputs.
  if (!record.threadId || !record.worktree || !record.request)
    return { record: structuredClone(source), pending: ['native-creation'] };

  const summaries = (record.assessmentSummaries ?? []).filter(
    (summary) =>
      !summary.receipt && Boolean(summary.attempt || summary.publicText || summary.nativeDenial),
  );
  if (summaries.length) {
    record.assessmentSummaries = summaries;
    pending.push('assessment-publication');
  } else {
    delete record.assessmentSummaries;
    if (record.result?.outcome === 'operator-setup-blocker') pending.push('assessment-blocker');
    else {
      delete record.result;
      delete record.stageReceipt;
      delete record.assessmentRevision;
      delete record.assessmentHistory;
      // OpenClaw's original implementation turn may still use this exact source binding.
      if (
        ![
          record.work?.turn,
          record.work?.deliveryTurn,
          ...(record.work?.previousTurns ?? []).map((entry) => entry.turn),
        ].some((turn) => turn?.origin === 'assessment')
      )
        delete record.resultTurnId;
    }
  }
  if (record.context) {
    const context: unknown = JSON.parse(record.context);
    if (!context || typeof context !== 'object' || Array.isArray(context))
      throw new Error('cutover-context-invalid');
    record.context = JSON.stringify(omit(context, ['body', 'comments', 'files', 'truncated']));
  }

  const continuation = record.continuation;
  if (continuation) {
    delete continuation.resultHistory;
    delete continuation.handoffs;
    if (continuation.result?.outcome === 'blocked') pending.push('implementation-blocker');
    else {
      delete continuation.result;
      delete continuation.resultSource;
      delete continuation.revisionSource;
    }
    for (const key of ['attempt', 'publicationAttempt'] as const) {
      if (continuation[key]?.ended) delete continuation[key];
      else if (continuation[key]) pending.push('native-' + key);
    }
    if (!continuation.attempt && !continuation.publicationAttempt) {
      delete continuation.retries;
      delete continuation.assessmentDigest;
      delete continuation.assessmentSelectionDigest;
    }
  }
  const work = record.work;
  if (work) {
    delete work.resultHistory;
    if (work.result?.outcome === 'blocked') pending.push('implementation-blocker');
    else {
      delete work.result;
      delete work.resultSource;
      delete work.revisionSource;
    }
    // Native turn receipts remain with their owner; deleting one may resend its original input.
    if ([work.turn, work.deliveryTurn].some((turn) => turn && turn.status !== 'completed'))
      pending.push('native-turn');
  }
  if (record.autoDecision?.ended) delete record.autoDecision;
  else if (record.autoDecision) pending.push('native-decision');
  if (record.summaryRecovery) {
    if ('ended' in record.summaryRecovery && record.summaryRecovery.ended)
      delete record.summaryRecovery;
    else if ('turn' in record.summaryRecovery && record.summaryRecovery.turn.status === 'completed')
      delete record.summaryRecovery;
    else pending.push('native-summary');
  }
  delete record.previousSummaryAttempts;

  // Keep source/revision fences while dropping settled feedback's copied conversation.
  if (record.feedback && record.nativeInactive) {
    const settled = record.feedback.events.filter(
      (event) =>
        event.id !== record.progression?.workOwner &&
        event.id !== record.feedback?.context?.eventId &&
        settledFeedback(event),
    );
    const ids = new Set(settled.map((event) => event.id));
    record.feedback.events = record.feedback.events.filter((event) => !ids.has(event.id));
    if (settled.length)
      record.feedback.completed = [
        ...(record.feedback.completed ?? []),
        ...settled.map(({ id, sourceId, revision, nodeId, receipt, native }) => ({
          id,
          sourceId,
          revision,
          nodeId,
          receipt,
          ...(native ? { native } : {}),
        })),
      ];
    for (const event of settled) {
      const baseline = record.feedback.baseline[event.nodeId];
      if (event.itemType === 'issue' && baseline?.[event.sourceId] === event.source)
        delete baseline[event.sourceId];
    }
  }
  return { record: record as unknown as R, pending };
}
