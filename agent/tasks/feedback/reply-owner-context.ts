import type { IntakeRecord } from '../../../channels/github/intake/record-store.ts';
import type { SharedDispatchRecord } from '../dispatch/dispatch-state.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import type { ReplyOwner } from './reply-owner.ts';
/** project common reply obligations; native adapters supply only custody and lifecycle evidence. */
export default function replyOwnerContext(input: {
  conversation?: boolean;
  record: SharedDispatchRecord & {
    feedback?: {
      events: FeedbackSourceEvent[];
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
  };
}): ReplyOwner {
  const { record, intake, delivery } = input;
  const observationOnly = Boolean(delivery?.adopted && !delivery.pushedHead);
  const announcement = record.announcement;
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
    deliveredPullRequest: observationOnly ? undefined : delivery?.pullRequest,
    ...(destination &&
    announcement?.receipt &&
    announcement.authorId === intake?.receiving.nodeId &&
    !announcement.code &&
    !record.announcementRecovery
      ? {
          announcement: {
            destination,
            url: `${destination}#issuecomment-${announcement.receipt.databaseId}`,
          },
        }
      : {}),
    publisherLogin: intake?.receiving.login,
  };
}
