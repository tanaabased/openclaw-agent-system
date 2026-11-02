import { getTextContent } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const prompt = 'Run the activated project pickup once.';
const call = 'call_project_pickup';

export const pickupSchedulingScenario: OpenClawAIMockScenario = {
  id: 'openclaw-notifications-scheduling',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  finalResponses: ['pickup-empty-verified'],
  systemPromptSignals: [],
  userPromptSignals: [prompt],
  toolCalls: [{ id: call, name: 'agent_system_intake' }],
  fixtures: [
    {
      match: {
        model,
        predicate: (request) =>
          request.messages.some(
            (message) =>
              message.role === 'user' && (getTextContent(message.content) ?? '').includes(prompt),
          ) && !request.messages.some((message) => message.role === 'tool'),
      },
      response: {
        id: 'pickup-call',
        toolCalls: [{ id: call, name: 'agent_system_intake', arguments: '{"action":"pickup"}' }],
      },
    },
    {
      match: {
        model,
        hasToolResult: true,
        predicate(request) {
          const text = openClawAIMockToolResultText(request.messages, call);
          if (!text) return false;
          try {
            return JSON.parse(text).status === 'empty';
          } catch {
            return false;
          }
        },
      },
      response: { id: 'pickup-empty', content: 'pickup-empty-verified' },
    },
  ],
};
