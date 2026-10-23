import { issueExampleScenario } from '../openclaw-notifications-issue-journey/model-fixture.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

export const issueAssessmentExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-issue-assessment',
};
