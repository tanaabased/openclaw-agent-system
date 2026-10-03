import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const callId = 'call_collaboration_send';
function userContains(request: ChatCompletionRequest, text: string): boolean {
  const message = request.messages.filter((entry) => entry.role === 'user').at(-1);
  return (getTextContent(message?.content ?? '') ?? '').includes(text);
}
function receivedPeerReply(request: ChatCompletionRequest): boolean {
  try {
    const result = JSON.parse(openClawAIMockToolResultText(request.messages, callId) ?? 'null') as {
      status?: string;
      reply?: string;
    } | null;
    return result?.status === 'ok' && result.reply === 'collaboration-pong';
  } catch {
    return false;
  }
}
const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      systemMessage: ['Name: Beta'],
      predicate: (request) => userContains(request, 'collaboration-ready'),
    },
    response: { content: 'collaboration-ready' },
  },
  {
    match: {
      hasToolResult: false,
      systemMessage: ['Name: Beta'],
      predicate: (request) => userContains(request, 'collaboration-ping'),
    },
    response: { content: 'collaboration-pong' },
  },
  {
    match: {
      hasToolResult: false,
      toolName: 'sessions_send',
      systemMessage: ['Name: Alpha'],
      predicate: (request) => userContains(request, 'collaboration-send'),
    },
    response: {
      toolCalls: [
        {
          id: callId,
          name: 'sessions_send',
          arguments: JSON.stringify({
            sessionKey: 'agent:beta:collaboration',
            message: 'collaboration-ping',
            timeoutSeconds: 60,
          }),
        },
      ],
    },
  },
  {
    match: {
      hasToolResult: true,
      predicate: (request) =>
        userContains(request, 'collaboration-send') && receivedPeerReply(request),
    },
    response: { content: 'collaboration-exchange-complete' },
  },
  {
    match: {
      systemMessage: ['Name: Alpha'],
      predicate: (request) =>
        userContains(request, 'collaboration-pong') &&
        request.messages.some(
          (message) =>
            message.role === 'system' &&
            /Another session returned|Agent-to-agent reply step:/u.test(
              getTextContent(message.content) ?? '',
            ),
        ),
    },
    response: { content: 'REPLY_SKIP' },
  },
  {
    match: {
      systemMessage: ['Name: Beta'],
      predicate: (request) => userContains(request, 'Agent-to-agent announce step.'),
    },
    response: { content: 'ANNOUNCE_SKIP' },
  },
];

export const collaborationExampleScenario: OpenClawAIMockScenario = {
  id: 'collaboration',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  fixtures,
  finalResponses: ['collaboration-ready', 'collaboration-pong', 'collaboration-exchange-complete'],
  systemPromptSignals: [],
  toolCalls: [{ id: callId, name: 'sessions_send' }],
  skipToolSearch: (request) => !userContains(request, 'collaboration-send'),
};
