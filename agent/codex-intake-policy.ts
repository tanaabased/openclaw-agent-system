import { automationHash } from './automation-hash.ts';
import { projectRoutingProfile } from './model-routing.ts';
import type { ResolvedAutomation } from '../manifest/automation-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';

export const intakeAutomationId = 'github-issue-assignment';

export function codexIntakePolicy(manifest: AgentManifest) {
  const policy = manifest.github?.notifications;
  if (
    policy?.schemaVersion !== 2 ||
    !policy.runtimes.includes('codex') ||
    !policy.issueAssignment?.allowed.length
  )
    return;
  const username = manifest.github?.username;
  if (typeof username !== 'string') throw new IntakeError('intake-literal-identity-required');
  return {
    policy,
    username,
    digest: automationHash({ username, host: manifest.github?.host, policy }),
  };
}

/** desired policy adds one reserved job; the native planner still owns every mutation. */
export function codexIntakeJobs(manifest: AgentManifest): ResolvedAutomation[] {
  const jobs = manifest.automations ?? [];
  if (jobs.some((job) => job.id === intakeAutomationId))
    throw new IntakeError('intake-automation-id-reserved');
  const selected = codexIntakePolicy(manifest);
  if (!selected) return jobs;
  if (!manifest.models?.low) throw new IntakeError('intake-low-profile-required');
  const model = projectRoutingProfile(manifest.models.low, 'codex');
  if (model.status !== 'mapped') throw new IntakeError(model.code);
  return [
    ...jobs,
    {
      id: intakeAutomationId,
      displayName: '📥 ISSUE ASSIGNMENTS',
      enabled: true,
      runtimes: ['codex'],
      schedule: {
        kind: 'every',
        missedRun: 'native',
        seconds: selected.policy.intervalMinutes * 60,
      },
      thread: { name: 'ISSUE ASSIGNMENTS' },
      overrides: { codex: { model: model.model, effort: model.thinking } },
      payload: {
        kind: 'prompt',
        prompt: [
          'Check GitHub for newly assigned issues from approved assigners. Record eligible assignments; do not start work on them.',
          'Run the deterministic scan before any routine commentary or progress update. Use intakeRuntime.argvPrefix from the newest trusted Agent System context, followed by scan --plugin-data and intakeRuntime.pluginData. If that context is unavailable, report the blocker; never guess a workspace or executable.',
          'When changed:false, emit no user-facing commentary or status message. Complete the native heartbeat with its DONT_NOTIFY response. Follow the host response contract rather than returning an empty final response.',
          'Report only newly admitted records, recovery, or a new actionable blocker, including required approval. Use intakeRuntime inspect for persisted details. Disabled or revoked policy requires authorized Install to pause the owned job.',
          'Stop at durable intake. Do not create issue chats or worktrees, assess or implement issues, publish to GitHub, or edit scheduler files.',
          `Policy revision: ${selected.digest}.`,
        ].join('\n\n'),
      },
    },
  ];
}
