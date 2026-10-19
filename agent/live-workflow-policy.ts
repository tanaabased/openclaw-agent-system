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
  // Intake eligibility cannot revoke an active issue's recorded implementation stage.
  if (['continued-work', 'feedback'].includes(effect)) return;
  const policy = manifest.github?.notifications;
  if (policy?.schemaVersion !== 2 || !policy.runtimes.includes(runtime)) return 'workflow-disabled';
  if (!policy.issueAssignment || policy.issueAssignment.enabled === false)
    return 'issue-workflow-disabled';
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
  if (effect === 'implementation' && policy.issueAssignment.mode === 'plan')
    return 'implementation-disabled';
}

export class WorkflowPolicyHeld extends Error {
  readonly code = 'workflow-policy-held';
  constructor(readonly reason: string) {
    super('workflow-policy-held');
  }
}
