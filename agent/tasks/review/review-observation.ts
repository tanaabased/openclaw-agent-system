import { githubIdentityMatches } from '../../../channels/github/provider/work-item.ts';
import type GitHubWorkEventClient from '../../../channels/github/provider/work-event-client.ts';
import type { GitHubNotificationPolicy } from '../../../channels/github/workflow-policy.ts';
import repositoryScope from '../../../channels/github/repository-scope.ts';
import type { ReviewAdmission } from './review-admission.ts';

/** live provider facts decide readiness; a saved CI result never authorizes publication. */
export default async function observeReview(
  admission: ReviewAdmission,
  client: Pick<GitHubWorkEventClient, 'identity' | 'getItem' | 'getRepository' | 'getReviewCI'> & {
    reviewRequests: Pick<GitHubWorkEventClient['reviewRequests'], 'current'>;
  },
  policy: GitHubNotificationPolicy,
  retained = false,
) {
  if (!githubIdentityMatches(client.identity, admission.receiving))
    throw new Error('review-receiver-changed');
  if (!policy.reviewRequest && admission.origin.kind !== 'operator')
    throw new Error('review-request-disabled');
  const { owner, name } = admission.repository;
  const repository = await client.getRepository(owner.login, name);
  const item = await client.getItem(owner.login, name, admission.issue.number);
  if (
    repository.nodeId !== admission.repository.nodeId ||
    repository.databaseId !== admission.repository.databaseId ||
    repository.archived ||
    repository.disabled ||
    item.nodeId !== admission.issue.nodeId ||
    item.databaseId !== admission.issue.databaseId ||
    item.itemType !== 'pull-request'
  )
    throw new Error('review-resource-identity-changed');
  if (item.state !== 'open' || item.pullRequest.merged)
    return { status: 'closed' as const, item, repository };
  if (
    !item.pullRequest.author ||
    !githubIdentityMatches(item.pullRequest.author, admission.author) ||
    githubIdentityMatches(item.pullRequest.author, client.identity)
  )
    throw new Error('review-author-identity-changed');
  if (
    admission.origin.kind !== 'operator' &&
    repositoryScope(policy, repository, 'review-request').decision === 'deny'
  )
    throw new Error('review-request-repository-excluded');
  if (admission.origin.kind === 'request') {
    const origin = admission.origin;
    if (
      !policy.reviewRequest!.allowed.some((actor) => githubIdentityMatches(actor, origin.requester))
    )
      throw new Error('review-request-requester-unapproved');
    if (!retained) {
      const request = await client.reviewRequests.current(owner.login, name, item.number);
      if (
        !request ||
        request.nodeId !== origin.eventId ||
        !githubIdentityMatches(request.requester, origin.requester)
      )
        return { status: 'removed' as const, item, repository };
    }
  }
  if (item.pullRequest.draft) return { status: 'draft' as const, item, repository };
  const ci = await client.getReviewCI(owner.login, name, item.number, item.pullRequest.headSha);
  return {
    status: ci.state === 'running' ? ('waiting-ci' as const) : ('ready' as const),
    item,
    repository,
    ci,
  };
}
