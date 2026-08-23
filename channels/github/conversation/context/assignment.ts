export interface GitHubNotificationAssignmentContextInput {
  lifecycleContext: Readonly<Record<string, unknown>>;
}

/** Project the untrusted context attached to an assignment receipt. */
export default function githubNotificationAssignmentContext(
  input: GitHubNotificationAssignmentContextInput,
) {
  return { ...input.lifecycleContext };
}
