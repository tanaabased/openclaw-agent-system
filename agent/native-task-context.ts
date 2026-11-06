import type { AssessmentConfiguration } from '../manifest/assessment-schema.ts';
import type { AssessmentEntryDependencies } from './assessment-entry.ts';
import type { nativeIssueContext } from './implementation-delivery.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import dispatchContext from './dispatch-context.ts';
import { replyLocator } from './reply-target.ts';
import implementationMaterial, {
  type ImplementationMaterialRead,
} from './implementation-material.ts';
import { nativeAssessmentInstructions } from './assessment-instructions.ts';
import nativeTaskInstructions from './native-task-instructions.ts';
import { assessmentResultContextSchema } from './assessment-result.ts';
import { assessmentPresentationRequest } from './assessment-render.ts';

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
  const locator = replyLocator(target);
  const provider = await deps.connectProvider();
  const evidence = dispatchContext(
    await provider.getItemContext(
      locator.owner,
      locator.name,
      locator.number,
      locator.itemType,
      true,
      true,
    ),
    target,
    deps.now,
    true,
  );
  const { selection } = await selectWorkflowStage({
    stage,
    configuration: {
      ...deps.manifest.github?.notifications?.issueAssignment?.[stage],
      ...configuration,
    },
    workspace: deps.binding.workspace,
    observedAt: deps.now,
    resolveSkill: deps.resolveSkill,
  });
  await deps.assertCurrent();
  return implementationMaterial(
    {
      ...native,
      runtime: deps.binding.runtime,
      evidence,
      ...(stage === 'assessment'
        ? {
            assessment: selection,
            resultSchema: assessmentResultContextSchema,
            presentationRequest: assessmentPresentationRequest(target, true),
          }
        : { implementation: selection }),
      instructions:
        stage === 'assessment'
          ? nativeAssessmentInstructions(deps.binding.runtime)
          : nativeTaskInstructions(deps.binding.runtime),
    },
    { action: stage, operation: 'context', target },
    material,
  );
}
