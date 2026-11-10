import { Type, type Static } from 'typebox';
import { automationHash } from './automation-hash.ts';
import { assessmentSummaryPublication } from './assessment-summary.ts';
import { announcementPublication } from './delivery-announcement.ts';
import { managedPullRequest, type ManagedIssue } from './managed-issue.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { ReplyDraft } from './reply-store.ts';
import type { ReplyTarget } from './reply-target.ts';
import {
  isReviewFeedback,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import type { GitHubNotificationCommentPublicationInput } from '../channels/github/publication/comment-publisher.ts';
import type { IssueDeliveryInput } from '../channels/github/publication/issue-delivery.ts';

const text = Type.String({ minLength: 1, maxLength: 65536 });
export const retirementEffectSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    accountId: text,
    kind: Type.Union([Type.Literal('comment'), Type.Literal('delivery')]),
    // Exact provider input, not a task snapshot or authority to repeat the write.
    publication: Type.String({ minLength: 1, maxLength: 256000 }),
    commenterLogin: Type.Optional(text),
    reviewRoot: Type.Optional(Type.Integer({ minimum: 1 })),
    pendingPush: Type.Optional(
      Type.Object({ previousHead: Type.String(), head: text }, { additionalProperties: false }),
    ),
    creationAttempted: Type.Optional(Type.Literal(true)),
    code: Type.Optional(text),
  },
  { additionalProperties: false },
);
export type RetirementEffect = Static<typeof retirementEffectSchema>;
type Record = DispatchRecord & OpenClawDispatchRecord;
type Delivery =
  NonNullable<Record['delivery']> | NonNullable<NonNullable<Record['work']>['delivery']>;

function effect(input: Omit<RetirementEffect, 'id'>): RetirementEffect {
  return { ...input, id: automationHash(input) };
}

export function retirementReplyEffect(draft: ReplyDraft): RetirementEffect | undefined {
  if (!draft.attempted || draft.receipt) return;
  if (!draft.publication) throw new Error('retirement-reply-publication-unresolved');
  const target = JSON.parse(draft.target) as ReplyTarget;
  return effect({
    kind: 'comment',
    accountId: draft.authorNodeId,
    publication: draft.publication,
    commenterLogin: target.source?.author?.login,
    reviewRoot: target.root,
  });
}

export function retirementDeliveryEffects(
  delivery: Delivery | undefined,
  intake: ManagedIssue,
): RetirementEffect[] {
  if (!delivery) return [];
  const effects: RetirementEffect[] = [];
  const creationAttempted = delivery.creationAttempted && !delivery.pullRequest;
  const contentUncertain = delivery.contentUpdate && delivery.contentUpdateAttempted !== false;
  const pendingPush =
    delivery.pendingPush?.head !== delivery.pushedHead ? delivery.pendingPush : undefined;
  if (pendingPush || creationAttempted || contentUncertain) {
    const publication: IssueDeliveryInput = {
      item: {
        number: intake.issue.number,
        itemDatabaseId: intake.issue.databaseId,
        itemNodeId: intake.issue.nodeId,
        repositoryOwner: intake.repository.owner.login,
        repositoryName: intake.repository.name,
        repositoryDefaultBranch: delivery.binding.base,
      },
      repositoryNodeId: delivery.binding.repositoryId,
      branch: delivery.binding.branch,
      headSha: delivery.binding.head,
      expectedPullRequest: delivery.pullRequest,
      adopted: delivery.adopted,
      adoptedPullRequest: managedPullRequest(intake),
      contentUpdate: contentUncertain ? delivery.contentUpdate : undefined,
    };
    effects.push(
      effect({
        kind: 'delivery',
        accountId: intake.receiving.nodeId,
        publication: JSON.stringify(publication),
        pendingPush,
        ...(creationAttempted ? { creationAttempted: true } : {}),
      }),
    );
  }
  const announcement = delivery.announcement;
  if (announcement?.attempted && !announcement.receipt) {
    effects.push(
      effect({
        kind: 'comment',
        accountId: announcement.authorId,
        publication:
          announcement.publication ??
          JSON.stringify(
            announcementPublication(announcement, {
              lifecycleId: managedPullRequest(intake) ? 'pull-request' : 'issue',
              number: intake.issue.number,
              repositoryOwner: intake.repository.owner.login,
              repositoryName: intake.repository.name,
              repositoryNodeId: intake.repository.nodeId,
            }),
          ),
      }),
    );
  }
  return effects;
}

/** retain only attempted effects whose outcome is unknown, independently of task disposal. */
export default function retirementEffects(
  source: SharedDispatchRecord,
  intake: ManagedIssue,
): RetirementEffect[] {
  const record = source as Record;
  const effects: RetirementEffect[] = [];
  for (const summary of record.assessmentSummaries ?? []) {
    if (!summary.attempt || summary.receipt || summary.nativeDenial) continue;
    effects.push(
      effect({
        kind: 'comment',
        accountId: intake.receiving.nodeId,
        publication:
          summary.publication ??
          JSON.stringify(assessmentSummaryPublication(record, intake, summary)),
      }),
    );
  }
  for (const event of record.feedback?.events ?? []) {
    if (!event.publicationAttempted || event.receipt || !event.result?.publicText) continue;
    const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
    const publication: GitHubNotificationCommentPublicationInput = {
      intent: 'github-reply',
      item: {
        lifecycleId: 'issue',
        number: event.number,
        repositoryName: intake.repository.name,
        repositoryOwner: intake.repository.owner.login,
        repositoryNodeId: intake.repository.nodeId,
      },
      source: { commentDatabaseId: source.databaseId, revisionId: event.revision },
      text: event.result.publicText,
    };
    const review = isReviewFeedback(source) && source.feedback.receipt.kind === 'review-comment';
    const reviewRoot = review ? source.feedback.comments[0]?.replyToId : undefined;
    if (review && !reviewRoot) throw new Error('retirement-review-thread-unresolved');
    effects.push(
      effect({
        kind: 'comment',
        accountId: intake.receiving.nodeId,
        publication: JSON.stringify(publication),
        commenterLogin: source.author?.login,
        reviewRoot,
      }),
    );
  }
  for (const delivery of [
    record.delivery,
    record.work?.delivery,
    ...(record.deliveryHistory ?? []),
    ...(record.feedback?.events ?? []).map(
      (event) => (event as { workDelivery?: Delivery }).workDelivery,
    ),
  ])
    effects.push(...retirementDeliveryEffects(delivery, intake));
  return effects;
}
