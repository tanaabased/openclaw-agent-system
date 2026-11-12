import { issueExampleScenario } from '../openclaw-issue-conversation/issue-model.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

/** reuse assessment judgment; the owning readme supplies this scenario's native path. */
export const assignmentPolicyExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-issue-assignment-policy',
};
