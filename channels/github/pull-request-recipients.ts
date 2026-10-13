import type {
  GitHubIdentityPin,
  GitHubNotificationsConfiguration,
  GitHubPullRequestRecipient,
} from './config-schema.ts';
import { githubIdentitySet } from './provider/work-item.ts';

export function legacyPullRequestRecipients(
  configuration: GitHubNotificationsConfiguration['pullRequest'],
): GitHubPullRequestRecipient[] {
  const assignees = configuration?.assignees ?? 'assignment-actor';
  return [
    ...(assignees === 'assignment-actor'
      ? [{ source: 'assignment-actor' as const, roles: ['assignee' as const] }]
      : assignees.map((identity) => ({ ...identity, roles: ['assignee' as const] }))),
    ...(configuration?.reviewers ?? []).map((identity) => ({
      ...identity,
      roles: ['reviewer' as const],
    })),
  ];
}

export default function resolvePullRequestRecipients(
  entries: readonly GitHubPullRequestRecipient[] | undefined,
  actor?: GitHubIdentityPin,
) {
  const recipients = githubIdentitySet(
    (entries ?? [{ source: 'assignment-actor', roles: ['assignee'] }]).map((entry) => {
      if ('source' in entry && !actor)
        throw new Error(
          'The original assignment actor identity is unavailable for pull request delivery.',
        );
      return {
        ...('source' in entry ? actor! : { login: entry.login, nodeId: entry.nodeId }),
        roles: [...entry.roles],
      };
    }),
    (left, right) => ({ ...left, roles: [...new Set([...left.roles, ...right.roles])] }),
  );
  const assignees = recipients
    .filter((entry) => entry.roles.includes('assignee'))
    .map(({ login, nodeId }) => ({ login, nodeId }));
  if (assignees.length > 10) throw new Error('github-delivery-assignee-limit');
  return {
    assignees,
    reviewers: recipients
      .filter((entry) => entry.roles.includes('reviewer'))
      .map(({ login, nodeId }) => ({ login, nodeId })),
  };
}
