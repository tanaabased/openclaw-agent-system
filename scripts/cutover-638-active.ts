import nativeDispatchRecord, {
  obsoleteDispatchFields,
  obsoleteWorkFields,
  obsoleteFeedbackFields,
} from '../agent/native-dispatch-record.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import { settledFeedback } from '../agent/retain-dispatch-history.ts';

type Record = DispatchRecord & OpenClawDispatchRecord;

/** the cutover owner transfers external effects from source before committing this projection. */
export default function cutover638Active<R extends SharedDispatchRecord>(source: R) {
  const original = source as unknown as Record;
  const record = nativeDispatchRecord(source, true) as unknown as Record;
  const pending: string[] = [];
  if (!record.threadId || !record.worktree || !record.request) pending.push('native-creation');
  if (original.result?.outcome === 'operator-setup-blocker') pending.push('assessment-blocker');
  if (
    original.continuation?.result?.outcome === 'blocked' ||
    original.work?.result?.outcome === 'blocked'
  )
    pending.push('implementation-blocker');
  for (const key of ['attempt', 'publicationAttempt'] as const)
    if (original.continuation?.[key] && !original.continuation[key].ended)
      pending.push('native-' + key);
  if (original.previousSummaryAttempts?.some((attempt) => !attempt.ended))
    pending.push('native-previous-summary');
  if (record.nativeTurns?.some(({ turn }) => turn.status !== 'completed'))
    pending.push('native-turn');
  if (original.nativeRequests?.length)
    pending.push(...original.nativeRequests.map(({ kind }) => 'native-' + kind));
  if (original.autoDecision && !original.autoDecision.ended) pending.push('native-decision');
  if (original.summaryRecovery && !original.summaryRecovery.ended) pending.push('native-summary');

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

export function cutover638Compatibility(source: SharedDispatchRecord) {
  const record = source as Record;
  return [
    ...obsoleteDispatchFields.filter((key) => record[key] !== undefined),
    ...obsoleteWorkFields
      .filter((key) => record.work?.[key] !== undefined)
      .map((key) => 'work.' + key),
    ...obsoleteFeedbackFields
      .filter((key) => record.feedback?.events.some((event) => Object.hasOwn(event, key)))
      .map((key) => 'feedback.events.' + key),
  ];
}
