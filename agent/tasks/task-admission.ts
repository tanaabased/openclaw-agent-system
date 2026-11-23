import { dispatchAdmission, managedTargetUrl, type ManagedIssue } from './managed-issue.ts';
import type { SharedDispatchRecord } from './dispatch/dispatch-state.ts';
import type { ReviewAdmission } from './review/review-admission.ts';

export type TaskAdmission = ManagedIssue | ReviewAdmission;

/** shared conversation/resource consumers preserve the actual origin; never invent an assignment. */
export function taskAdmission(record: SharedDispatchRecord, issues: readonly ManagedIssue[]) {
  return record.reviewAdmission ?? dispatchAdmission(record, issues);
}

export function taskTarget(admission: TaskAdmission) {
  return 'origin' in admission
    ? `https://github.com/${admission.repository.owner.login}/${admission.repository.name}/pull/${admission.issue.number}`
    : managedTargetUrl(admission);
}
