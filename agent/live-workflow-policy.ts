import type { AgentManifest } from '../manifest/types.ts';
import issueWorkflowMode from './issue-workflow-mode.ts';
import { projectWorkMatches } from './project-pickup-authority.ts';
import type { ManagedIssue as IntakeRecord } from './managed-issue.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';

/** current workflow settings decide eligibility; receipts retain effects and identity. */
export default function liveWorkflowPolicy(
  manifest: AgentManifest,
  runtime: 'codex' | 'openclaw',
  intake: IntakeRecord,
  effect: 'assignment' | 'implementation' | 'continued-work' | 'feedback' = 'assignment',
) {
  const policy = manifest.github?.notifications;
  if ('initiation' in intake && effect === 'assignment') return;
  // admission rules apply once; live mode governs the first implementation transition.
  if (effect === 'implementation')
    return issueWorkflowMode(
      policy,
      'initiation' in intake
        ? { manualIssue: intake }
        : {
            projectWork: projectWorkMatches(intake.evidence?.projectWork, intake)
              ? intake.evidence?.projectWork
              : undefined,
          },
    ) === 'plan'
      ? 'implementation-disabled'
      : undefined;
  if (effect !== 'assignment' || 'initiation' in intake) return;
  if (!policy || !policy.runtimes.includes(runtime)) return 'workflow-disabled';
  if (!policy.issueAssignment) return 'issue-workflow-disabled';
  if (
    !policy.allowedRepositoryOwners.some((owner) =>
      githubIdentityMatches(owner, intake.repository.owner),
    )
  )
    return 'repository-outside-workflow';
  if (
    !projectWorkMatches(
      intake.evidence?.projectWork?.pickup ? intake.evidence?.projectWork : undefined,
      intake,
    ) &&
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
