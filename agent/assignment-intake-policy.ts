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
  return {
    policy,
    username,
    digest: automationHash({
      username,
      host: manifest.github?.host,
      policy: {
        schemaVersion: policy.schemaVersion,
        runtimes: policy.runtimes,
        intervalMinutes: policy.intervalMinutes,
        maxConcurrentItems: policy.maxConcurrentItems,
        cleanup: policy.cleanup ?? { enabled: true, graceMinutes: 60 },
        allowedRepositoryOwners: policy.allowedRepositoryOwners,
        issueAssignment: policy.issueAssignment,
      },
    }),
  };
}
