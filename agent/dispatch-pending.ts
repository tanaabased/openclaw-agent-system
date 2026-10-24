import type { ManagedIssue } from './managed-issue.ts';
import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';

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
  state: { records: R[] },
  intake: { records: ManagedIssue[] },
  unresolvedRetirement: (record: R) => boolean = () => false,
) {
  const latest = new Map<string, IntakeRecord>();
  for (const item of intake.records) if (item.assignment) latest.set(issueKey(item), item);
  return [...latest].flatMap(([key, item]) => {
    if (state.records.some((record) => record.issueKey === key && unresolvedRetirement(record)))
      return [];
    const previous = state.records.findLast((record) => record.issueKey === key);
    if (previous?.manualIssue && !previous.retired && !previous.retirement && !previous.reset)
      return [];
    if (previous?.retirement && !previous.retired) {
      return previous.retirement.reason === 'chat-archived' &&
        previous.nativeInactive &&
        item.id !== previous.retirement.intakeId
        ? [{ intake: item, record: undefined }]
        : [];
    }
    const retiredAt =
      previous?.retirement?.operatorRequest?.at ??
      previous?.retirement?.at ??
      previous?.retired?.at ??
      previous?.reset?.at;
    if (previous && retiredAt !== undefined) {
      return item.id !== previous.intakeId &&
        (item.assignment ? Date.parse(item.assignment.createdAt) : item.admittedAt) > retiredAt
        ? [{ intake: item, record: undefined }]
        : [];
    }
    return previous?.handoff || previous?.effective ? [] : [{ intake: item, record: previous }];
  });
}
