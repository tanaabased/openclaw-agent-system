import { isDeepStrictEqual } from 'node:util';
import { pick, omit } from 'lodash-es';
import { Value } from 'typebox/value';
import { codexWorkStateSchema } from './codex-work-state.ts';
import openClawNativeTurns from './openclaw-native-turns.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';

type Record = DispatchRecord & OpenClawDispatchRecord;
export const obsoleteDispatchFields = [
  'continuation',
  'autoDecision',
  'summaryRecovery',
  'previousSummaryAttempts',
  'directAssessments',
  'result',
  'stageReceipt',
  'assessmentRevision',
  'assessmentHistory',
  'assessmentSummaries',
  'resultTurnId',
  'turnEvidence',
  'firstTurn',
  'assessmentTurn',
  'decisionTurn',
  'previousDecisionTurns',
  'previousSummaryTurns',
  'deliveryHistory',
  'retainedHistory',
  'deniedCreations',
  'unsubmittedCreations',
  'recoveredDenials',
] as const;
export const obsoleteFeedbackFields = [
  'work',
  'result',
  'workDelivery',
  'composition',
  'publicationAttempted',
  'publicationApproval',
] as const;
export const obsoleteWorkFields = [
  'turn',
  'deliveryTurn',
  'previousTurns',
  'assessmentDigest',
  'result',
  'resultSource',
  'revisionSource',
  'resultHistory',
  'clarificationInput',
] as const;

export function validNativeDispatchRecord(source: SharedDispatchRecord) {
  const record = source as Record;
  if (obsoleteDispatchFields.some((key) => record[key] !== undefined)) return false;
  if (record.work && obsoleteWorkFields.some((key) => record.work?.[key] !== undefined))
    return false;
  if (
    record.feedback?.events.some((event) =>
      obsoleteFeedbackFields.some((key) => Object.hasOwn(event, key)),
    )
  )
    return false;
  if (record.nativeWork && !Value.Check(codexWorkStateSchema, record.nativeWork)) return false;
  const turns = record.nativeTurns ?? [];
  return (
    new Set(turns.map(({ turn }) => turn.runId)).size === turns.length &&
    turns.every(
      ({ role, turn }) =>
        role !== 'feedback' &&
        (turn.status === 'completed' ? turn.message === undefined : Boolean(turn.message)) &&
        ['consumed', 'completed'].includes(turn.status) === Boolean(turn.consumedByEventId) &&
        (!turn.replyEventId || turn.status === 'completed') &&
        (!turn.failed || turn.status === 'completed') &&
        (turn.status !== 'completed' || turn.failed || Boolean(turn.replyEventId)),
    ) &&
    new Set((record.nativeRequests ?? []).map(({ attempt }) => attempt.id)).size ===
      (record.nativeRequests?.length ?? 0)
  );
}

