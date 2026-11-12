import { issueExampleScenario } from '../openclaw-issue-conversation/issue-model.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

export const issueAssessmentExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-issue-assessment',
};
