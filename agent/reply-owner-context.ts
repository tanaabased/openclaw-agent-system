import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { DeliveryAnnouncementState } from './delivery-announcement-state.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import type { ReplyOwner } from './reply-owner.ts';
/** project common reply obligations; native adapters supply only custody and lifecycle evidence. */
export default function replyOwnerContext(input: {
  conversation?: boolean;
  record: SharedDispatchRecord & {
    feedback?: {
      events: FeedbackSourceEvent[];
      completed?: Array<Pick<FeedbackSourceEvent, 'sourceId' | 'nodeId'>>;
    };
  };
  intake?: Pick<IntakeRecord, 'repository' | 'issue' | 'receiving'>;
  caller: string;
  incarnation?: string;
  custodyInvalid: boolean;
  delivery?: {
    adopted?: unknown;
    pushedHead?: string;
    pullRequest?: {
      pullRequestNodeId: string;
      pullRequestNumber: number;
    };
    announcement?: DeliveryAnnouncementState;
    announcementRecovery?: unknown;
  };
}): ReplyOwner {
  const { record, intake, delivery } = input;
  const observationOnly = Boolean(delivery?.adopted && !delivery.pushedHead);
  const announcement = delivery?.announcement;
  const destination = intake
    ? `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/${record.manualIssue?.pullRequest ? 'pull' : 'issues'}/${intake.issue.number}`
    : undefined;
  if (!intake && record.threadId === input.caller) throw new Error('reply-managed-context-invalid');
  return {
    id: record.id,
    threadId: record.threadId,
    ...(input.incarnation ? { incarnation: input.incarnation } : {}),
    reset: Boolean(record.reset),
    supersededBy: record.supersededBy,
    manualIssue: record.manualIssue?.fresh ? { fresh: true } : undefined,
    inactive: Boolean(
      record.supersededBy ||
      record.retirement ||
      record.reset ||
      (record.threadId && input.custodyInvalid),
    ),
    repository: intake ? `${intake.repository.owner.login}/${intake.repository.name}` : undefined,
    number: intake?.issue.number,
    pullRequestNumber:
      record.pullRequestLink !== undefined
        ? record.pullRequestLink?.pullRequestNumber
        : delivery?.pullRequest?.pullRequestNumber,
    events: record.feedback?.events,
    sourceReceipts: record.feedback && [
      ...(record.feedback.completed ?? []),
      ...record.feedback.events,
    ],
    deliveredPullRequest: observationOnly ? undefined : delivery?.pullRequest,
    ...(destination &&
    announcement?.receipt &&
    announcement.publicText &&
    announcement.authorId === intake?.receiving.nodeId &&
    !announcement.code &&
    !delivery?.announcementRecovery
      ? {
          announcement: {
            destination,
            url: `${destination}#issuecomment-${announcement.receipt.databaseId}`,
            publicText: announcement.publicText,
          },
        }
      : {}),
    publisherLogin: intake?.receiving.login,
  };
}
