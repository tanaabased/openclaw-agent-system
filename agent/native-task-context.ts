import type { AssessmentConfiguration } from '../manifest/assessment-schema.ts';
import type { AssessmentEntryDependencies } from './tasks/assessment/assessment-entry.ts';
import type { nativeIssueContext } from './native-issue-context.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import assessmentMaterial from './tasks/assessment/assessment-material.ts';
import implementationMaterial, {
  type ImplementationMaterialRead,
} from './tasks/implementation/implementation-material.ts';
import { nativeAssessmentInstructions } from './tasks/assessment/assessment-instructions.ts';
import nativeTaskInstructions from './native-task-instructions.ts';
import { assessmentResultContextSchema } from './tasks/assessment/assessment-result.ts';
import { assessmentPresentationRequest } from './tasks/assessment/assessment-render.ts';
import type { AssessmentSelection } from './tasks/assessment/assessment-selection.ts';
import workflowFailure from './workflow-failure.ts';

/** Refresh native conversation inputs without creating stages, saving plans, or changing receipts. */
export default async function nativeTaskContext(
  stage: 'assessment' | 'implementation',
  target: string,
  native: ReturnType<typeof nativeIssueContext>,
  deps: AssessmentEntryDependencies,
  material?: ImplementationMaterialRead,
  configuration?: AssessmentConfiguration,
) {
  await deps.assertCurrent();
  const evidence = { source: target };
  let selection: AssessmentSelection | undefined;
  let contextLimitations;
  try {
    ({ selection } = await selectWorkflowStage({
      stage,
      configuration: {
        ...deps.manifest.github?.notifications?.issueAssignment?.[stage],
        ...configuration,
      },
      workspace: deps.binding.workspace,
      observedAt: deps.now,
      resolveSkill: deps.resolveSkill,
    }));
  } catch (error) {
    contextLimitations = [
      { scope: stage, code: workflowFailure(error, 'workflow-guidance-unavailable').code },
    ];
  }
  await deps.assertCurrent();
  const materialContext = stage === 'assessment' ? assessmentMaterial : implementationMaterial;
  return materialContext(
    {
      ...native,
      runtime: deps.binding.runtime,
      evidence,
      ...(contextLimitations ? { contextLimitations } : {}),
      ...(stage === 'assessment'
        ? {
            assessment: selection,
            resultSchema: assessmentResultContextSchema,
            presentationRequest: assessmentPresentationRequest(target, true),
          }
        : { implementation: selection }),
      instructions: [
        stage === 'assessment'
          ? nativeAssessmentInstructions()
          : nativeTaskInstructions(deps.binding.runtime),
        contextLimitations
          ? 'Configured skills or guidance could not be read. Preserve the verified task context and continue independently authorized work that does not require the missing material. Do not substitute default guidance or claim it was applied. Refresh context when the lookup can recover; do not repeatedly retry an unchanged failure.'
          : undefined,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    { action: stage, operation: 'context', target },
    material,
  );
}
