import { issueExampleScenario } from '../openclaw-issue-journey/model-fixture.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

/** reuse assessment judgment; the owning readme supplies this scenario's native path. */
export const reactivationExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-issue-reactivation',
};
