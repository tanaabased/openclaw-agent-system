import { githubIdentitySet } from './provider/work-item.ts';
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
  try {
    return githubIdentitySet(identities.map(({ login, nodeId }) => ({ login, nodeId })));
  } catch {
    throw new Error('github-notification-feedback-identity-conflict');
  }
}

/** current workflow enablement and configured authors control new feedback admission. */
export function workflowFeedbackEnabled(
  policy: GitHubNotificationPolicy | undefined,
  workflow: 'issue-assignment' | 'review-request',
) {
  const selected =
    workflow === 'issue-assignment' ? policy?.issueAssignment : policy?.reviewRequest;
  return Boolean(
    selected &&
    selected.enabled !== false &&
    feedbackIdentities(selected.allowed, selected.feedback).length,
  );
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
