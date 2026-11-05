import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import type { GitHubRepositoryIdentity } from '../channels/github/provider/work-item.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import repositoryScope from '../channels/github/repository-scope.ts';

/** provider evidence only; a matching scope does not authorize assignment or work. */
export default async function issuePickupScope(
  policy: GitHubNotificationPolicy,
  client: GitHubNotificationIntakeClient,
  repository: GitHubRepositoryIdentity,
) {
  const name = `${repository.owner.login}/${repository.name}`.toLowerCase();
  const project = policy.issuePickup?.projects.find(
    (entry) => entry.repository.toLowerCase() === name,
  );
  if (
    !project ||
    repository.archived ||
    repository.disabled ||
    repositoryScope(policy, repository, 'issue-pickup').decision === 'deny'
  )
    return;
  if (!client.getMilestone) throw new Error('issue-pickup-milestone-unavailable');
  const milestone = await client.getMilestone(
    repository.owner.login,
    repository.name,
    project.milestone.number,
  );
  if (milestone.number !== project.milestone.number)
    throw new Error('issue-pickup-milestone-changed');
  if (milestone.state !== 'open') throw new Error('issue-pickup-milestone-closed');
  return milestone;
}
