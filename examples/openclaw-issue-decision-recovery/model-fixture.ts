import { createProgressionScenario } from '../openclaw-issue-progression/model-fixture.ts';

/** retain the intentional interruption only in the decision-recovery journey. */
export const decisionRecoveryExampleScenario = createProgressionScenario(
  'openclaw-issue-decision-recovery',
  true,
);
