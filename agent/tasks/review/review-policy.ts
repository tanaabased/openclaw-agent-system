import type { AgentManifest } from '../../../manifest/types.ts';
import { notificationAuthorityDigest } from '../../notification-authority.ts';

/** retained review conversations use review policy without granting issue-assignment authority. */
export default function reviewPolicy(
  manifest: AgentManifest,
  runtime: 'codex' | 'openclaw',
  retained = false,
) {
  const policy = manifest.github?.notifications;
  if (!policy?.runtimes.includes(runtime) || (!retained && !policy.reviewRequest)) return;
  const username = manifest.github?.username;
  if (typeof username !== 'string') throw new Error('review-literal-identity-required');
  return { policy, username, digest: notificationAuthorityDigest(policy) };
}
