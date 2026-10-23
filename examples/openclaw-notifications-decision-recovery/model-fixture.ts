import { createProgressionScenario } from '../openclaw-notifications-progression/model-fixture.ts';

/** retain the intentional interruption only in the decision-recovery journey. */
export const decisionRecoveryExampleScenario = createProgressionScenario(
  'openclaw-notifications-decision-recovery',
  true,
);
