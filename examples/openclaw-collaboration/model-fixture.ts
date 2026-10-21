import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

function currentTurn(request: ChatCompletionRequest) {
  return request.messages.slice(
    Math.max(
      0,
      request.messages.findLastIndex(
        ({ role, content }) =>
          role === 'user' &&
          !getTextContent(content)?.trimStart().startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>'),
      ),
    ),
  );
}

function hasCurrentResult(request: ChatCompletionRequest): boolean {
  return currentTurn(request).some(({ role }) => role === 'tool');
}

function userContains(request: ChatCompletionRequest, marker: string): boolean {
  const prompt = request.messages
    .filter(({ role }) => role === 'user')
    .map(({ content }) => getTextContent(content) ?? '')
    .findLast((text) => !text.trimStart().startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>'));
  return prompt?.includes(marker) ?? false;
}

function result(request: ChatCompletionRequest, callId: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      openClawAIMockToolResultText(currentTurn(request), callId) ?? 'null',
    ) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

const sendCallId = 'call_collaboration_send';
const historyCallId = 'call_collaboration_history';
const fixtures: Fixture[] = [
  {
    match: {
      systemMessage: ['Name: Beta'],
      predicate: (request) =>
        !hasCurrentResult(request) && userContains(request, 'collaboration-ready'),
    },
    response: { content: 'collaboration-ready' },
  },
  {
    match: {
      systemMessage: ['Name: Beta'],
      predicate: (request) =>
        !hasCurrentResult(request) && userContains(request, 'collaboration-ping'),
    },
    response: { content: 'collaboration-pong' },
  },
  {
    match: {
      systemMessage: ['Name: Alpha'],
      toolName: 'sessions_send',
      predicate: (request) =>
        !hasCurrentResult(request) && userContains(request, 'collaboration-send'),
    },
    response: {
      toolCalls: [
        {
          id: sendCallId,
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
      systemMessage: ['Name: Alpha'],
      predicate: (request) => {
        const reply = result(request, sendCallId);
        return (
          userContains(request, 'collaboration-send') &&
          reply?.status === 'ok' &&
          reply.reply === 'collaboration-pong'
        );
      },
    },
    response: { content: 'collaboration-exchange-complete' },
  },
  {
    match: {
      systemMessage: ['Name: Alpha'],
      toolName: 'sessions_history',
      predicate: (request) =>
        !hasCurrentResult(request) && userContains(request, 'collaboration-read'),
    },
    response: {
      toolCalls: [
        {
          id: historyCallId,
          name: 'sessions_history',
          arguments: JSON.stringify({ sessionKey: 'agent:beta:collaboration', limit: 20 }),
        },
      ],
    },
  },
  {
    match: {
      systemMessage: ['Name: Alpha'],
      predicate: (request) => {
        const history = result(request, historyCallId);
        return (
          userContains(request, 'collaboration-read') &&
          history?.sessionKey === 'agent:beta:collaboration' &&
          Array.isArray(history.messages) &&
          history.messages.some(
            (message: unknown) =>
              typeof message === 'object' &&
              message !== null &&
              'role' in message &&
              message.role === 'assistant' &&
              'content' in message &&
              JSON.stringify(message.content)?.includes('collaboration-pong'),
          )
        );
      },
    },
    response: { content: 'collaboration-history-verified' },
  },
  {
    match: {
      systemMessage: ['Name: Alpha'],
      predicate: (request) =>
        userContains(request, 'collaboration-pong') &&
        request.messages.some(
          ({ role, content }) =>
            role === 'system' &&
            /Another session returned|Agent-to-agent reply step:/u.test(
              getTextContent(content) ?? '',
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

export const openClawCollaborationScenario: OpenClawAIMockScenario = {
  id: 'openclaw-collaboration',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  fixtures,
  finalResponses: [
    'collaboration-ready',
    'collaboration-pong',
    'collaboration-exchange-complete',
    'collaboration-history-verified',
  ],
  systemPromptSignals: [],
  toolCalls: [
    { id: sendCallId, name: 'sessions_send' },
    { id: historyCallId, name: 'sessions_history' },
  ],
  skipToolSearch: (request) =>
    !['collaboration-send', 'collaboration-read'].some((marker) => userContains(request, marker)),
};
