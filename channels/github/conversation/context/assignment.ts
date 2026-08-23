import type { GitHubNotificationItemContext } from '../../provider/work-event-client.ts';

export interface GitHubNotificationAssignmentContextInput {
  itemContext?: GitHubNotificationItemContext;
  lifecycleContext: Readonly<Record<string, unknown>>;
}

/** Project the untrusted context attached to an assignment receipt. */
export default function githubNotificationAssignmentContext(
  input: GitHubNotificationAssignmentContextInput,
) {
  return {
    ...(input.itemContext === undefined ? {} : { currentItem: input.itemContext }),
    ...input.lifecycleContext,
  };
}
