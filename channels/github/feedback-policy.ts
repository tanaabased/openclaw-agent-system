import { githubIdentitySet } from './provider/work-item.ts';
import type {
  GitHubFeedbackPolicy,
  GitHubIdentityPin,
  GitHubNotificationPolicy,
} from './config-schema.ts';

function configuredFeedbackIdentities(
  allowed: readonly GitHubIdentityPin[],
  feedback: GitHubFeedbackPolicy | undefined,
): GitHubIdentityPin[] {
  if (feedback === false) return [];
  return [
    ...(feedback === undefined || feedback === true || feedback.inherit ? allowed : []),
    ...(typeof feedback === 'object' ? feedback.allowed : []),
  ];
}

/** resolve one workflow's current feedback grants without granting operator access. */
export function feedbackIdentities(
  allowed: readonly GitHubIdentityPin[],
  feedback: GitHubFeedbackPolicy | undefined,
): GitHubIdentityPin[] {
  const identities = configuredFeedbackIdentities(allowed, feedback);
  try {
    return githubIdentitySet(identities.map(({ login, nodeId }) => ({ login, nodeId })));
  } catch {
    throw new Error('github-notification-feedback-identity-conflict');
  }
}

/** feedback machinery belongs to its parent, even when no authors are approved. */
export function workflowFeedbackAvailable(
  policy: GitHubNotificationPolicy | undefined,
  workflow: 'issue-assignment' | 'review-request',
) {
  const selected =
    workflow === 'issue-assignment' ? policy?.issueAssignment : policy?.reviewRequest;
  return Boolean(selected);
}

/** admission windows follow configured authors; source authorization still requires resolved pins. */
export function workflowFeedbackAccepting(
  policy: GitHubNotificationPolicy | undefined,
  workflow: 'issue-assignment' | 'review-request',
) {
  const selected =
    workflow === 'issue-assignment' ? policy?.issueAssignment : policy?.reviewRequest;
  return Boolean(
    workflowFeedbackAvailable(policy, workflow) &&
    selected &&
    configuredFeedbackIdentities(selected.allowed, selected.feedback).length,
  );
}