/** convert only local custody; callers must transfer historical external effects first. */
export default function nativeDispatchRecord<R extends SharedDispatchRecord>(
  source: R,
  effectsTransferred = false,
): R {
  const record = structuredClone(source) as unknown as Record;
  if (record.cleanupPending || record.retainedHistory?.terminal) return source;
  if (
    !effectsTransferred &&
    (record.feedback?.events.some(
      (event) =>
        ('workDelivery' in event && event.workDelivery) ||
        (event.publicationAttempted && !event.receipt),
    ) ||
      record.deliveryHistory?.length ||
      record.assessmentSummaries?.some(
        (summary) => summary.attempt && !summary.receipt && !summary.nativeDenial,
      ))
  )
    throw new Error('dispatch-external-effect-migration-required');
  const creations = [
    ...(record.deniedCreations ?? []).map((entry) => ({
      ...pick(entry, ['turnId', 'callId', 'createdAt', 'recoveredAt', 'approvedBy']),
      kind: 'denied' as const,
    })),
    ...(record.unsubmittedCreations ?? []).map((entry) => ({
      ...pick(entry, ['turnId', 'createdAt', 'recoveredAt']),
      kind: 'unsubmitted' as const,
    })),
  ];
  if (creations.length || record.recoveredDenials?.length) {
    record.creationRecovery = {
      attempts: (record.creationRecovery?.attempts ?? 0) + creations.length,
      ...(record.creationRecovery?.denialRecovered || record.recoveredDenials?.length
        ? { denialRecovered: true as const }
        : {}),
      latest: [
        ...creations,
        ...(record.creationRecovery?.latest ? [record.creationRecovery.latest] : []),
      ].sort((a, b) => b.recoveredAt - a.recoveredAt)[0],
    };
  }
  const work = record.continuation;
  if (work) {
    record.nativeWork = {
      ...pick(work, Object.keys(codexWorkStateSchema.properties)),
      ...(work.phase === 'cancelled' ? { cancelled: true as const } : {}),
      ...(work.result?.outcome === 'blocked' || work.phase === 'blocked'
        ? {
            blocked: true as const,
            blockedTurnId: work.blockedTurnId ?? work.activeTurnId ?? work.binding?.turnId,
          }
        : {}),
    } as NonNullable<Record['nativeWork']>;
    if (record.nativeWork.observation)
      record.nativeWork.observation = pick(record.nativeWork.observation, [
        'turnId',
        'afterItemId',
        'receiptId',
      ]);
  }
  const requests = [
    ...(record.nativeRequests ?? []),
    ...(work?.attempt ? [{ kind: 'implementation' as const, attempt: work.attempt }] : []),
    ...(work?.publicationAttempt
      ? [{ kind: 'delivery' as const, attempt: work.publicationAttempt }]
      : []),
    ...(record.autoDecision
      ? [
          {
            kind: 'decision' as const,
            attempt: {
              ...record.autoDecision.attempt,
              ...(record.autoDecision.ended ? { ended: true as const } : {}),
            },
          },
        ]
      : []),
    ...(record.summaryRecovery && 'attempt' in record.summaryRecovery
      ? [
          {
            kind: 'summary' as const,
            attempt: {
              ...record.summaryRecovery.attempt,
              ...(record.summaryRecovery.ended ? { ended: true as const } : {}),
            },
          },
        ]
      : []),
    ...(record.previousSummaryAttempts ?? []).map((attempt) => ({
      kind: 'summary' as const,
      attempt,
    })),
    ...(record.autoDecision?.previousAttempts ?? []).map((attempt) => ({
      kind: 'decision' as const,
      attempt,
    })),
    ...(work?.retries ?? [])
      .filter((retry) => !retry.rejection)
      .map(({ attempt }) => ({ kind: 'implementation' as const, attempt })),
  ];
  const uniqueRequests = new Map<string, (typeof requests)[number]>();
  for (const entry of requests) {
    const previous = uniqueRequests.get(entry.attempt.id);
    if (previous) {
      if (
        !isDeepStrictEqual(
          omit(previous.attempt, ['ended', 'turnId']),
          omit(entry.attempt, ['ended', 'turnId']),
        ) ||
        (previous.attempt.turnId &&
          entry.attempt.turnId &&
          previous.attempt.turnId !== entry.attempt.turnId)
      )
        throw new Error('native-request-conflict');
      entry.attempt = {
        ...previous.attempt,
        ...entry.attempt,
        ...(previous.attempt.ended || entry.attempt.ended ? { ended: true } : {}),
      };
    }
    uniqueRequests.set(entry.attempt.id, entry);
  }
  const pending = [...uniqueRequests.values()].filter(({ attempt }) => !attempt.ended);
  if (pending.length) record.nativeRequests = pending;
  else delete record.nativeRequests;
  if (record.sessionCreation) {
    const turns = openClawNativeTurns(record)
      .filter(({ role }) => role !== 'feedback')
      .map(({ role, turn: original }) => {
        const turn = { ...original };
        if (turn.status === 'completed') delete turn.message;
        delete (turn as { executionModel?: string }).executionModel;
        return { role, turn };
      });
    const uniqueTurns = new Map<string, (typeof turns)[number]>();
    for (const entry of turns) {
      const previous = uniqueTurns.get(entry.turn.runId);
      if (previous) {
        if (
          previous.role !== entry.role ||
          ['consumedByEventId', 'executionRunId', 'origin', 'message'].some((key) => {
            const field = key as 'consumedByEventId' | 'executionRunId' | 'origin' | 'message';
            return (
              previous.turn[field] &&
              entry.turn[field] &&
              previous.turn[field] !== entry.turn[field]
            );
          })
        )
          throw new Error('native-turn-conflict');
        if (previous.turn.cancelled) entry.turn.cancelled = true;
        if (previous.turn.failed) entry.turn.failed = true;
        const statuses = ['attempted', 'accepted', 'consumed', 'completed'];
        if (statuses.indexOf(previous.turn.status) > statuses.indexOf(entry.turn.status)) continue;
      }
      uniqueTurns.set(entry.turn.runId, entry);
    }
    if (turns.length) record.nativeTurns = [...uniqueTurns.values()];
    else delete record.nativeTurns;
  }
  for (const event of record.feedback?.events ?? []) {
    if (!event.native) {
      event.native = true;
      if (event.phase === 'published' || event.phase === 'responded') event.phase = 'delivered';
    }
    for (const key of obsoleteFeedbackFields) delete event[key];
  }
  // Creation inputs remain exact until the destination is verified.
  if (record.threadId && record.worktree && record.request && record.context) {
    const context: unknown = JSON.parse(record.context);
    if (!context || typeof context !== 'object' || Array.isArray(context))
      throw new Error('native-context-invalid');
    record.context = JSON.stringify(omit(context, ['body', 'comments', 'files', 'truncated']));
  }
  if (record.result?.outcome === 'operator-setup-blocker') record.blocker = record.result.code;
  for (const key of obsoleteDispatchFields) delete record[key];
  if (record.work) for (const key of obsoleteWorkFields) delete record.work[key];
  record.nativeRecord = true;
  return record as unknown as R;
}
