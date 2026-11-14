import assert from 'node:assert/strict';
import { getTextContent } from '@copilotkit/aimock';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';
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
    toolCalls: [
      ...issueExampleScenario.toolCalls,
      { id: 'call_intake_unmanaged_context', name: 'agent_system_context' },
    ],
    fixtures: issueExampleScenario.fixtures.map((fixture) => ({
      ...fixture,
      response: async (request) => {
        const messages = currentTurn(request);
        const prompt = messages
          .filter(({ role }) => role === 'user')
          .map(({ content }) => getTextContent(content) ?? '')
          .join('\n');
        if (
          prompt.includes('Advance previously admitted issue or feedback work.') ||
          prompt.includes('Fill initially available intake slots in one bounded pass.')
        ) {
          const text = openClawAIMockToolResultText(messages, 'call_intake_unmanaged_context');
          if (text === undefined)
            return {
              toolCalls: [
                {
                  id: 'call_intake_unmanaged_context',
                  name: 'agent_system_context',
                  arguments: '{}',
                },
              ],
            };
          let context = JSON.parse(text);
          while (typeof context === 'string') context = JSON.parse(context);
          assert.equal(context.status, 'unmanaged-turn');
          assert.equal(context.notice, undefined);
        }
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
