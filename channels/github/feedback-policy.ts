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
  if (feedback === false) return [];
  const identities = [
    ...(feedback === undefined || feedback === true || feedback.inherit ? allowed : []),
    ...(typeof feedback === 'object' ? feedback.allowed : []),
  ];
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
  return Boolean(selected && selected.enabled !== false);
}

/** retained admission windows describe eligible sources, not a separate enable switch. */
export function workflowFeedbackAccepting(
  policy: GitHubNotificationPolicy | undefined,
  workflow: 'issue-assignment' | 'review-request',
) {
  const selected =
    workflow === 'issue-assignment' ? policy?.issueAssignment : policy?.reviewRequest;
  return Boolean(
    workflowFeedbackAvailable(policy, workflow) &&
    selected &&
    feedbackIdentities(selected.allowed, selected.feedback).length,
  );
}
