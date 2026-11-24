import reviewPublisher from '../../../channels/github/publication/review-publisher.ts';
import type { GitHubNotificationPolicy } from '../../../channels/github/workflow-policy.ts';
import type { Static } from 'typebox';
import type { reviewRequestSchema } from '../../../tools/dispatch/review-schema.ts';
import { automationHash } from '../../automation-hash.ts';
import redactFeedback from '../feedback/feedback-redaction.ts';
import type { SharedDispatchRecord } from '../dispatch/dispatch-state.ts';
import type GitHubWorkEventClient from '../../../channels/github/provider/work-event-client.ts';
import observeReview from './review-observation.ts';
import { reviewTarget } from './review-context.ts';

/** Both adapters verify native custody and hold the review record lock before publication. */
export default async function publishOwnedReview(
  owned: SharedDispatchRecord,
  input: Static<typeof reviewRequestSchema>,
  turnId: string,
  client: Parameters<typeof observeReview>[1] & {
    reviews: Pick<GitHubWorkEventClient['reviews'], 'getReviewComments' | 'listReviews' | 'submit'>;
  },
  policy: GitHubNotificationPolicy,
  fresh: () => Promise<void>,
  save: () => Promise<void>,
) {
  const observed = await observeReview(owned.reviewAdmission!, client, policy, true);
  if (input.operation === 'publish' && !turnId) throw new Error('review-native-turn-unavailable');
  if (input.operation === 'publish' && observed.status !== 'ready')
    throw new Error('review-publication-not-ready');
  if (
    input.operation === 'publish' &&
    (!owned.reviewPublication?.attempted ||
      (owned.reviewPublication.receipt && owned.reviewPublication.turnId !== turnId))
  ) {
    if (!input.draft) throw new Error('review-draft-required');
    owned.reviewPublication = {
      head: owned.reviewAdmission!.head,
      turnId,
      draft: structuredClone(input.draft),
      attempted: false,
    };
    await save();
  }
  const publication = owned.reviewPublication;
  if (!publication) return { status: 'no-publication' };
  if (input.draft && automationHash(input.draft) !== automationHash(publication.draft))
    throw new Error('review-publication-candidate-changed');
  if (publication.rejected) throw new Error('review-publication-denied');
  const admission = owned.reviewAdmission!;
  const publisher = reviewPublisher(
    {
      item: {
        lifecycleId: 'pull-request-review',
        repositoryOwner: admission.repository.owner.login,
        repositoryName: admission.repository.name,
        repositoryNodeId: admission.repository.nodeId,
        number: admission.issue.number,
      },
      head: publication.head,
      draft: publication.draft,
      publicationId: publication.turnId ? automationHash([owned.id, publication.turnId]) : owned.id,
    },
    {
      connect: async () => client,
      redactText: redactFeedback,
      exclusive: async (_key, run) => run(),
      authorize: async () => {
        await fresh();
        const live = await observeReview(admission, client, policy, true);
        if (live.status !== 'ready' && !(publication.attempted && live.status === 'waiting-ci'))
          throw new Error('review-publication-not-ready');
        if (
          !publication.attempted &&
          owned.reviewObservation !== live.fingerprint &&
          owned.reviewObservation !== live.legacyFingerprint
        )
          throw new Error('review-publication-evidence-changed');
        return { authorized: true };
      },
      beforeCreate: async () => {
        publication.attempted = true;
        await save();
      },
      onCreateRejected: async () => {
        publication.rejected = true;
        await save();
      },
    },
  );
  const result =
    publication.attempted || input.operation === 'reconcile'
      ? await publisher.reconcile()
      : await publisher.publish();
  if (!result)
    return {
      status: 'publication-uncertain',
      instruction: 'Reconcile the original submission; do not post another review.',
    };
  publication.receipt = {
    databaseId: result.receipt.databaseId,
    nodeId: result.receipt.nodeId,
  };
  await save();
  return {
    status: result.status,
    url: `${reviewTarget(owned)}#pullrequestreview-${result.receipt.databaseId}`,
  };
}
