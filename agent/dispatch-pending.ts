import type { IntakeObservation, IntakeRecord } from '../channels/github/intake/record-store.ts';
import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { ManagedIssue } from './managed-issue.ts';
export function issueKey(
  record: Pick<IntakeRecord, 'scope' | 'receiving' | 'repository' | 'issue'>,
) {
  return automationHash([
    record.scope,
    record.receiving.nodeId,
    record.repository.nodeId,
    record.issue.nodeId,
  ]);
}
/** count and select the same pending issues, not their historical assignment events. */
export default function pendingDispatchAssignments<R extends SharedDispatchRecord>(
  state: {
    records: R[];
  },
  intake: {
    records: ManagedIssue[];
    observedAssignments?: IntakeObservation[];
  },
) {
  const latest = new Map<string, IntakeRecord>();
  for (const item of intake.records) if (item.assignment) latest.set(issueKey(item), item);
  return [...latest].flatMap(([key, item]) => {
    if (
      intake.observedAssignments?.some(
        (entry) =>
          entry.consumedThrough !== undefined &&
          issueKey(entry) === key &&
          Date.parse(item.assignment.createdAt) <= entry.consumedThrough,
      )
    )
      return [];
    const consumed = intake.observedAssignments?.find((entry) => entry.id === item.id)?.consumedBy;
    if (consumed) {
      const owner = state.records.find(
        (entry) => entry.id === consumed && entry.intakeId === item.id,
      );
      return owner &&
        !owner.retirement &&
        !owner.reset &&
        !owner.supersededBy &&
        !owner.handoff &&
        !owner.effective
        ? [{ intake: item, record: owner }]
        : [];
    }
    const matching = state.records.filter(
      (record) =>
        record.issueKey === key &&
        (!record.manualIssue ||
          record.intakeId === item.id ||
          record.retirement ||
          record.reset ||
          (record.manualIssue && !record.manualIssue.assignmentAttempt?.event)),
    );
    const previous = matching.findLast((record) => !record.manualIssue?.fresh) ?? matching.at(-1);
    if (previous?.manualIssue && !previous.retirement && !previous.reset) return [];
    if (previous?.retirement) {
      return previous.retirement.reason === 'chat-archived' &&
        previous.nativeInactive &&
        item.id !== previous.retirement.intakeId
        ? [{ intake: item, record: undefined }]
        : [];
    }
    const retiredAt =
      previous?.retirement?.operatorRequest?.at ?? previous?.retirement?.at ?? previous?.reset?.at;
    if (previous && retiredAt !== undefined) {
      return item.id !== previous.intakeId &&
        (item.assignment ? Date.parse(item.assignment.createdAt) : item.admittedAt) > retiredAt
        ? [{ intake: item, record: undefined }]
        : [];
    }
    return previous?.handoff || previous?.effective ? [] : [{ intake: item, record: previous }];
  });
}
