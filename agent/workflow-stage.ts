import type { Static } from 'typebox';

import assessmentGuidance from './assessment-guidance.ts';
import type { assessmentSelectionSchema } from './assessment-selection.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';
import {
  defaultAssessmentSkill,
  defaultImplementationSkill,
  defaultFeedbackSkill,
  type AssessmentConfiguration,
} from '../manifest/assessment-schema.ts';

export const stageResultContracts = {
  assessment: 'assessment-result/v1',
  implementation: 'implementation-result/v1',
  review: 'review-result/v1',
  feedback: 'feedback-result/v1',
} as const;
export type WorkflowStage = keyof typeof stageResultContracts;
export interface WorkflowSelection {
  stage: WorkflowStage;
  resultContract: (typeof stageResultContracts)[WorkflowStage];
  selection: Static<typeof assessmentSelectionSchema>;
}

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
    (input.stage === 'assessment'
      ? defaultAssessmentSkill
      : input.stage === 'implementation'
        ? defaultImplementationSkill
        : input.stage === 'feedback'
          ? defaultFeedbackSkill
          : undefined);
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
