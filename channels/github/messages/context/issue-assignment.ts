import type { GitHubNotificationPlanningContext } from '../../lib/work-event-client.ts';
import { githubNotificationItemUrl } from '../presentation/assignment-card.ts';

export interface GitHubNotificationIssueContextInput {
  context: GitHubNotificationPlanningContext;
  item: Parameters<typeof githubNotificationItemUrl>[0] & { itemType: 'issue' };
}

/** Build bounded untrusted issue evidence for one planning turn. */
export default function githubNotificationIssueContext(input: GitHubNotificationIssueContextInput) {
  return {
    label: 'GitHub issue context',
    payload: structuredClone(input.context),
    source: githubNotificationItemUrl(input.item),
    type: 'github_issue' as const,
  };
}
