import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import type {
  GitHubCanonicalWorkItem,
  GitHubRepositoryIdentity,
} from '../channels/github/provider/work-item.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import repositoryScope from '../channels/github/repository-scope.ts';
import { pickupMilestones, pickupProject } from '../channels/github/issue-pickup-projects.ts';

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
export default async function issuePickupScope(
  policy: GitHubNotificationPolicy,
  client: GitHubNotificationIntakeClient,
  repository: GitHubRepositoryIdentity,
): Promise<PickupScope | undefined> {
  const name = `${repository.owner.login}/${repository.name}`.toLowerCase();
  const project = pickupProject(policy.issuePickup?.projects ?? [], name);
  if (
    !project ||
    repository.archived ||
    repository.disabled ||
    repositoryScope(policy, repository, 'issue-pickup').decision === 'deny'
  )
    return;
  if (!project.milestone) return { policy: 'all', milestoneNodeIds: [] };
  if (!client.getMilestone) throw new Error('issue-pickup-milestone-unavailable');
  const references = pickupMilestones(project);
  const numbers: number[] = [];
  const milestoneNodeIds: string[] = [];
  for (const reference of references) {
    const [owner, repo] = reference.repository.split('/') as [string, string];
    if (reference.repository !== name) {
      const target = await client.getRepository(owner, repo);
      if (`${target.owner.login}/${target.name}`.toLowerCase() !== reference.repository)
        throw new Error('issue-pickup-milestone-changed');
    }
    const number = reference.number;
    const milestone = await client.getMilestone(owner, repo, number);
    if (milestone.number !== number) throw new Error('issue-pickup-milestone-changed');
    if (milestone.state !== 'open') throw new Error('issue-pickup-milestone-closed');
    if (reference.repository === name) {
      numbers.push(number);
      milestoneNodeIds.push(milestone.nodeId);
    }
  }
  const mode = project.milestone.policy ?? 'only';
  return {
    policy: mode,
    milestoneNodeIds,
    ...(mode === 'only' && numbers.length === 1 ? { discoveryMilestone: numbers[0] } : {}),
  };
}
