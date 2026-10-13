import { Type, type Static } from 'typebox';

import assessmentGuidance from './assessment-guidance.ts';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';
import {
  defaultAssessmentSkill,
  type AssessmentConfiguration,
} from '../manifest/assessment-schema.ts';

export const workflowStageSchema = Type.Union([
  Type.Literal('assessment'),
  Type.Literal('implementation'),
  Type.Literal('review'),
]);
export type WorkflowStage = Static<typeof workflowStageSchema>;
export const stageResultContracts = {
  assessment: 'assessment-result/v1',
  implementation: 'implementation-result/v1',
  review: 'review-result/v1',
} as const;

export const workflowSelectionSchema = Type.Object(
  {
    stage: workflowStageSchema,
    resultContract: Type.Union([
      Type.Literal(stageResultContracts.assessment),
      Type.Literal(stageResultContracts.implementation),
      Type.Literal(stageResultContracts.review),
    ]),
    selection: assessmentSelectionSchema,
  },
  { additionalProperties: false },
);
export type WorkflowSelection = Static<typeof workflowSelectionSchema>;

/** all stages use host-discovered skills and the same contained guidance reader. */
export async function selectWorkflowStage(input: {
  stage: WorkflowStage;
  configuration?: AssessmentConfiguration;
  workspace: string;
  observedAt: number;
  resolveSkill: (id: string) => Promise<CodexAssessmentSkill>;
}): Promise<WorkflowSelection> {
  const requestedSkill =
    input.configuration?.skill ??
    (input.stage === 'assessment' ? defaultAssessmentSkill : undefined);
  if (!requestedSkill) throw new Error('workflow-stage-skill-required');
  const skill = await input.resolveSkill(requestedSkill);
  const guidance = await assessmentGuidance(input.workspace, input.configuration?.guidance);
  return {
    stage: input.stage,
    resultContract: stageResultContracts[input.stage],
    selection: {
      version: 1,
      requestedSkill,
      defaultSkill: input.configuration?.skill === undefined,
      skill,
      ...(guidance ? { guidance } : {}),
      observedAt: input.observedAt,
    },
  };
}

/** a recommendation selects only the next fixed stage; it never grants execution authority. */
export function nextIssueStage(
  mode: 'plan' | 'work' | 'auto',
  outcome: 'plan-ready' | 'clarification-needed' | 'operator-setup-blocker',
  recommendation?: 'stop' | 'proceed',
): 'implementation' | 'stop' {
  if (outcome !== 'plan-ready' || mode === 'plan') return 'stop';
  if (mode === 'auto' && !recommendation) throw new Error('workflow-recommendation-required');
  return mode === 'work' || recommendation === 'proceed' ? 'implementation' : 'stop';
}
