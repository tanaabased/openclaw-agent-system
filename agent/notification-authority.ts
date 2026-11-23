import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import { normalizeRepositoryRouting } from '../channels/github/repository-scope.ts';
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
    routing: normalizeRepositoryRouting(policy.routing),
    issueAssignment: policy.issueAssignment,
    reviewRequest: policy.reviewRequest,
    ...(policy.issuePickup
      ? // this projection is hashed into retained receipts; keep its serialized key stable.
        { projectPickup: { ...policy.issuePickup, paused: undefined } }
      : {}),
  });
  value.runtimes = ordered(value.runtimes);
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
function feedbackAuthority(
  policy: GitHubNotificationPolicy,
  workflow: 'issue-assignment' | 'review-request',
) {
  const settings = workflow === 'review-request' ? policy.reviewRequest : policy.issueAssignment;
  return {
    effect: 'feedback-reply',
    schemaVersion: policy.schemaVersion,
    runtimes: policy.runtimes,
    routing: normalizeRepositoryRouting(policy.routing),
    enabled: Boolean(settings),
    authors: feedbackIdentities(settings?.allowed ?? [], settings?.feedback),
  };
}

export function feedbackAuthorityDigest(
  policy: GitHubNotificationPolicy,
  workflow: 'issue-assignment' | 'review-request' = 'issue-assignment',
) {
  const value = feedbackAuthority(policy, workflow);
  return automationHash({
    ...value,
    runtimes: ordered(value.runtimes),
    authors: ordered(value.authors),
  });
}
