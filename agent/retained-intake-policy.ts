import assignmentIntakePolicy from './assignment-intake-policy.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';
import type { AgentManifest } from '../manifest/types.ts';

/** retained identity and presentation defaults never admit new work. */
export default function retainedIntakePolicy(
  manifest: AgentManifest,
  state: IntakeState,
  runtime: 'codex' | 'openclaw',
) {
  return assignmentIntakePolicy(
    {
      ...manifest,
      github: {
        ...manifest.github,
        username: state.account.login,
        notifications: {
          schemaVersion: 3,
          intervalMinutes: 5,
          maxConcurrentItems: 3,
          ...manifest.github?.notifications,
          runtimes: [runtime],
          issueAssignment: {
            mode: 'auto',
            ...(!manifest.github?.notifications?.issueAssignment
              ? { feedback: { inherit: false, allowed: [] } }
              : {}),
            ...manifest.github?.notifications?.issueAssignment,
            allowed:
              manifest.github?.notifications?.issueAssignment?.allowed ??
              (state.records.length
                ? state.records.map((record) => record.assignment.actor)
                : [state.account]),
          },
          allowedRepositoryOwners:
            manifest.github?.notifications?.allowedRepositoryOwners ??
            state.records.map((record) => record.repository.owner),
        },
      },
    },
    runtime,
  )!;
}
