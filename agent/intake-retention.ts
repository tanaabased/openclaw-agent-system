import type IntakeRecordStore from '../channels/github/intake/record-store.ts';
import type DispatchStore from './dispatch-state.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { issueKey } from './dispatch-pending.ts';
import { checkRetainedCount, packRetained } from './retained-history.ts';

/** commit dispatch evidence first; interruption can leave redundancy, never lost replay fences. */
export default async function compactIntakeHistory<R extends SharedDispatchRecord>(
  intake: IntakeRecordStore,
  dispatch: DispatchStore<R>,
) {
  const snapshot = await dispatch.read();
  if (!snapshot.records.length) return;
  if (
    snapshot.records.some((record) => !record.retained && dispatch.contract.settledRecord?.(record))
  )
    await dispatch.exclusive(async (_state, save) => save(), true);
  const committed = await dispatch.read();
  const terminal = new Map(
    committed.records
      .filter((record) => record.retained || dispatch.contract.settledRecord?.(record))
      .map((record) => [record.intakeId, record]),
  );
  if (!terminal.size) return;
  await intake.exclusive(async (state, save) => {
    if (!state) return;
    const completed = state.records.flatMap((record) => {
      const key = issueKey(record);
      const exact = terminal.get(record.id);
      if (exact?.issueKey === key) return [{ record, dispatchRecord: exact }];
      // Earlier admissions cannot outlive committed retirement ordering. Keep any
      // admission still referenced by another (possibly unresolved) native record.
      if (committed.records.some((entry) => entry.intakeId === record.id)) return [];
      const retired = [...terminal.values()].findLast(
        (entry) =>
          entry.issueKey === key && Date.parse(record.assignment.createdAt) <= entry.retirement!.at,
      );
      return retired ? [{ record, dispatchRecord: retired }] : [];
    });
    if (!completed.length) return;
    const history = [...(state.history ?? [])];
    checkRetainedCount(history.length + completed.length, 'intake', completed[0]!.record.id);
    for (const { record, dispatchRecord } of completed) {
      history.push({
        id: record.id,
        issueKey: issueKey(record),
        assignmentAt: record.assignment.createdAt,
        retiredAt: dispatchRecord.retirement!.at,
        dispatchId: dispatchRecord.id,
        evidence: packRetained(record, record.id),
      });
    }
    state.history = history;
    const completedIds = new Set(completed.map(({ record }) => record.id));
    state.records = state.records.filter((record) => !completedIds.has(record.id));
    await save(state);
  });
}
