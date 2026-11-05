import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import type { ImplementationResult } from './implementation-result.ts';
import type { ReplyOwner } from './reply-owner.ts';

/** project common reply obligations; native adapters supply only custody and lifecycle evidence. */
export default function replyOwnerContext(input: {
  conversation?: boolean;
  record: SharedDispatchRecord & {
    feedback?: {
      events: FeedbackSourceEvent[];
      completed?: Array<Pick<FeedbackSourceEvent, 'sourceId' | 'nodeId' | 'native'>>;
    };
  };
  intake?: Pick<IntakeRecord, 'repository' | 'issue' | 'receiving'>;
  caller: string;
  incarnation?: string;
  custodyInvalid: boolean;
  delivery?: {
    adopted?: unknown;
    pushedHead?: string;
    pullRequest?: { pullRequestNodeId: string; pullRequestNumber: number };
  };
  implementation?: ImplementationResult;
}): ReplyOwner {
  const { record, intake, delivery } = input;
  const observationOnly = Boolean(delivery?.adopted && !delivery.pushedHead);
  if (!intake && record.threadId === input.caller) throw new Error('reply-managed-context-invalid');
  return {
    id: record.id,
    threadId: record.threadId,
    ...(input.incarnation ? { incarnation: input.incarnation } : {}),
    retired: !input.conversation && Boolean(record.retired),
    reset: Boolean(record.reset),
    supersededBy: record.supersededBy,
    manualIssue: record.manualIssue?.fresh ? { fresh: true } : undefined,
    inactive: Boolean(
      (!input.conversation && record.retired) ||
      record.supersededBy ||
      (!input.conversation && record.retirement) ||
      record.reset ||
      (record.threadId && input.custodyInvalid),
    ),
    repository: intake ? `${intake.repository.owner.login}/${intake.repository.name}` : undefined,
    number: intake?.issue.number,
    pullRequestNumber:
      record.pullRequestLink !== undefined
        ? record.pullRequestLink?.pullRequestNumber
        : (delivery?.pullRequest?.pullRequestNumber ??
          record.retainedHistory?.pullRequest?.pullRequestNumber),
    events: record.feedback?.events,
    sourceReceipts: record.feedback && [
      ...(record.feedback.completed ?? []),
      ...record.feedback.events,
    ],
    implementation: input.implementation,
    deliveredPullRequest: observationOnly ? undefined : delivery?.pullRequest,
    result: record.result,
    publisherLogin: intake?.receiving.login,
  };
}
