import { issueExampleScenario } from '../openclaw-issue/model-fixture.ts';
import waitForAssessmentRelease from './assessment-barrier.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

/** reuse assessment judgment; lifecycle coverage alone controls concurrent response release. */
export const notificationsExampleScenario: OpenClawAIMockScenario = {
  ...issueExampleScenario,
  id: 'openclaw-notifications',
  fixtures: issueExampleScenario.fixtures.map((fixture) => ({
    ...fixture,
    response: async (request) => {
      const value =
        typeof fixture.response === 'function' ? await fixture.response(request) : fixture.response;
      if ('toolCalls' in value) {
        const context = value.toolCalls?.find((tool) => tool.id === 'call_notifications_context');
        if (context) await waitForAssessmentRelease(JSON.parse(context.arguments).id);
      }
      return value;
    },
  })),
};
