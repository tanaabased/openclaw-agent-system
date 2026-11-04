import { issueExampleScenario } from '../openclaw-issue-journey/model-fixture.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

export const conversationExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-issue-conversation',
};
