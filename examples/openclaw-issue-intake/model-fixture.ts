import { currentTurn, issueExampleScenario } from '../openclaw-issue-conversation/issue-model.ts';
import { currentFacts } from '../openclaw-pr-journey/model-fixture.ts';
import waitForAssessmentRelease from './assessment-barrier.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

/** reuse assessment judgment; intake coverage alone controls concurrent response release. */
export function createIntakeExampleScenario(
  wait: (id: string) => Promise<void> = waitForAssessmentRelease,
): OpenClawAIMockScenario {
  return {
    ...issueExampleScenario,
    id: 'openclaw-issue-intake',
    fixtures: issueExampleScenario.fixtures.map((fixture) => ({
      ...fixture,
      response: async (request) => {
        const value =
          typeof fixture.response === 'function'
            ? await fixture.response(request)
            : fixture.response;
        if ('toolCalls' in value) {
          const context = value.toolCalls?.find((tool) => tool.id === 'call_notifications_context');
          if (context) await wait(currentFacts(currentTurn(request)).receipt);
        }
        return value;
      },
    })),
  };
}

export const intakeExampleScenario = createIntakeExampleScenario();
