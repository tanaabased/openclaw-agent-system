import { getTextContent, type ChatCompletionRequest } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import {
  hasOpenClawAIMockToolResult,
  openClawAIMockToolResultText,
} from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const wrong = 'native-retirement-wrong';
const preview = 'native-retirement-preview';
const apply = 'native-retirement-apply';
const target = 'agent:native-retirement:disposable';
const result = (request: ChatCompletionRequest, id: string) => {
  const text = openClawAIMockToolResultText(request.messages, id);
  return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
};
const prompt = (request: ChatCompletionRequest) =>
  request.messages.some(
    (message) =>
      message.role === 'user' &&
      getTextContent(message.content)?.includes('using explicit unmanaged native retirement'),
  );

export const nativeRetirementScenario: OpenClawAIMockScenario = {
  id: 'openclaw-native-retirement',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  finalResponses: ['native-retirement-verified'],
  systemPromptSignals: ['Native Retirement Fixture'],
  userPromptSignals: ['using explicit unmanaged native retirement'],
  toolCalls: [wrong, preview, apply].map((id) => ({ id, name: 'agent_system_dispatch' })),
  fixtures: [
    {
      match: {
        model,
        toolName: 'agent_system_dispatch',
        predicate: (request) =>
          prompt(request) &&
          ![wrong, preview, apply].some((id) => hasOpenClawAIMockToolResult(request.messages, id)),
      },
      response: {
        id: wrong,
        toolCalls: [
          {
            id: wrong,
            name: 'agent_system_dispatch',
            arguments: JSON.stringify({ action: 'retire', native: 'agent:other:disposable' }),
          },
        ],
      },
    },
    {
      match: {
        model,
        hasToolResult: true,
        predicate: (request) =>
          prompt(request) &&
          result(request, wrong)?.code === 'native-retirement-agent-mismatch' &&
          !result(request, preview),
      },
      response: {
        id: preview,
        toolCalls: [
          {
            id: preview,
            name: 'agent_system_dispatch',
            arguments: JSON.stringify({ action: 'retire', native: target }),
          },
        ],
      },
    },
    {
      match: {
        model,
        hasToolResult: true,
        predicate: (request) =>
          prompt(request) &&
          result(request, preview)?.status === 'retire-available' &&
          !result(request, apply),
      },
      response: (request) => ({
        id: apply,
        toolCalls: [
          {
            id: apply,
            name: 'agent_system_dispatch',
            arguments: JSON.stringify({
              action: 'retire',
              native: target,
              digest: result(request, preview)!.digest,
            }),
          },
        ],
      }),
    },
    {
      match: {
        model,
        hasToolResult: true,
        predicate: (request) =>
          prompt(request) &&
          result(request, apply)?.status === 'archived' &&
          result(request, apply)?.native === target,
      },
      response: { id: 'native-retirement-final', content: 'native-retirement-verified' },
    },
  ],
};
