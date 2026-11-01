import assignmentIntakePolicy from './assignment-intake-policy.ts';
import type { ManagedIssueState as IntakeState } from './managed-issue.ts';
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
                ? state.records.flatMap((record) =>
                    record.assignment ? [record.assignment.actor] : [],
                  )
                : [state.account]),
          },
          allowedRepositoryOwners:
            manifest.github?.notifications?.routing !== undefined
              ? []
              : (manifest.github?.notifications?.allowedRepositoryOwners ??
                state.records.map((record) => record.repository.owner)),
        },
      },
    },
    runtime,
  )!;
}
