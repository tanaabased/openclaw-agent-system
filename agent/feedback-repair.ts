import { automationHash } from './automation-hash.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import { repairAuthorityDigest } from './notification-authority.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import { allowsFeedbackRepair } from '../channels/github/feedback-policy.ts';
import type {
  GitHubIdentityPin,
  GitHubNotificationPolicy,
} from '../channels/github/config-schema.ts';
import { defaultFeedbackAssessmentSkill } from '../manifest/assessment-schema.ts';

/** the binding is supplied by the native owner, never by a model decision. */
export async function selectFeedbackRepair(input: {
  event: FeedbackSourceEvent;
  policy: GitHubNotificationPolicy;
  author: GitHubIdentityPin;
  self: boolean;
  binding: unknown;
  pullRequest?: { pullRequestNodeId: string; pullRequestNumber: number };
  workspace: string;
  now: number;
  implementation?: boolean;
  resolveSkill(id: string): Promise<CodexAssessmentSkill>;
}) {
  const { event, policy } = input;
  if (
    input.self ||
    !allowsFeedbackRepair(policy, input.author) ||
    event.repairPolicyDigest !== repairAuthorityDigest(policy)
  ) {
    if (event.repair) throw new Error('feedback-repair-authority-revoked');
    return undefined;
  }
  if (!input.pullRequest) {
    if (event.repair) throw new Error('feedback-repair-pr-required');
    return undefined;
  }
  const feedback = policy.issueAssignment!.feedback;
  const configuration = typeof feedback === 'object' ? feedback.repairs : undefined;
  const assessment = await selectWorkflowStage({
    stage: 'assessment',
    configuration: {
      ...configuration,
      skill: configuration?.skill ?? defaultFeedbackAssessmentSkill,
    },
    workspace: input.workspace,
    observedAt: event.repair?.assessment.observedAt ?? input.now,
    resolveSkill: input.resolveSkill,
  });
  assessment.selection.defaultSkill = configuration?.skill === undefined;
  const implementation =
    input.implementation || event.repair?.implementation
      ? await selectWorkflowStage({
          stage: 'implementation',
          configuration: policy.issueAssignment?.implementation,
          workspace: input.workspace,
          observedAt: event.repair?.implementation?.observedAt ?? input.now,
          resolveSkill: input.resolveSkill,
        })
      : undefined;
  const selected = {
    authorityDigest: repairAuthorityDigest(policy),
    bindingDigest: automationHash({
      binding: input.binding,
      source: event.source,
      revision: event.revision,
    }),
    assessment: assessment.selection,
    ...(implementation ? { implementation: implementation.selection } : {}),
    pullRequest: input.pullRequest,
  };
  if (
    event.repair &&
    automationHash({
      authorityDigest: event.repair.authorityDigest,
      bindingDigest: event.repair.bindingDigest,
      assessment: event.repair.assessment,
      pullRequest: event.repair.pullRequest,
    }) !==
      automationHash({
        authorityDigest: selected.authorityDigest,
        bindingDigest: selected.bindingDigest,
        assessment: selected.assessment,
        pullRequest: selected.pullRequest,
      })
  )
    throw new Error('feedback-repair-binding-changed');
  if (
    event.repair?.implementation &&
    automationHash(event.repair.implementation) !==
      automationHash(implementation?.selection ?? null)
  )
    throw new Error('feedback-repair-binding-changed');
  return selected;
}

export function requireFeedbackRepair(event: FeedbackSourceEvent) {
  if (!event.repair || event.repair.decision?.outcome !== 'repair')
    throw new Error('feedback-repair-decision-required');
  if (event.repair.result) throw new Error('feedback-repair-already-finished');
  return event.repair;
}

export const feedbackRepairInstructions =
  'Repair permission is separate from reply permission. Read and invoke the selected assessment skill with the exact source, relevant discussion and retained assessment/results. Interpret intent without keyword matching. Only an explicit applicable repair request may produce outcome repair; questions and suggestions remain discussion. Return a structured decision using repair-decision before editing. A decision cannot grant authority. After an accepted repair decision, use repair-context, apply the selected implementation skill, run focused checks, commit, and retain repair-result before delivery. Do not repeat finished implementation after interruption; inspect retained state and native/files evidence. Stop on changed source, revoked permission, cancellation or native denial. Update only the retained existing PR, never create a replacement or change the saved issue mode.';
