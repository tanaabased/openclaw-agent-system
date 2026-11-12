import taskPullRequest from './task-pull-request.ts';
import type { SharedDispatchRecord } from '../../dispatch-state.ts';
import { Type, type Static } from 'typebox';

import { automationHash } from '../../automation-hash.ts';
import { dispatchRetryDeadline, dispatchRetryLimit } from '../../dispatch-retry.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';
import { managedPullRequest, type ManagedIssue } from '../../managed-issue.ts';
import workflowFailure from '../../workflow-failure.ts';
import { providerDiagnosticSchema } from '../../../utils/provider-diagnostic.ts';
import type { IssueAnnouncementInput } from '../../../channels/github/publication/issue-delivery.ts';

const time = Type.Integer({ minimum: 0 });
export const announcementRecoverySchema = Type.Object(
  {
    binding: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    code: Type.String({ minLength: 1, maxLength: 128 }),
    phase: Type.Union([Type.Literal('prerequisite'), Type.Literal('response')]),
    attempts: Type.Integer({ minimum: 1, maximum: dispatchRetryLimit }),
    firstFailedAt: time,
    lastFailedAt: time,
    retryAfter: Type.Optional(time),
    status: Type.Union([
      Type.Literal('retrying'),
      Type.Literal('needs-attention'),
      Type.Literal('exhausted'),
      Type.Literal('stopped'),
    ]),
    providerDiagnostic: Type.Optional(providerDiagnosticSchema),
  },
  { additionalProperties: false },
);
export type AnnouncementRecovery = Static<typeof announcementRecoverySchema>;
export interface AnnouncementDelivery {
  announcement?: DeliveryAnnouncementState;
  announcementRecovery?: AnnouncementRecovery;
}

export function announcementBinding(publication: IssueAnnouncementInput) {
  return automationHash({
    repository: publication.repositoryNodeId,
    issue: publication.item.itemNodeId,
    pullRequest: publication.expectedPullRequest,
    adopted: Boolean(publication.adoptedPullRequest),
  });
}

/** failure metadata is separate from the candidate and never changes its preview identity. */
export function retainAnnouncementFailure(
  delivery: AnnouncementDelivery,
  publication: IssueAnnouncementInput | string,
  error: unknown,
  now: number,
  phase: AnnouncementRecovery['phase'],
) {
  const observed = workflowFailure(error, 'delivery-announcement-failed');
  const failure = {
    ...observed,
    code:
      /^(?:delivery|dispatch|continuation|github|git|intake|session|private-state|workflow|implementation)-[a-z0-9-]+$/.test(
        observed.code,
      ) || ['denied', 'cancelled', 'authority-revoked'].includes(observed.code)
        ? observed.code
        : 'delivery-announcement-failed',
  };
  const binding = typeof publication === 'string' ? publication : announcementBinding(publication);
  const previous = delivery.announcementRecovery;
  const same = previous?.binding === binding;
  const attempts = Math.min(dispatchRetryLimit, (same ? previous.attempts : 0) + 1);
  const stopped =
    /(?:cancelled|authority-revoked)$/.test(failure.code) ||
    /^(?:delivery|dispatch|continuation|implementation)-.*denied$/.test(failure.code) ||
    (failure.code.endsWith('denied') && !failure.providerDiagnostic);
  const retryable =
    !stopped &&
    (Boolean(delivery.announcement?.attempted || delivery.announcement?.receipt) ||
      failure.code === 'github-delivery-linkage-unverified' ||
      failure.code === 'delivery-announcement-unconfirmed' ||
      ['transport', 'rate-limit', 'authentication', 'permission'].includes(
        failure.providerDiagnostic?.classification ?? '',
      ));
  const status = stopped
    ? 'stopped'
    : !retryable
      ? 'needs-attention'
      : attempts >= dispatchRetryLimit
        ? 'exhausted'
        : 'retrying';
  delivery.announcementRecovery = {
    binding,
    ...failure,
    phase,
    attempts,
    firstFailedAt: same ? previous.firstFailedAt : now,
    lastFailedAt: now,
    status,
    ...(status === 'retrying'
      ? { retryAfter: dispatchRetryDeadline(attempts, now, failure.providerDiagnostic) }
      : {}),
  };
  return delivery.announcementRecovery;
}

/** due means a read-only check, never permission to send a model turn or repeat a write. */
export function announcementRecoveryAction(
  delivery: AnnouncementDelivery | undefined,
  now: number,
) {
  const recovery = delivery?.announcementRecovery;
  if (!recovery) {
    const code = delivery?.announcement?.code;
    if (!code) return 'ready' as const;
    if (/(?:denied|cancelled|authority-revoked)$/.test(code)) return 'wait' as const;
    return delivery?.announcement?.attempted ||
      delivery?.announcement?.receipt ||
      ['github-delivery-linkage-unverified', 'delivery-announcement-unconfirmed'].includes(code)
      ? ('check' as const)
      : ('wait' as const);
  }
  return recovery.status === 'retrying' &&
    recovery.retryAfter !== undefined &&
    recovery.retryAfter <= now
    ? ('check' as const)
    : ('wait' as const);
}

export function retainedAnnouncementPublication(
  intake: ManagedIssue,
  record: Pick<SharedDispatchRecord, 'announcement' | 'pullRequestLink'> &
    Parameters<typeof taskPullRequest>[0],
  signal?: AbortSignal,
): IssueAnnouncementInput {
  // An attempted comment remains bound to its original PR after relinking or unlinking.
  const expectedPullRequest =
    record.announcement?.attempted || record.announcement?.receipt
      ? record.announcement.snapshot
      : taskPullRequest(record);
  if (!expectedPullRequest) throw new Error('delivery-announcement-binding-required');
  return {
    item: {
      number: intake.issue.number,
      itemDatabaseId: intake.issue.databaseId,
      itemNodeId: intake.issue.nodeId,
      repositoryOwner: intake.repository.owner.login,
      repositoryName: intake.repository.name,
    },
    repositoryNodeId: intake.repository.nodeId,
    expectedPullRequest,
    adoptedPullRequest: managedPullRequest(intake),
    signal,
  };
}
