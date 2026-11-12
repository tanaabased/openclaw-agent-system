import type { SharedDispatchRecord } from '../../dispatch-state.ts';

// Original creation evidence is required by the native custody readers until resources are gone.
const keys = new Set([
  'id',
  'intakeId',
  'manualIssue',
  'issueKey',
  'sourceThreadId',
  'createdAt',
  'manifestDigest',
  'threadId',
  'worktree',
  'request',
  'project',
  'receiptThreadId',
  'sessionCreation',
  'worktreeAttemptId',
  'separateCheckout',
  'predecessorId',
  'supersededBy',
  'retirement',
  'nativeInactive',
  'lifecycleCheckedAt',
  'lifecyclePending',
  'assignmentObservation',
  'cleanupPending',
]);

/** once cleanup is committed, its original custody evidence is the only remaining task data. */
export default function pendingRetirement(record: SharedDispatchRecord) {
  if (!record.retirement) throw new Error('retirement-intent-required');
  record.cleanupPending = true;

  for (const key of Object.keys(record))
    if (!keys.has(key)) delete record[key as keyof SharedDispatchRecord];
}

export function validPendingRetirement(record: SharedDispatchRecord) {
  return Boolean(
    record.cleanupPending && record.retirement && Object.keys(record).every((key) => keys.has(key)),
  );
}
