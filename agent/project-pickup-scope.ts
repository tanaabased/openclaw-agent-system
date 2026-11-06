import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import type {
  GitHubCanonicalWorkItem,
  GitHubRepositoryIdentity,
} from '../channels/github/provider/work-item.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import repositoryScope from '../channels/github/repository-scope.ts';

export interface PickupScope {
  policy: 'all' | 'only' | 'prefer';
  milestoneNodeIds: string[];
  discoveryMilestone?: number;
}
export type PickupCandidateScope = 'all' | 'only' | 'preferred' | 'fallback';

export function pickupCandidateScope(
  scope: PickupScope,
  item: GitHubCanonicalWorkItem,
): PickupCandidateScope | undefined {
  if (scope.policy === 'all') return 'all';
  const member =
    item.itemType === 'issue' &&
    item.milestone?.state === 'open' &&
    scope.milestoneNodeIds.includes(item.milestone.nodeId);
  if (scope.policy === 'only') return member ? 'only' : undefined;
  return member ? 'preferred' : 'fallback';
}

/** provider evidence only; a matching scope does not authorize assignment or work. */
export default async function projectPickupScope(
  policy: GitHubNotificationPolicy,
  client: GitHubNotificationIntakeClient,
  repository: GitHubRepositoryIdentity,
): Promise<PickupScope | undefined> {
  const name = `${repository.owner.login}/${repository.name}`.toLowerCase();
  const project = policy.projectPickup?.projects.find(
    (entry) => entry.repository.toLowerCase() === name,
  );
  if (
    !project ||
    repository.archived ||
    repository.disabled ||
    repositoryScope(policy, repository, 'project-pickup').decision === 'deny'
  )
    return;
  if (!project.milestone) return { policy: 'all', milestoneNodeIds: [] };
  if (!client.getMilestone) throw new Error('project-pickup-milestone-unavailable');
  const numbers = Array.isArray(project.milestone.number)
    ? project.milestone.number
    : [project.milestone.number];
  const milestoneNodeIds: string[] = [];
  for (const number of numbers) {
    const milestone = await client.getMilestone(repository.owner.login, repository.name, number);
    if (milestone.number !== number) throw new Error('project-pickup-milestone-changed');
    if (milestone.state !== 'open') throw new Error('project-pickup-milestone-closed');
    milestoneNodeIds.push(milestone.nodeId);
  }
  const mode = project.milestone.policy ?? 'only';
  return {
    policy: mode,
    milestoneNodeIds,
    ...(mode === 'only' && numbers.length === 1 ? { discoveryMilestone: numbers[0] } : {}),
  };
}
