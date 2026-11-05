import type { Static } from 'typebox';

import type { AssessmentResult } from './assessment-result.ts';
import type { AssessmentSelection } from './assessment-selection.ts';
import implementationHandoff from './implementation-handoff.ts';
import { implementationResultSchema } from './implementation-result.ts';

/** direct collectors and managed owners inject the same implementation body inputs. */
export default function implementationContext(input: {
  runtime: 'openclaw' | 'codex';
  id: string;
  path: string;
  assessment?: AssessmentResult;
  plan?: string;
  reassessments?: Array<{ result?: AssessmentResult }>;
  implementation?: AssessmentSelection;
  previousResult?: Static<typeof implementationResultSchema>;
  scope?: 'local' | 'pull-request';
  direct?: boolean;
  revision?: boolean;
  existingPullRequest?: boolean;
}) {
  return {
    status: 'verified' as const,
    runtime: input.runtime,
    issueStage: 'implementation' as const,
    id: input.id,
    project: { path: input.path },
    assessment: undefined,
    plan: input.plan,
    implementation: input.implementation,
    resultContract: 'implementation-result/v1' as const,
    resultSchema: implementationResultSchema,
    previousResult: input.previousResult,
    previousImplementationResult: input.previousResult,
    deliveryOnly: Boolean(
      input.direct && input.previousResult?.outcome === 'done' && !input.revision,
    ),
    recording: input.direct ? ('required' as const) : ('optional-history' as const),
    publicationAuthorized: input.scope !== 'local',
    handoff: implementationHandoff(
      input.id,
      input.direct && !input.revision ? input.previousResult?.outcome : undefined,
      input.runtime,
      input.direct || input.scope === 'local'
        ? { publication: input.scope === 'pull-request' }
        : undefined,
      input.existingPullRequest,
    ),
  };
}
