import type { Static } from 'typebox';

import type { FeedbackSourceEvent } from './feedback-state.ts';
import type { ReplyTarget } from './reply-target.ts';
import type { AssessmentResult } from './assessment-result.ts';
import type { implementationResultSchema } from './implementation-result.ts';
import feedbackResponse from '../channels/github/presentation/feedback-response.ts';
import { githubNotificationAttributedReplyText } from '../channels/github/publication/publication-contract.ts';
import {
  isReviewFeedback,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import redactFeedback from './feedback-redaction.ts';
import managedOwner from './managed-owner.ts';

export interface ReplyOwner {
  id: string;
  threadId?: string;
  incarnation?: string;
  inactive: boolean;
  retired?: boolean;
  reset?: boolean;
  supersededBy?: string;
  manualIssue?: { fresh?: boolean };
  repository?: string;
  number?: number;
  pullRequestNumber?: number;
  events?: FeedbackSourceEvent[];
  sourceReceipts?: Array<Pick<FeedbackSourceEvent, 'sourceId' | 'nodeId' | 'native'>>;
  deliveredPullRequest?: unknown;
  implementation?: Static<typeof implementationResultSchema>;
  result?: AssessmentResult;
  publisherLogin?: string;
}

/** matching work must return to its real owner, including completed or invalid work. */
export default function replyOwner(
  owners: ReplyOwner[],
  session: string,
  incarnation: string,
  target: ReplyTarget,
  purpose?: 'status-update',
) {
  const repository = `${target.owner}/${target.name}`.toLowerCase();
  const ownership = managedOwner(
    owners,
    session,
    (owner) =>
      owner.repository?.toLowerCase() === repository &&
      (target.number === owner.number ||
        target.number === owner.pullRequestNumber ||
        Boolean(
          target.source &&
          (owner.sourceReceipts ?? owner.events)?.some(
            (event) =>
              event.native &&
              event.nodeId === target.nodeId &&
              event.sourceId === target.source!.nodeId,
          ),
        )),
  );
  if (ownership.status === 'ambiguous') throw new Error('reply-managed-owner-ambiguous');
  const { owner, caller } = ownership;
  if (
    caller &&
    (caller.inactive ||
      caller.retired ||
      caller.reset ||
      (caller.incarnation && caller.incarnation !== incarnation))
  )
    throw new Error('reply-managed-context-invalid');
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
        assessment: owner.result,
        implementation: owner.implementation,
        delivery: owner.deliveredPullRequest,
        feedback: owner.events?.flatMap((event) =>
          event.result || event.work?.result
            ? [
                {
                  eventId: event.id,
                  result: event.result,
                  work: event.work?.result,
                  receipt: event.receipt,
                },
              ]
            : [],
        ),
      },
    };
  if (target.source) {
    const matching = owner.events?.filter(
      (event) => event.nodeId === target.nodeId && event.sourceId === target.source!.nodeId,
    );
    const event = matching?.at(-1);
    if (!event) return manualContext(owner);
    if (event.native || (!event.publicationAttempted && !event.receipt))
      return manualContext(owner);
    if (!event.result || event.phase === 'blocked')
      throw new Error('reply-managed-response-required');
    if (event.receipt) {
      const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
      if (!source.author || source.nodeId !== event.sourceId || !event.result.publicText)
        throw new Error('reply-managed-context-invalid');
      const inline = isReviewFeedback(source) && source.feedback.receipt.kind === 'review-comment';
      const root = inline ? source.feedback.comments[0]?.replyToId : undefined;
      if (inline && !root) throw new Error('reply-managed-context-invalid');
      const url = `${target.destination.split('#')[0]}#${root ? 'discussion_r' : 'issuecomment-'}${event.receipt.databaseId}`;
      return {
        status: 'managed-reply-retained' as const,
        id: owner.id,
        eventId: event.id,
        digest: undefined,
        selection: event.composition,
        retainedResult: event.result,
        receipt: event.receipt,
        url,
        presentation: feedbackResponse({
          privateText: event.result.privateText,
          publicReply: {
            author: owner.publisherLogin,
            text: githubNotificationAttributedReplyText(
              event.result.publicText,
              source.author.login,
              redactFeedback,
            ),
          },
          publication: { url },
        }),
        instruction:
          'Show this retained private response and confirmed public quote. This operation only reads the owning result and receipt; do not resume, recompose, implement or publish it again.',
      };
    }
    return {
      status: 'managed-reply-required' as const,
      id: owner.id,
      eventId: event.id,
      digest: undefined,
      route: 'feedback',
      operation: event.receipt ? 'context' : event.publicationAttempted ? 'reconcile' : 'compose',
      selection: event.composition,
      retainedResult: event.result,
      receipt: event.receipt,
      instruction:
        'Reuse this exact managed feedback route and retained response. The owning route verifies current source and authority. If its previous run ended, use supported owner resume with explicit user direction; never fall back to manual reply or repeat implementation.',
    };
  }
  return manualContext(owner);
}

/** A new requested comment is independent of earlier summary and delivery effects. */
function manualContext(owner: ReplyOwner) {
  return {
    status: 'manual-reply-context' as const,
    workflow: 'issue-assignment' as const,
    ownerId: owner.id,
    verifiedOutcome: {
      assessment: owner.result,
      implementation: owner.implementation,
      delivery: owner.deliveredPullRequest,
    },
  };
}
