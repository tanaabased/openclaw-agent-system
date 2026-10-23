import { createPRExampleScenario } from '../openclaw-notifications-pr-journey/model-fixture.ts';

export const prCollaborationExampleScenario = createPRExampleScenario(
  'openclaw-notifications-pr-collaboration',
  { incorporateCollaborator: true },
);
