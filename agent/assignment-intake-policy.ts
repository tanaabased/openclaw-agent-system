import { notificationAuthority, legacyNotificationAuthority } from './notification-authority.ts';
import { automationHash } from './automation-hash.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';
import type { AgentManifest } from '../manifest/types.ts';

/** V2 admission policy is shared; neither runtime may select the V1 monitor state. */
export default function assignmentIntakePolicy(
  manifest: AgentManifest,
  runtime: 'codex' | 'openclaw',
  retainedWork = false,
) {
  const policy = manifest.github?.notifications;
  if (
    policy?.schemaVersion !== 2 ||
    !policy.runtimes.includes(runtime) ||
    (!retainedWork && policy.issueAssignment?.enabled === false) ||
    !policy.issueAssignment?.allowed.length
  )
    return;
  const username = manifest.github?.username;
  if (typeof username !== 'string') throw new IntakeError('intake-literal-identity-required');
  const digest = (project: typeof notificationAuthority) =>
    automationHash({
      username,
      host: manifest.github?.host,
      policy: project({ ...policy, reviewRequest: undefined }),
    });
  return {
    policy,
    username,
    digest: digest(notificationAuthority),
    legacyDigest: digest(legacyNotificationAuthority),
  };
}

/** original ordered admission format: retained custody only, never schedule activation. */
export function originalIntakePolicyDigest(manifest: AgentManifest) {
  const policy = manifest.github?.notifications;
  const username = manifest.github?.username;
  if (policy?.schemaVersion !== 2 || typeof username !== 'string') return;
  return automationHash({
    username,
    host: manifest.github?.host,
    policy: {
      schemaVersion: policy.schemaVersion,
      runtimes: policy.runtimes,
      intervalMinutes: policy.intervalMinutes,
      maxConcurrentItems: policy.maxConcurrentItems,
      allowedRepositoryOwners: policy.allowedRepositoryOwners,
      issueAssignment: policy.issueAssignment,
    },
  });
}

/** only the exact unchanged legacy projection can inherit its existing activation. */
export function matchesIntakePolicy(
  digest: string | undefined,
  selected:
    | Pick<NonNullable<ReturnType<typeof assignmentIntakePolicy>>, 'digest' | 'legacyDigest'>
    | undefined,
) {
  return Boolean(
    selected && digest && (digest === selected.digest || digest === selected.legacyDigest),
  );
}
