import { Type, type Static } from 'typebox';

import type {
  GitHubCanonicalWorkItem,
  GitHubRepositoryIdentity,
} from '../channels/github/provider/work-item.ts';

const ref = Type.String({ minLength: 1, maxLength: 255 });
export const manualPullRequestSchema = Type.Object(
  {
    headRef: ref,
    baseRef: ref,
    headSha: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
    repositoryNodeId: Type.String({ minLength: 1 }),
    repositoryDatabaseId: Type.Integer({ minimum: 1 }),
    authorId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ManualPullRequest = Static<typeof manualPullRequestSchema>;

/** operator adoption fixes the remote destination, not the executing account or local branch. */
export default function manualPullRequest(
  repo: GitHubRepositoryIdentity,
  item: GitHubCanonicalWorkItem,
  previous?: ManualPullRequest,
): ManualPullRequest {
  if (item.itemType !== 'pull-request' || item.state !== 'open' || item.pullRequest.merged)
    throw new Error('launch-open-pull-request-required');
  const pr = item.pullRequest;
  if (
    pr.headRepositoryNodeId !== repo.nodeId ||
    pr.baseRepositoryNodeId !== repo.nodeId ||
    pr.headRepositoryDatabaseId !== repo.databaseId ||
    pr.baseRepositoryDatabaseId !== repo.databaseId
  )
    throw new Error('launch-same-repository-pull-request-required');
  if (!/^[a-f0-9]{40,64}$/u.test(pr.headSha) || !pr.author?.nodeId)
    throw new Error('launch-pull-request-binding-unavailable');
  const binding = {
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    headSha: pr.headSha,
    repositoryNodeId: repo.nodeId,
    repositoryDatabaseId: repo.databaseId,
    authorId: pr.author.nodeId,
  };
  if (
    previous &&
    Object.entries(previous).some(
      ([key, value]) => key !== 'headSha' && binding[key as keyof ManualPullRequest] !== value,
    )
  )
    throw new Error('launch-pull-request-binding-changed');
  return binding;
}
