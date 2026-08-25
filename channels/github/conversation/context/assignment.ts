export interface GitHubNotificationAssignmentContextInput {
  lifecycleContext: Readonly<Record<string, unknown>>;
}

/** Project the untrusted context attached to an assignment receipt. */
export default function githubNotificationAssignmentContext(
  input: GitHubNotificationAssignmentContextInput,
) {
  return {
    label: 'GitHub lifecycle context',
    payload: { ...input.lifecycleContext },
    source: 'agent-system',
    type: 'github_lifecycle_context',
  };
}
