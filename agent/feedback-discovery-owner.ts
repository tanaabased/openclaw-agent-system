import { automationHash } from './automation-hash.ts';

export interface FeedbackDiscoveryOwner {
  id: string;
  intakeId?: string;
  threadId?: string;
  sourceThreadId?: string;
  sessionCreation?: { sessionId?: string };
  retired?: unknown;
  retirement?: unknown;
  reset?: unknown;
  supersededBy?: unknown;
  delivery?: { pullRequest?: unknown };
  work?: { delivery?: { pullRequest?: unknown } };
  feedback?: unknown;
}

/** only routing, lifecycle and concurrent feedback changes invalidate a discovery snapshot. */
export default function feedbackDiscoveryOwner(record: FeedbackDiscoveryOwner) {
  return automationHash({
    id: record.id,
    intakeId: record.intakeId,
    threadId: record.threadId,
    sourceThreadId: record.sourceThreadId,
    sessionId: record.sessionCreation?.sessionId,
    retired: record.retired,
    retirement: record.retirement,
    reset: record.reset,
    supersededBy: record.supersededBy,
    pullRequest: record.delivery?.pullRequest ?? record.work?.delivery?.pullRequest,
    feedback: record.feedback,
  });
}
