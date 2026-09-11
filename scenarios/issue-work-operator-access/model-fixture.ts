import assert from 'node:assert/strict';
import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';
import hasToolResult from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const initial = ['This is the initial turn for an assigned issue'];
const ownerCall = 'call_operator_owner';
const patchCall = 'call_operator_patch';
const groupCall = 'call_operator_groups';
const replyCall = 'call_operator_reply';
function text(request: ChatCompletionRequest, role: 'user' | 'system'): string {
  return request.messages
    .filter((message) => message.role === role)
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
}
function kind(request: ChatCompletionRequest): string {
  return (
    text(request, 'user').match(/operator-access (flagged|unflagged|denied|work) control/u)?.[1] ??
    ''
  );
}
function noSessions(request: ChatCompletionRequest): void {
  assert.ok(
    !request.tools?.some((tool) => tool.function?.name === 'sessions'),
    'a non-owner or denied turn received sessions',
  );
}
const negative: Fixture = {
  match: {
    model,
    systemMessage: initial,
    hasToolResult: false,
    predicate: (request) => ['unflagged', 'denied'].includes(kind(request)),
  },
  response: (request) => {
    noSessions(request);
    return {
      content: 'The assignment context is prepared; waiting for direction.',
      id: `operator-${kind(request)}-ready`,
    };
  },
};
const systemControl: Fixture = {
  match: {
    model,
    systemMessage: ['The public Work plan has a durable GitHub publication receipt'],
    predicate: (request) => text(request, 'user').includes('operator-access work control'),
  },
  response: (request) => {
    noSessions(request);
    return {
      content:
        '## Blocked\n\nThe acceptance fixture permits session setup only; no repository implementation is requested.',
      id: 'operator-system-control-ready',
    };
  },
};
const fixtures: Fixture[] = [
  systemControl,
  negative,
  {
    match: {
      model,
      systemMessage: initial,
      hasToolResult: false,
      toolName: 'sessions',
      predicate: (request) => ['flagged', 'work'].includes(kind(request)),
    },
    response: {
      id: 'operator-groups',
      toolCalls: [
        { id: groupCall, name: 'sessions', arguments: JSON.stringify({ action: 'group_list' }) },
      ],
    },
  },
  {
    match: {
      model,
      systemMessage: initial,
      toolName: 'sessions',
      predicate: (request) =>
        hasToolResult(request.messages, groupCall) && !hasToolResult(request.messages, patchCall),
    },
    response: {
      id: 'operator-setup',
      toolCalls: [
        {
          id: ownerCall,
          name: 'sessions',
          arguments: JSON.stringify({
            action: 'assign_owner',
            ownerType: 'agent',
            ownerId: 'notification-data',
          }),
        },
        {
          id: patchCall,
          name: 'sessions',
          arguments: JSON.stringify({ action: 'patch', color: 'purple', group: 'GitHub Issues' }),
        },
      ],
    },
  },
  {
    match: {
      model,
      systemMessage: initial,
      predicate: (request) =>
        kind(request) === 'flagged' && hasToolResult(request.messages, patchCall),
    },
    response: {
      content: 'The assignment context is prepared; waiting for direction.',
      id: 'operator-flagged-ready',
    },
  },
  {
    match: {
      model,
      systemMessage: initial,
      predicate: (request) =>
        kind(request) === 'work' &&
        hasToolResult(request.messages, patchCall) &&
        !hasToolResult(request.messages, replyCall),
    },
    response: {
      id: 'operator-work-reply',
      toolCalls: [
        {
          id: replyCall,
          name: 'agent_system_github_reply',
          arguments: JSON.stringify({
            body: "This fixture checks assignment setup. I'm going to verify the requested permission controls without changing repository files.",
          }),
        },
      ],
    },
  },
  {
    match: {
      model,
      systemMessage: initial,
      predicate: (request) =>
        kind(request) === 'work' && hasToolResult(request.messages, replyCall),
    },
    response: {
      content:
        '## Assessment\n\nThe fixture checks session setup.\n\n## Plan\n\nI will preserve the repository and exercise only the declared permission controls.',
      id: 'operator-work-ready',
    },
  },
];

export const operatorAccessScenario = {
  id: 'operator-access',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  fixtures,
  dynamicFinalResponseFixtures: [negative, systemControl],
  finalResponses: [
    'The assignment context is prepared; waiting for direction.',
    '## Assessment\n\nThe fixture checks session setup.\n\n## Plan\n\nI will preserve the repository and exercise only the declared permission controls.',
  ],
  systemPromptSignals: ['Continue the current GitHub issue lifecycle'],
  userPromptSignals: ['operator-access'],
  toolCalls: [
    { id: ownerCall, name: 'sessions' },
    { id: patchCall, name: 'sessions' },
    { id: groupCall, name: 'sessions' },
    { id: replyCall, name: 'agent_system_github_reply' },
  ],
};
