import issueProgression from './issue-progression.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';

/** assessment completion selects the next skill; its context owns the actual transition. */
export default function assessmentHandoff(
  record: SharedDispatchRecord,
  mode: 'plan' | 'work' | 'auto',
  runtime: 'codex' | 'openclaw',
) {
  const transition = issueProgression(record, { mode, now: 0 });
  if (transition.status !== 'ready') return { next: 'planning' as const };
  return {
    next: 'implementation' as const,
    instruction: `After presenting the assessment and handling its summary, continue in this same permitted turn. Call ${runtime === 'codex' ? 'continuationRuntime action:context' : 'agent_system_dispatch action implementation-context'} with id ${record.id}, then invoke its selected implementation skill and follow its result and PR-delivery instructions. Do not end the turn or wait for intake. The context rechecks live policy and records the shared implementation transition. A denial scoped only to assessment-summary publication stops that publication: retain its hold and diagnostic without retrying or using another route, then request fresh implementation context. It grants no implementation authority. Stop affected work on cancellation, lost authority, broader or implementation-specific native denial, unknown denial scope, or user restriction; never override a host-terminated turn.`,
  };
}
