import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

function userContains(request: ChatCompletionRequest, text: string): boolean {
  const prompt = request.messages
    .filter((entry) => entry.role === 'user')
    .map((entry) => getTextContent(entry.content) ?? '')
    .findLast(
      (content) => !content.trimStart().startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>'),
    );
  return prompt?.includes(text) ?? false;
}
function receivedPeerReply(request: ChatCompletionRequest, callId: string, reply: string): boolean {
  try {
    const result = JSON.parse(openClawAIMockToolResultText(request.messages, callId) ?? 'null') as {
      status?: string;
      reply?: string;
    } | null;
    return result?.status === 'ok' && result.reply === reply;
  } catch {
    return false;
  }
}

const peers = [
  { id: 'beta', name: 'Beta', marker: 'collaboration' },
  { id: 'external', name: 'External', marker: 'external' },
];
const historyCallId = 'call_external_history';
const fixtures: Fixture[] = peers.flatMap(({ id, name, marker }): Fixture[] => {
  const callId = `call_${marker}_send`;
  return [
    {
      match: {
        hasToolResult: false,
        systemMessage: [`Name: ${name}`],
        predicate: (request) => userContains(request, `${marker}-ready`),
      },
      response: { content: `${marker}-ready` },
    },
    {
      match: {
        hasToolResult: false,
        systemMessage: [`Name: ${name}`],
        predicate: (request) => userContains(request, `${marker}-ping`),
      },
      response: { content: `${marker}-pong` },
    },
    {
      match: {
        hasToolResult: false,
        toolName: 'sessions_send',
        systemMessage: ['Name: Alpha'],
        predicate: (request) => userContains(request, `${marker}-send`),
      },
      response: {
        toolCalls: [
          {
            id: callId,
            name: 'sessions_send',
            arguments: JSON.stringify({
              sessionKey: `agent:${id}:collaboration`,
              message: `${marker}-ping`,
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
          userContains(request, `${marker}-send`) &&
          receivedPeerReply(request, callId, `${marker}-pong`),
      },
      response: { content: `${marker}-exchange-complete` },
    },
    {
      match: {
        systemMessage: ['Name: Alpha'],
        predicate: (request) =>
          userContains(request, `${marker}-pong`) &&
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
        systemMessage: [`Name: ${name}`],
        predicate: (request) => userContains(request, 'Agent-to-agent announce step.'),
      },
      response: { content: 'ANNOUNCE_SKIP' },
    },
  ];
});
fixtures.push(
  {
    match: {
      hasToolResult: false,
      toolName: 'sessions_history',
      systemMessage: ['Name: Alpha'],
      predicate: (request) => userContains(request, 'external-read'),
    },
    response: {
      toolCalls: [
        {
          id: historyCallId,
          name: 'sessions_history',
          arguments: JSON.stringify({
            sessionKey: 'agent:external:collaboration',
            limit: 20,
          }),
        },
      ],
    },
  },
  {
    match: {
      hasToolResult: true,
      predicate: (request) => {
        if (!userContains(request, 'external-read')) return false;
        try {
          const result = JSON.parse(
            openClawAIMockToolResultText(request.messages, historyCallId) ?? 'null',
          ) as {
            messages?: Array<{ role?: string; content?: unknown }>;
          } | null;
          return (
            result?.messages?.some(
              (message) =>
                message.role === 'assistant' &&
                JSON.stringify(message.content).includes('external-ready'),
            ) ?? false
          );
        } catch {
          return false;
        }
      },
    },
    response: { content: 'external-history-verified' },
  },
);

export const collaborationExampleScenario: OpenClawAIMockScenario = {
  id: 'collaboration',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  fixtures,
  finalResponses: [
    ...peers.flatMap(({ marker }) => [
      `${marker}-ready`,
      `${marker}-pong`,
      `${marker}-exchange-complete`,
    ]),
    'external-history-verified',
  ],
  systemPromptSignals: [],
  toolCalls: [
    ...peers.map(({ marker }) => ({ id: `call_${marker}_send`, name: 'sessions_send' })),
    { id: historyCallId, name: 'sessions_history' },
  ],
  skipToolSearch: (request) =>
    !['collaboration-send', 'external-send', 'external-read'].some((marker) =>
      userContains(request, marker),
    ),
};
