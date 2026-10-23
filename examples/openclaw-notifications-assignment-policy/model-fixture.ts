import { issueExampleScenario } from '../openclaw-notifications-issue-journey/model-fixture.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

/** reuse assessment judgment; the owning readme supplies this scenario's native path. */
export const assignmentPolicyExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-notifications-assignment-policy',
};
