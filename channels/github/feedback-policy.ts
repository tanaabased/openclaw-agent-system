import type {
  GitHubFeedbackPolicy,
  GitHubIdentityPin,
  GitHubNotificationPolicy,
} from './config-schema.ts';

/** resolve one workflow's current feedback grants without granting operator access. */
export function feedbackIdentities(
  allowed: readonly GitHubIdentityPin[],
  feedback: GitHubFeedbackPolicy | undefined,
): GitHubIdentityPin[] {
  if (!feedback) return [];
  const identities = [
    ...(feedback === true || feedback.inherit ? allowed : []),
    ...(typeof feedback === 'object' ? feedback.allowed : []),
  ];
  const nodes = new Map<string, GitHubIdentityPin>();
  const logins = new Map<string, string>();
  for (const { login, nodeId } of identities) {
    const normalized = login.toLowerCase();
    const previous = nodes.get(nodeId);
    if (
      (previous && previous.login.toLowerCase() !== normalized) ||
      (logins.has(normalized) && logins.get(normalized) !== nodeId)
    )
      throw new Error('github-notification-feedback-identity-conflict');
    nodes.set(nodeId, { login: previous?.login ?? login, nodeId });
    logins.set(normalized, nodeId);
  }
  return [...nodes.values()];
}

/** the admitted owner selects the scope, including an issue's verified delivery pr. */
export function allowsWorkflowFeedback(
  policy: GitHubNotificationPolicy,
  workflow: 'issue-assignment' | 'review-request',
  actor: GitHubIdentityPin,
): boolean {
  const owner = workflow === 'issue-assignment' ? policy.issueAssignment : policy.reviewRequest;
  return feedbackIdentities(owner?.allowed ?? [], owner?.feedback).some(
    (identity) =>
      identity.nodeId === actor.nodeId &&
      identity.login.toLowerCase() === actor.login.toLowerCase(),
  );
}
