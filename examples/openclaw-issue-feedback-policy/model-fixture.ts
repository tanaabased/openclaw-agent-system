import { issueExampleScenario } from '../openclaw-issue-journey/model-fixture.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

/** reuse assessment judgment; the owning readme supplies this scenario's native path. */
export const feedbackPolicyExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-issue-feedback-policy',
};
