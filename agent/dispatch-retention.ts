import { isDeepStrictEqual } from 'node:util';

import { compactAssessmentSummaries } from './assessment-retention.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { compactFeedback, settledFeedback } from './feedback-retention.ts';
import { compactFeedbackBaseline } from './feedback-source.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { packRetained, retainedEvidenceBytes, unpackRetained } from './retained-history.ts';

/** retained indexes are scheduling evidence, never runnable work or renewed authority. */
function terminalIndex<R extends SharedDispatchRecord>(record: R): R {
  const {
    id,
    intakeId,
    issueKey,
    sourceThreadId,
    phase,
    createdAt,
    manifestDigest,
    threadId,
    worktree,
    retirement,
    retired,
    nativeInactive,
    reset,
  } = record;
  return Object.fromEntries(
    Object.entries({
      id,
      intakeId,
      issueKey,
      sourceThreadId,
      phase,
      createdAt,
      manifestDigest,
      threadId,
      worktree,
      retirement,
      retired,
      nativeInactive,
      reset,
    }).filter(([, value]) => value !== undefined),
  ) as unknown as R;
}

export function retainedDispatch<R extends SharedDispatchRecord>(
  record: R | undefined,
): R | undefined {
  if (!record?.retained) return record;
  const full = unpackRetained(record.retained) as R;
  const index = { ...record };
  delete index.retained;
  if (full.retained || !isDeepStrictEqual(JSON.parse(JSON.stringify(terminalIndex(full))), index))
    throw new Error('retained-dispatch-identity-invalid');
  return full;
}

function settledDelivery(
  delivery: DispatchRecord['delivery'] | NonNullable<OpenClawDispatchRecord['work']>['delivery'],
) {
  return (
    !delivery ||
    Boolean(
      delivery.reconciled &&
      delivery.pullRequest &&
      !delivery.contentUpdate &&
      (!('attached' in delivery) || delivery.attached) &&
      (!delivery.announcement || delivery.announcement.receipt),
    )
  );
}

export function settledCodexRecord(record: DispatchRecord) {
  return Boolean(
    record.retired &&
    record.retirement &&
    !record.retirement.code &&
    (!record.request || record.nativeInactive === true) &&
    (!record.request || (record.threadId && record.effective?.status === 'verified')) &&
    (!record.continuation ||
      (record.continuation.phase === 'complete' && record.continuation.result)) &&
    (!record.continuation?.publicationAttempt || Boolean(record.delivery?.reconciled)) &&
    settledDelivery(record.delivery) &&
    (!record.feedback ||
      (!record.feedback.discoveryPending &&
        !Object.keys(record.feedback.discovery ?? {}).length &&
        record.feedback.events.every(settledFeedback))) &&
    !(record.assessmentSummaries ?? []).some((summary) => summary.attempt && !summary.receipt),
  );
}

export function settledOpenClawRecord(record: OpenClawDispatchRecord) {
  return Boolean(
    record.retired &&
    record.retirement &&
    !record.retirement.code &&
    (!record.request || (record.nativeInactive === true && record.sessionCreation?.verified)) &&
    (!record.firstTurn || record.firstTurn.status === 'completed') &&
    (!record.assessmentTurn || record.assessmentTurn.status === 'completed') &&
    (!record.work || record.work.result?.outcome === 'done') &&
    (!record.work?.publication || Boolean(record.work.delivery?.reconciled)) &&
    settledDelivery(record.work?.delivery) &&
    (!record.feedback ||
      (!record.feedback.discoveryPending &&
        !Object.keys(record.feedback.discovery ?? {}).length &&
        record.feedback.events.every(settledFeedback))) &&
    !(record.assessmentSummaries ?? []).some((summary) => summary.attempt && !summary.receipt),
  );
}

export function compactDispatchRecord<R extends SharedDispatchRecord>(
  record: R,
  eligible: (record: R) => boolean,
): R {
  if (record.retained) return record;
  compactAssessmentSummaries(record);
  const feedback = (record as R & Pick<DispatchRecord, 'feedback'>).feedback;
  if (feedback) {
    compactFeedback(feedback);
    compactFeedbackBaseline(feedback);
  }
  if (!eligible(record)) return record;
  // a record already containing packed history can exceed the per-evidence decoding bound.
  // keeping it in its validated representation is safer than adding a new packing blocker.
  if (Buffer.byteLength(JSON.stringify(record)) > retainedEvidenceBytes) return record;
  const compact = { ...terminalIndex(record), retained: packRetained(record, record.id) };
  return Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(record))
    ? compact
    : record;
}
