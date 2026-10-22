import { notificationAuthority } from './notification-authority.ts';
import { automationHash } from './automation-hash.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';
import type { AgentManifest } from '../manifest/types.ts';

/** V2 admission policy is shared; neither runtime may select the V1 monitor state. */
export default function assignmentIntakePolicy(
  manifest: AgentManifest,
  runtime: 'codex' | 'openclaw',
) {
  const policy = manifest.github?.notifications;
  if (policy?.schemaVersion !== 2 || !policy.runtimes.includes(runtime) || !policy.issueAssignment)
    return;
  const username = manifest.github?.username;
  if (typeof username !== 'string') throw new IntakeError('intake-literal-identity-required');
  return {
    policy,
    username,
    digest: automationHash({
      username,
      host: manifest.github?.host,
      policy: notificationAuthority({ ...policy, reviewRequest: undefined }),
    }),
  };
}
