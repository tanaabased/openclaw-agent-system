import { automationHash } from './automation-hash.ts';
import type { GitHubNotificationPolicy } from '../channels/github/config-schema.ts';

/** scheduling controls do not change the effects granted by an activated workflow. */
export function notificationAuthority(policy: GitHubNotificationPolicy) {
  return {
    schemaVersion: policy.schemaVersion,
    runtimes: policy.runtimes,
    cleanup: { enabled: policy.cleanup?.enabled ?? true },
    allowedRepositoryOwners: policy.allowedRepositoryOwners,
    issueAssignment: policy.issueAssignment,
    reviewRequest: policy.reviewRequest,
  };
}

export function notificationAuthorityDigest(policy: GitHubNotificationPolicy | undefined) {
  return automationHash(policy ? notificationAuthority(policy) : null);
}

/** unchanged older receipts remain usable without silently widening their original grant. */
export function matchesNotificationAuthority(digest: string, policy: GitHubNotificationPolicy) {
  return digest === notificationAuthorityDigest(policy) || digest === automationHash(policy);
}
