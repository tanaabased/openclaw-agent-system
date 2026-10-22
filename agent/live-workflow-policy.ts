import type { AgentManifest } from '../manifest/types.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';

/** current workflow settings decide eligibility; receipts retain effects and identity. */
export default function liveWorkflowPolicy(
  manifest: AgentManifest,
  runtime: 'codex' | 'openclaw',
  intake: IntakeRecord,
  effect: 'assignment' | 'implementation' | 'continued-work' | 'feedback' = 'assignment',
) {
  const policy = manifest.github?.notifications;
  // admission rules apply once; live mode governs the first implementation transition.
  if (effect === 'implementation')
    return (policy?.issueAssignment?.mode ?? 'auto') === 'plan'
      ? 'implementation-disabled'
      : undefined;
  if (effect !== 'assignment') return;
  if (!policy || !policy.runtimes.includes(runtime)) return 'workflow-disabled';
  if (!policy.issueAssignment) return 'issue-workflow-disabled';
  if (
    !policy.allowedRepositoryOwners.some((owner) =>
      githubIdentityMatches(owner, intake.repository.owner),
    )
  )
    return 'repository-outside-workflow';
  if (
    !policy.issueAssignment.allowed.some((actor) =>
      githubIdentityMatches(actor, intake.assignment.actor),
    )
  )
    return 'assigner-not-approved';
}

export class WorkflowPolicyHeld extends Error {
  readonly code = 'workflow-policy-held';
  constructor(readonly reason: string) {
    super('workflow-policy-held');
  }
}
