import { feedbackIdentities, repairIdentities } from '../channels/github/feedback-policy.ts';
import { automationHash } from './automation-hash.ts';
import type { GitHubNotificationPolicy } from '../channels/github/config-schema.ts';

/** scheduling controls do not change the effects granted by an activated workflow. */
export function legacyNotificationAuthority(policy: GitHubNotificationPolicy) {
  return {
    schemaVersion: policy.schemaVersion,
    runtimes: policy.runtimes,
    cleanup: { enabled: policy.cleanup?.enabled ?? true },
    allowedRepositoryOwners: policy.allowedRepositoryOwners,
    issueAssignment: policy.issueAssignment,
    reviewRequest: policy.reviewRequest,
  };
}

/** canonicalize only schema-owned sets; guidance and ordered data retain their meaning. */
function ordered<T>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => {
    const left = automationHash(a),
      right = automationHash(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function notificationAuthority(policy: GitHubNotificationPolicy) {
  const value = structuredClone(legacyNotificationAuthority(policy));
  value.runtimes = ordered(value.runtimes);
  value.allowedRepositoryOwners = ordered(value.allowedRepositoryOwners);
  for (const workflow of [value.issueAssignment, value.reviewRequest]) {
    if (!workflow) continue;
    workflow.allowed = ordered(workflow.allowed);
    if (workflow.feedback && typeof workflow.feedback === 'object') {
      workflow.feedback.allowed = ordered(workflow.feedback.allowed);
      if (workflow.feedback.repairs)
        workflow.feedback.repairs.allowed = ordered(workflow.feedback.repairs.allowed);
    }
  }
  const recipients = value.issueAssignment?.pullRequest?.recipients;
  if (recipients)
    value.issueAssignment!.pullRequest!.recipients = ordered(
      recipients.map((recipient) => ({ ...recipient, roles: ordered(recipient.roles) })),
    );
  return value;
}

export function notificationAuthorityDigest(policy: GitHubNotificationPolicy | undefined) {
  return automationHash(policy ? notificationAuthority(policy) : null);
}

/** unchanged older receipts remain usable without silently widening their original grant. */
export function matchesNotificationAuthority(digest: string, policy: GitHubNotificationPolicy) {
  return (
    digest === notificationAuthorityDigest(policy) ||
    digest === automationHash(legacyNotificationAuthority(policy)) ||
    digest === automationHash(policy)
  );
}

/** a reply grant cannot become implementation authority or inherit unrelated workflow settings. */
function feedbackAuthority(policy: GitHubNotificationPolicy) {
  return {
    effect: 'feedback-reply',
    schemaVersion: policy.schemaVersion,
    runtimes: policy.runtimes,
    allowedRepositoryOwners: policy.allowedRepositoryOwners,
    enabled: policy.issueAssignment?.enabled !== false,
    authors: feedbackIdentities(
      policy.issueAssignment?.allowed ?? [],
      policy.issueAssignment?.feedback,
    ),
  };
}

export function feedbackAuthorityDigest(policy: GitHubNotificationPolicy) {
  const value = feedbackAuthority(policy);
  return automationHash({
    ...value,
    runtimes: ordered(value.runtimes),
    allowedRepositoryOwners: ordered(value.allowedRepositoryOwners),
    authors: ordered(value.authors),
  });
}

export function matchesFeedbackAuthority(digest: string, policy: GitHubNotificationPolicy) {
  return (
    digest === feedbackAuthorityDigest(policy) ||
    digest === automationHash(feedbackAuthority(policy)) ||
    matchesNotificationAuthority(digest, policy)
  );
}

/** no legacy reply digest can authorize code changes. */
export function repairAuthorityDigest(policy: GitHubNotificationPolicy) {
  const feedback = policy.issueAssignment?.feedback;
  return automationHash({
    effect: 'feedback-repair-existing-pr/v1',
    schemaVersion: policy.schemaVersion,
    runtimes: ordered(policy.runtimes),
    owners: ordered(policy.allowedRepositoryOwners),
    enabled: policy.issueAssignment?.enabled !== false,
    authors: ordered(repairIdentities(policy)),
    assessment: typeof feedback === 'object' ? feedback.repairs?.skill : undefined,
    guidance: typeof feedback === 'object' ? feedback.repairs?.guidance : undefined,
    implementation: policy.issueAssignment?.implementation,
  });
}
