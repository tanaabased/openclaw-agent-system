import type { Static } from 'typebox';

import {
  defaultAssessmentSkill,
  defaultFeedbackSkill,
  defaultImplementationSkill,
  type AssessmentConfiguration,
} from '../../manifest/assessment-schema.ts';
import assessmentGuidance from './assessment/assessment-guidance.ts';
import type { assessmentSelectionSchema } from './assessment/assessment-selection.ts';
import type { AssessmentSkill } from './assessment/assessment-skill-source.ts';

export type WorkflowStage = 'assessment' | 'implementation' | 'review' | 'feedback';
export interface WorkflowSelection {
  stage: WorkflowStage;
  selection: Static<typeof assessmentSelectionSchema>;
}

/** all stages use host-discovered skills and the same contained guidance reader. */
export async function selectWorkflowStage(input: {
  stage: WorkflowStage;
  configuration?: AssessmentConfiguration;
  workspace: string;
  observedAt: number;
  resolveSkill: (id: string) => Promise<AssessmentSkill>;
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
