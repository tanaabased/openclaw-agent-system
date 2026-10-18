import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { IntakeRecord, IntakeState } from '../channels/github/intake/record-store.ts';

export function issueKey(record: IntakeRecord) {
  return automationHash([
    record.scope,
    record.receiving.nodeId,
    record.repository.nodeId,
    record.issue.nodeId,
  ]);
}

/** count and select the same pending issues, not their historical assignment events. */
export default function pendingDispatchAssignments<R extends SharedDispatchRecord>(
  state: { records: R[] },
  intake: IntakeState,
  unresolvedRetirement: (record: R) => boolean = () => false,
) {
  const latest = new Map<string, IntakeRecord>();
  for (const item of intake.records) latest.set(issueKey(item), item);
  return [...latest].flatMap(([key, item]) => {
    if (state.records.some((record) => record.issueKey === key && unresolvedRetirement(record)))
      return [];
    const previous = state.records.findLast((record) => record.issueKey === key);
    const retiredAt = previous?.retired?.at ?? previous?.reset?.at;
    if (previous && retiredAt !== undefined) {
      return item.id !== previous.intakeId && Date.parse(item.assignment.createdAt) > retiredAt
        ? [{ intake: item, record: undefined }]
        : [];
    }
    return previous?.handoff || previous?.effective ? [] : [{ intake: item, record: previous }];
  });
}
