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

/** repairs never inherit reply or operator grants. */
export function repairIdentities(policy: GitHubNotificationPolicy): GitHubIdentityPin[] {
  const feedback = policy.issueAssignment?.feedback;
  if (!feedback || typeof feedback !== 'object' || !feedback.repairs) return [];
  const replies = feedbackIdentities(policy.issueAssignment?.allowed ?? [], feedback);
  const repairs = githubIdentitySet(feedback.repairs.allowed);
  if (
    repairs.some(
      (actor) =>
        !replies.some(
          (reply) =>
            reply.nodeId === actor.nodeId &&
            reply.login.toLowerCase() === actor.login.toLowerCase(),
        ),
    )
  )
    throw new Error('github-notification-repair-author-not-admitted');
  return repairs;
}

export function allowsFeedbackRepair(policy: GitHubNotificationPolicy, actor: GitHubIdentityPin) {
  return repairIdentities(policy).some(
    (pin) => pin.nodeId === actor.nodeId && pin.login.toLowerCase() === actor.login.toLowerCase(),
  );
}
