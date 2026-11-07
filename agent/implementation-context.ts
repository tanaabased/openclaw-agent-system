import type { AssessmentSelection } from './assessment-selection.ts';

/** direct collectors and managed owners inject the same implementation body inputs. */
export default function implementationContext(input: {
  runtime: 'openclaw' | 'codex';
  id: string;
  path: string;
  implementation?: AssessmentSelection;
  scope?: 'local' | 'pull-request';
}) {
  return {
    status: 'verified' as const,
    runtime: input.runtime,
    issueStage: 'implementation' as const,
    id: input.id,
    project: { path: input.path },
    implementation: input.implementation,
    publicationAuthorized: input.scope !== 'local',
  };
}
