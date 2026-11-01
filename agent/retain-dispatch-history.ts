import { omit } from 'lodash-es';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import { automationHash } from './automation-hash.ts';
import type { TerminalEffect } from './history-state.ts';

type Record = OpenClawDispatchRecord & DispatchRecord;
const terminalKeys = new Set([
  'id',
  'intakeId',
  'manualIssue',
  'supersededBy',
  'predecessorId',
  'issueKey',
  'sourceThreadId',
  'phase',
  'createdAt',
  'manifestDigest',
  'threadId',
  'worktree',
  'worktreeAttemptId',
  'retired',
  'retirement',
  'nativeInactive',
  'intakeReportedAt',
  'retainedHistory',
]);

export function verifiedTerminalCleanup(record: SharedDispatchRecord) {
  const cleanup = record.retirement;
  return Boolean(
    record.retired &&
    cleanup &&
    record.nativeInactive !== false &&
    cleanup.worktreeRemovedAt !== undefined &&
    (cleanup.archivedAt !== undefined || cleanup.sessionUnavailableObserved) &&
    !cleanup.code &&
    !cleanup.deadlinePending &&
    cleanup.worktreeRemovedAt >= cleanup.at &&
    (cleanup.archivedAt ?? cleanup.sessionUnavailableObserved!.at) >= cleanup.at &&
    (!cleanup.archiveAttempt ||
      (cleanup.archivedAt ?? cleanup.sessionUnavailableObserved!.at) >=
        cleanup.archiveAttempt.at) &&
    (!cleanup.archiveRequest ||
      (cleanup.archivedAt ?? cleanup.sessionUnavailableObserved!.at) >=
        cleanup.archiveRequest.at) &&
    (!cleanup.worktreeRemovalAttemptedAt ||
      cleanup.worktreeRemovedAt >= cleanup.worktreeRemovalAttemptedAt),
  );
}

export function validTerminalRecord(record: SharedDispatchRecord) {
  return Boolean(
    record.retainedHistory?.terminal &&
    verifiedTerminalCleanup(record) &&
    Boolean(record.intakeId) !== Boolean(record.manualIssue) &&
    Object.keys(record).every((key) => terminalKeys.has(key)),
  );
}

function terminalEffects(record: Record): TerminalEffect[] {
  const effects: TerminalEffect[] = [];
  if (record.denial)
    effects.push({
      kind: 'native-denial',
      id: record.denial.callId,
      status: 'held',
      hold: record.denial.reason ?? record.denial.operation,
    });
  for (const summary of record.assessmentSummaries ?? []) {
    if (!summary.receipt && !summary.attempt && !summary.code && !summary.nativeDenial) continue;
    effects.push({
      kind: 'assessment-summary',
      id: summary.resultDigest,
      revision: String(summary.revision),
      status: summary.receipt
        ? 'published'
        : summary.code || summary.nativeDenial
          ? 'held'
          : 'uncertain',
      receipt: summary.receipt,
      attempt: summary.attempt,
      code: summary.code,
      previewDigest: summary.previewDigest,
      nativeDenial: summary.nativeDenial,
    });
  }
  for (const event of record.feedback?.events ?? []) {
    if (event.receipt || event.publicationAttempted || event.policyHeld || event.code || event.work)
      effects.push({
        kind: 'feedback',
        id: event.id,
        sourceId: event.sourceId,
        revision: event.revision,
        nodeId: event.nodeId,
        status: event.receipt
          ? 'published'
          : event.policyHeld || event.code
            ? 'held'
            : event.publicationAttempted
              ? 'uncertain'
              : event.phase,
        outcome: event.work?.result?.outcome,
        receipt: event.receipt,
        attempt: event.publicationAttempted ? event.id : undefined,
        reported: event.reported,
        hold: event.policyHeld,
        code: event.code,
      });
  }
  for (const event of record.feedback?.completed ?? [])
    effects.push({ kind: 'feedback', ...event, status: 'published', reported: true });
  const deliveries = [
    record.delivery,
    record.work?.delivery,
    ...(record.feedback?.events ?? []).map((event) => event.workDelivery),
  ];
  for (const delivery of deliveries) {
    if (!delivery) continue;
    effects.push({
      kind: 'delivery',
      id: delivery.id,
      status: delivery.reconciled
        ? 'reconciled'
        : delivery.creationAttempted
          ? 'uncertain'
          : 'prepared',
      repositoryId: delivery.binding.repositoryId,
      issueId: delivery.binding.issueId,
      branch: delivery.binding.branch,
      head: delivery.binding.head,
      pushedHead: delivery.pushedHead,
      pendingPush: delivery.pendingPush,
      contentDigest: delivery.contentUpdate ? automationHash(delivery.contentUpdate) : undefined,
      pullRequest: delivery.pullRequest,
    });
    const announcement = delivery.announcement;
    if (announcement && (announcement.receipt || announcement.attempted || announcement.code))
      effects.push({
        kind: 'delivery-announcement',
        id: announcement.publicationId,
        status: announcement.receipt ? 'published' : announcement.code ? 'held' : 'uncertain',
        receipt: announcement.receipt,
        attempt: announcement.attempted ? announcement.publicationId : undefined,
        code: announcement.code,
      });
  }
  return effects;
}

