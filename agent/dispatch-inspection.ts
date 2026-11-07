import { Type, type Static } from 'typebox';

import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { FeedbackSourceState } from './feedback-state.ts';
import issueLaunchTarget from './issue-launch-target.ts';
import { dispatchAdmission, managedPullRequest, type ManagedIssue } from './managed-issue.ts';
import workflowStatus from './workflow-status.ts';

export const dispatchInspectionProperties = {
  id: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  target: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  summary: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
};
type Inspection = {
  [K in keyof typeof dispatchInspectionProperties]?: Static<
    (typeof dispatchInspectionProperties)[K]
  >;
};
type Inspectable = SharedDispatchRecord & {
  feedback?: FeedbackSourceState;
  delivery?: { pullRequest?: { pullRequestNumber: number } };
  work?: { delivery?: { pullRequest?: { pullRequestNumber: number } } };
};

/** inspect saved observations only; selection never reads providers or changes lifecycle state. */
export default function dispatchInspection<R extends Inspectable>(
  records: readonly R[],
  admitted: readonly ManagedIssue[],
  query: Inspection,
) {
  const bounded = Object.keys(query).some((key) => key in dispatchInspectionProperties);
  const target = query.target ? issueLaunchTarget(query.target) : undefined;
  if (query.target && !target) throw new Error('dispatch-inspection-qualified-target-required');
  const selected = records.filter((record) => {
    if (query.id && record.id !== query.id) return false;
    if (!target) return true;
    const source = dispatchAdmission(record, admitted);
    if (
      !source ||
      `${source.repository.owner.login}/${source.repository.name}`.toLowerCase() !==
        target.repository.toLowerCase()
    )
      return false;
    const kind = target.itemType ?? 'issue';
    const pr = record.work?.delivery?.pullRequest ?? record.delivery?.pullRequest;
    return (
      ((managedPullRequest(source) ? 'pull-request' : 'issue') === kind &&
        source.issue.number === target.number) ||
      (kind === 'pull-request' && pr?.pullRequestNumber === target.number)
    );
  });
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 12;
  const page = bounded ? selected.slice(offset, offset + limit) : selected;
  return {
    records: page,
    summary: query.summary ?? bounded,
    ...(bounded
      ? {
          total: selected.length,
          ...(offset + page.length < selected.length ? { nextOffset: offset + page.length } : {}),
        }
      : {}),
  };
}

export function dispatchInspectionSummary(record: Inspectable) {
  const feedback = record.feedback;
  return {
    id: record.id,
    intakeId: record.intakeId,
    phase: record.phase,
    workflowStatus: workflowStatus(record),
    threadId: record.threadId,
    lifecycleCheckedAt: record.lifecycleCheckedAt,
    lifecyclePending: record.lifecyclePending,
    retirement: record.retirement && {
      reason: record.retirement.reason,
      code: record.retirement.code,
    },
    retired: record.retired,
    feedback: feedback && {
      scannedTime: feedback.scannedTime,
      discoveryPending: feedback.discoveryPending,
      code: feedback.code,
      discoveryStalls: feedback.discoveryStalls,
      checkpoints: Object.keys(feedback.discovery ?? {}).length,
    },
  };
}
