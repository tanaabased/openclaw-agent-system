import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import { automationHash } from './automation-hash.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';

/** canonicalize only schema-owned sets; guidance and ordered data retain their meaning. */
function ordered<T>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => {
    const left = automationHash(a),
      right = automationHash(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function notificationAuthority(policy: GitHubNotificationPolicy) {
  const value = structuredClone({
    schemaVersion: policy.schemaVersion,
    runtimes: policy.runtimes,
    allowedRepositoryOwners: policy.routing === undefined ? policy.allowedRepositoryOwners : [],
    ...(policy.routing === undefined ? {} : { routing: policy.routing }),
    issueAssignment: policy.issueAssignment,
    reviewRequest: policy.reviewRequest,
    ...(policy.projectPickup
      ? { projectPickup: { ...policy.projectPickup, paused: undefined } }
      : {}),
  });
  value.runtimes = ordered(value.runtimes);
  value.allowedRepositoryOwners = ordered(value.allowedRepositoryOwners);
  for (const workflow of [value.issueAssignment, value.reviewRequest]) {
    if (!workflow) continue;
    delete workflow.paused;
    workflow.allowed = ordered(workflow.allowed);
    if (workflow.feedback && typeof workflow.feedback === 'object')
      workflow.feedback.allowed = ordered(workflow.feedback.allowed);
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

/** cache key for reevaluating observed sources when live feedback eligibility changes. */
function feedbackAuthority(policy: GitHubNotificationPolicy) {
  return {
    effect: 'feedback-reply',
    schemaVersion: policy.schemaVersion,
    runtimes: policy.runtimes,
    allowedRepositoryOwners: policy.routing === undefined ? policy.allowedRepositoryOwners : [],
    ...(policy.routing === undefined ? {} : { routing: policy.routing }),
    enabled: Boolean(policy.issueAssignment),
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