function deliverySettled(delivery: Record['delivery'] | NonNullable<Record['work']>['delivery']) {
  return (
    !delivery ||
    Boolean(
      delivery.reconciled &&
      delivery.pullRequest &&
      delivery.pushedHead === delivery.binding.head &&
      !delivery.pendingPush &&
      !delivery.contentUpdate &&
      delivery.announcement?.receipt &&
      !delivery.announcement.code &&
      (!('attached' in delivery) || delivery.attached) &&
      (!('cardAttempts' in delivery) || delivery.cardAttempts > 0),
    )
  );
}

export function settledFeedback(event: FeedbackSourceEvent) {
  // a reply alone does not settle implementation, attachment, or an uncertain native turn.
  const turn = event as FeedbackSourceEvent & {
    turn?: { status: string };
    workDelivery?: NonNullable<Record['work']>['delivery'];
  };
  return (
    event.phase === 'published' &&
    Boolean(event.receipt && event.reported) &&
    !event.policyHeld &&
    !event.code &&
    (!turn.turn || turn.turn.status === 'completed') &&
    (!event.work || (event.work.result?.outcome === 'done' && Boolean(turn.workDelivery))) &&
    deliverySettled(turn.workDelivery)
  );
}

/** project terminal or settled detail; archive the original before committing this clone. */
export default function retainDispatchHistory<R extends SharedDispatchRecord>(
  source: R,
): R | undefined {
  if (source.retainedHistory?.terminal) return;
  const record = structuredClone(source) as unknown as Record;
  const events = record.feedback?.events ?? [];
  const nativeTurns = [
    record.firstTurn,
    record.assessmentTurn,
    record.decisionTurn,
    record.summaryRecovery && 'turn' in record.summaryRecovery
      ? record.summaryRecovery.turn
      : undefined,
    record.work?.turn,
    record.work?.deliveryTurn,
  ];
  if (verifiedTerminalCleanup(record)) {
    const retainedHistory = {
      ...record.retainedHistory,
      entries: record.retainedHistory?.entries ?? [],
      terminal: true as const,
      outcome: {
        assessment: record.result?.outcome ?? 'missing',
        implementation: (record.work?.result ?? record.continuation?.result)?.outcome ?? 'missing',
        continuation: record.continuation?.phase,
        code:
          record.blocker ??
          record.retry?.code ??
          record.work?.code ??
          (record.result?.outcome === 'operator-setup-blocker' ? record.result.code : undefined),
        turns: [
          ...nativeTurns,
          ...(record.work?.previousTurns ?? []).map((entry) => entry.turn),
          ...(record.feedback?.events ?? []).map((event) => event.turn),
        ]
          .filter((turn) => turn !== undefined)
          .map((turn) => omit(turn, ['message', 'executionModel'])),
        assessments: (record.directAssessments ?? []).map((entry) => ({
          id: entry.id,
          outcome: entry.result?.outcome ?? 'missing',
        })),
      },
      effects: terminalEffects(record),
      ...(record.sessionCreation?.sessionId ? { sessionId: record.sessionCreation.sessionId } : {}),
      ...((record.delivery ?? record.work?.delivery)?.pullRequest
        ? { pullRequest: (record.delivery ?? record.work?.delivery)!.pullRequest }
        : {}),
    };
    return {
      ...Object.fromEntries(Object.entries(record).filter(([key]) => terminalKeys.has(key))),
      retainedHistory,
    } as unknown as R;
  }
  let changed = false;
  // keep the result that an in-progress implementation is bound to, and unpublished revisions.
  if (record.assessmentHistory?.length) {
    const protectedDigests = new Set([
      record.stageReceipt?.resultDigest,
      record.work?.assessmentDigest,
      record.continuation?.assessmentDigest,
      ...(record.assessmentSummaries ?? [])
        .filter((entry) => !entry.receipt || entry.code)
        .map((entry) => entry.resultDigest),
    ]);
    const keep = record.assessmentHistory.filter((entry) =>
      protectedDigests.has(entry.receipt.resultDigest),
    );
    changed ||= keep.length !== record.assessmentHistory.length;
    record.assessmentHistory = keep;
  }
  if (record.feedback) {
    const current = new Set([
      events.findLast((event) => event.result),
      events.findLast((event) => event.work?.decision),
      events.findLast((event) => event.work?.result),
    ]);
    const removed = events.filter(
      (event) =>
        !current.has(event) && event.id !== record.progression?.workOwner && settledFeedback(event),
    );
    if (removed.length) {
      const ids = new Set(removed.map((event) => event.id));
      record.feedback.events = events.filter((event) => !ids.has(event.id));
      record.feedback.completed = [
        ...(record.feedback.completed ?? []),
        ...removed.map((event) => ({
          id: event.id,
          sourceId: event.sourceId,
          revision: event.revision,
          nodeId: event.nodeId,
          receipt: event.receipt!,
        })),
      ];
      for (const event of removed) {
        const baseline = record.feedback.baseline[event.nodeId];
        if (event.itemType === 'issue' && baseline?.[event.sourceId] === event.source)
          delete baseline[event.sourceId];
      }
      changed = true;
    }
  }
  return changed ? (record as unknown as R) : undefined;
}
