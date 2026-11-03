import { createPRExampleScenario } from '../openclaw-pr-journey/model-fixture.ts';

export const prReplyRecoveryExampleScenario = createPRExampleScenario(
  'openclaw-pr-reply-recovery',
  { interruptFeedbackReply: true },
);
