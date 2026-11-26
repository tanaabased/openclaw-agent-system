import type GitHubWorkEventClient from '../../../channels/github/provider/work-event-client.ts';
import { githubRepositoryPath } from '../../../channels/github/provider/work-item.ts';
import repositoryScope from '../../../channels/github/repository-scope.ts';
import type { GitHubNotificationPolicy } from '../../../channels/github/workflow-policy.ts';
import workflowFailure from '../workflow-failure.ts';
import { admitReview, type ReviewAdmission } from './review-admission.ts';

export default async function discoverReviews(
  client: Pick<
    GitHubWorkEventClient,
    'discoverReviewRequests' | 'getRepository' | 'getItem' | 'identity'
  > & {
    reviewRequests: Pick<GitHubWorkEventClient['reviewRequests'], 'current'>;
  },
  policy: GitHubNotificationPolicy,
  binding: Pick<ReviewAdmission, 'scope' | 'workspaceDir' | 'agentId'>,
  now: number,
  signal: AbortSignal,
  retain: (admission: ReviewAdmission) => Promise<void>,
) {
  const obstacles: Array<{ code: string }> = [];
  for (let page = 1; ;) {
    const result = await client.discoverReviewRequests(page);
    if (result.incomplete) throw new Error('review-discovery-incomplete');
    for (const candidate of result.candidates) {
      try {
        const { owner, name } = githubRepositoryPath(candidate.repositoryPath);
        const repository = await client.getRepository(owner!, name!);
        if (repositoryScope(policy, repository, 'review-request').decision === 'deny') continue;
        const item = await client.getItem(owner!, name!, candidate.number);
        const request = await client.reviewRequests.current(owner!, name!, candidate.number);
        if (
          !request ||
          !policy.reviewRequest?.allowed.some(
            (actor) =>
              actor.nodeId === request.requester.nodeId &&
              actor.login.toLowerCase() === request.requester.login.toLowerCase(),
          )
        )
          continue;
        const admission = admitReview({
          ...binding,
          identity: client.identity,
          repository,
          item,
          request,
          policy,
          now,
        });
        await retain(admission);
      } catch (error) {
        signal.throwIfAborted();
        obstacles.push({
          code: workflowFailure(error, 'review-request-observation-failed').code,
        });
      }
    }
    if (!result.nextPage || result.nextPage === 1) break;
    if (page >= 10) throw new Error('review-discovery-incomplete'); // GitHub search exposes at most 1,000 results.
    page = result.nextPage;
  }
  return obstacles;
}
