import type { AssessmentSelection } from './assessment-selection.ts';
import implementationHandoff from './implementation-handoff.ts';
import { implementationResultSchema } from './implementation-result.ts';

/** direct collectors and managed owners inject the same implementation body inputs. */
export default function implementationContext(input: {
  runtime: 'openclaw' | 'codex';
  id: string;
  path: string;
  implementation?: AssessmentSelection;
  scope?: 'local' | 'pull-request';
  direct?: boolean;
  existingPullRequest?: boolean;
}) {
  return {
    status: 'verified' as const,
    runtime: input.runtime,
    issueStage: 'implementation' as const,
    id: input.id,
    project: { path: input.path },
    implementation: input.implementation,
    resultContract: 'implementation-result/v1' as const,
    resultSchema: implementationResultSchema,
    recording: 'optional-history' as const,
    publicationAuthorized: input.scope !== 'local',
    handoff: implementationHandoff(
      input.id,
      undefined,
      input.runtime,
      input.direct || input.scope === 'local'
        ? { publication: input.scope === 'pull-request' }
        : undefined,
      input.existingPullRequest,
    ),
  };
}
