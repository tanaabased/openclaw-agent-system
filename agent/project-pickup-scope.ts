import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import type { GitHubRepositoryIdentity } from '../channels/github/provider/work-item.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import repositoryScope from '../channels/github/repository-scope.ts';

/** provider evidence only; a matching scope does not authorize assignment or work. */
export default async function projectPickupScope(
  policy: GitHubNotificationPolicy,
  client: GitHubNotificationIntakeClient,
  repository: GitHubRepositoryIdentity,
) {
  const project = policy.projectPickup?.projects[0];
  if (
    !project ||
    repository.archived ||
    repository.disabled ||
    project.repository.toLowerCase() !==
      `${repository.owner.login}/${repository.name}`.toLowerCase() ||
    repositoryScope(policy, repository, 'project-pickup').decision === 'deny'
  )
    return;
  if (!client.getMilestone) throw new Error('project-pickup-milestone-unavailable');
  const milestone = await client
    .getMilestone(repository.owner.login, repository.name, project.milestone.number)
    .catch((error: unknown) => {
      if (error instanceof GitHubWorkEventClientError) {
        const diagnostic = error.providerDiagnostic;
        if (diagnostic?.httpStatus === 404)
          throw new Error('project-pickup-milestone-missing-or-inaccessible', { cause: error });
        if (diagnostic?.classification === 'permission')
          throw new Error('project-pickup-milestone-inaccessible', { cause: error });
      }
      throw error;
    });
  if (milestone.number !== project.milestone.number)
    throw new Error('project-pickup-milestone-changed');
  if (milestone.state !== 'open') throw new Error('project-pickup-milestone-closed');
  return milestone;
}
