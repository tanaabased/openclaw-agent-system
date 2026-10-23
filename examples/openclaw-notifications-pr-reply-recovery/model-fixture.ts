import { createPRExampleScenario } from '../openclaw-notifications-pr-journey/model-fixture.ts';

export const prReplyRecoveryExampleScenario = createPRExampleScenario(
  'openclaw-notifications-pr-reply-recovery',
  { interruptFeedbackReply: true },
);
