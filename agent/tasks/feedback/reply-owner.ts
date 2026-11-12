import type { FeedbackSourceEvent } from './feedback-state.ts';
import managedOwner from '../managed-owner.ts';
import type { ReplyTarget } from './reply-target.ts';
export interface ReplyOwner {
  id: string;
  threadId?: string;
  incarnation?: string;
  inactive: boolean;
  reset?: boolean;
  supersededBy?: string;
  manualIssue?: {
    fresh?: boolean;
  };
  repository?: string;
  number?: number;
  pullRequestNumber?: number;
  events?: FeedbackSourceEvent[];
  deliveredPullRequest?: unknown;
  announcement?: {
    destination: string;
    url: string;
  };
  publisherLogin?: string;
}
/** caller custody and exact retained replies are protected, not exclusive destinations. */
export default function replyOwner(
  owners: ReplyOwner[],
  session: string,
  incarnation: string,
  target: ReplyTarget,
  purpose?: 'status-update',
) {
  const repository = `${target.owner}/${target.name}`.toLowerCase();
  const callers = owners.filter((owner) => owner.threadId === session);
  if (callers.length > 1) throw new Error('reply-managed-owner-ambiguous');
  const caller = callers[0];
  if (
    caller &&
    (caller.inactive || caller.reset || (caller.incarnation && caller.incarnation !== incarnation))
  )
    throw new Error('reply-managed-context-invalid');
  if (!purpose) {
    return caller &&
      caller.repository?.toLowerCase() === repository &&
      (caller.number === target.number ||
        caller.pullRequestNumber === target.number ||
        caller.events?.some(
          (event) => event.nodeId === target.nodeId && event.sourceId === target.source?.nodeId,
        ))
      ? manualContext(caller, target)
      : undefined;
  }
  const callerIssue =
    caller?.repository?.toLowerCase() === repository && caller.pullRequestNumber === target.number
      ? caller.number
      : undefined;
  const ownership = managedOwner(
    owners,
    session,
    (owner) =>
      owner.repository?.toLowerCase() === repository &&
      (target.number === owner.number ||
        (target.number === owner.pullRequestNumber &&
          (callerIssue === undefined || owner.number === callerIssue)) ||
        Boolean(
          target.source &&
          owner.events?.some(
            (event) => event.nodeId === target.nodeId && event.sourceId === target.source!.nodeId,
          ),
        )),
  );
  if (ownership.status === 'ambiguous') throw new Error('reply-managed-owner-ambiguous');
  const { owner } = ownership;
  if (!owner) {
    if (ownership.status === 'historical' || (purpose && caller))
      throw new Error('reply-managed-owner-required');
    return;
  }
  if (
    owner.inactive ||
    owner.threadId !== session ||
    (owner.incarnation && owner.incarnation !== incarnation)
  )
    throw new Error('reply-managed-owner-required');
  if (purpose)
    return {
      status: 'status-update-context' as const,
      workflow: 'issue-assignment' as const,
      ownerId: owner.id,
      pullRequestNumber: owner.pullRequestNumber,
      verifiedOutcome: {
        delivery: owner.deliveredPullRequest,
        ...announcementOutcome(owner, target),
      },
    };
  return manualContext(owner, target);
}
/** a caller's own outcomes may inform composition without granting publication authority. */
function manualContext(owner: ReplyOwner, target: ReplyTarget) {
  return {
    status: 'manual-reply-context' as const,
    workflow: 'issue-assignment' as const,
    ownerId: owner.id,
    verifiedOutcome: {
      delivery: owner.deliveredPullRequest,
      ...announcementOutcome(owner, target),
    },
  };
}
function announcementOutcome(owner: ReplyOwner, target: ReplyTarget) {
  return owner.announcement && owner.announcement.destination === target.destination
    ? { announcement: owner.announcement }
    : {};
}
