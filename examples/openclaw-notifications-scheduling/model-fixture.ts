import { getTextContent, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.(?:5|4-nano)$/u;
const prompt = 'Run the activated project pickup once.';
const call = 'call_project_pickup';
const final: Fixture = {
  match: {
    model,
    hasToolResult: true,
    predicate(request) {
      const text = openClawAIMockToolResultText(request.messages, call);
      if (!text) return false;
      try {
        const result = JSON.parse(text);
        return (
          result.status === 'empty' &&
          typeof result.response === 'string' &&
          result.response.includes('📥')
        );
      } catch {
        return false;
      }
    },
  },
  response(request) {
    const result = JSON.parse(openClawAIMockToolResultText(request.messages, call)!);
    return { id: 'pickup-empty', content: result.response };
  },
};

export const pickupSchedulingScenario: OpenClawAIMockScenario = {
  id: 'openclaw-notifications-scheduling',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  finalResponses: [],
  dynamicFinalResponseFixtures: [final],
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
    final,
  ],
};
