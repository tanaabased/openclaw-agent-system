import type { DispatchRecord } from './codex-dispatch-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import issueWorkflowProgress from './issue-workflow-progress.ts';
import pendingPublicResponse from './pending-public-response.ts';

type Record = OpenClawDispatchRecord & DispatchRecord;
const terminalKeys = new Set([
  'id',
  'intakeId',
  'manualIssue',
  'issueKey',
  'sourceThreadId',
  'phase',
  'createdAt',
  'manifestDigest',
  'threadId',
  'worktree',
  'retired',
  'retirement',
  'nativeInactive',
  'intakeReportedAt',
  'retainedHistory',
]);

export function validTerminalRecord(record: SharedDispatchRecord) {
  return Boolean(
    record.retainedHistory?.terminal &&
    record.retired &&
    record.retirement &&
    Boolean(record.intakeId) !== Boolean(record.manualIssue) &&
    record.retirement.worktreeRemovedAt !== undefined &&
    (record.retirement.archivedAt !== undefined || record.retirement.sessionUnavailableObserved) &&
    !record.retirement.code &&
    !record.retirement.deadlinePending &&
    record.nativeInactive !== false &&
    Object.keys(record).every((key) => terminalKeys.has(key)),
  );
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

/** project only settled detail; callers archive the original before committing this clone. */
export default function retainDispatchHistory<R extends SharedDispatchRecord>(
  source: R,
): R | undefined {
  if (source.retainedHistory?.terminal) return;
  const record = structuredClone(source) as unknown as Record;
  const live = { ...record, retired: undefined, retirement: undefined, reset: undefined };
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
  const terminal = Boolean(
    record.retired &&
    record.retirement &&
    record.nativeInactive !== false &&
    (record.directAssessments ?? []).every((entry) => entry.result?.outcome === 'plan-ready') &&
    record.retirement.worktreeRemovedAt !== undefined &&
    (record.retirement.archivedAt !== undefined || record.retirement.sessionUnavailableObserved) &&
    !record.retirement.code &&
    !record.retirement.deadlinePending &&
    !pendingPublicResponse(live) &&
    (!record.result || record.result.outcome === 'plan-ready') &&
    (!record.request || record.phase === 'complete') &&
    nativeTurns.every((turn) => !turn || turn.status === 'completed') &&
    ((!record.work && !record.continuation) || issueWorkflowProgress(live).action === 'complete') &&
    deliverySettled(record.delivery ?? record.work?.delivery) &&
    events.every(settledFeedback),
  );
  if (terminal) {
    const retainedHistory = {
      ...record.retainedHistory,
      entries: record.retainedHistory?.entries ?? [],
      terminal: true as const,
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
