import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const whoAmIPrompt = 'Use the preferred configured GitHub integration';
const identityStatusPrompt = 'Call `github_identity_status`';

export const githubExampleTanaabotCallId = 'call_example_github_tanaabot';
export const githubExampleEmoriCallId = 'call_example_github_emori';
export const githubExampleIdentityStatusCallId = 'call_example_github_identity_status';

function roleText(request: ChatCompletionRequest, role: string): string {
  return request.messages
    .filter((message) => message.role === role)
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
}

function hasPrompt(request: ChatCompletionRequest, agentId: string, prompt: string): boolean {
  return (
    roleText(request, 'system').includes(`Agent ID: \`${agentId}\``) &&
    roleText(request, 'user').includes(prompt)
  );
}

function hasExpectedResult(
  request: ChatCompletionRequest,
  callId: string,
  expectedLogin: string,
): boolean {
  return openClawAIMockToolResultText(request.messages, callId)?.includes(expectedLogin) === true;
}

function githubIdentityFixtures(agentId: string, expectedLogin: string, callId: string): Fixture[] {
  return [
    {
      match: {
        hasToolResult: false,
        model,
        predicate: (request) => hasPrompt(request, agentId, whoAmIPrompt),
        toolName: 'agent_system_github',
      },
      response: {
        id: `${callId}_tool_response`,
        toolCalls: [
          {
            arguments: JSON.stringify({ argv: ['api', 'user', '--jq', '.login'] }),
            id: callId,
            name: 'agent_system_github',
          },
        ],
      },
    },
    {
      match: {
        hasToolResult: true,
        model,
        predicate: (request) =>
          hasPrompt(request, agentId, whoAmIPrompt) &&
          hasExpectedResult(request, callId, expectedLogin),
      },
      response: {
        content: expectedLogin,
        id: `${callId}_final_response`,
      },
    },
  ];
}

const fixtures: Fixture[] = [
  ...githubIdentityFixtures('tanaabot', 'tanaabot', githubExampleTanaabotCallId),
  ...githubIdentityFixtures('emori', 'emoriwan', githubExampleEmoriCallId),
  {
    match: {
      hasToolResult: false,
      model,
      predicate: (request) => hasPrompt(request, 'emori', identityStatusPrompt),
      toolName: 'github_identity_status',
    },
    response: {
      id: 'agent-system-example-github-identity-status-tool-response',
      toolCalls: [
        {
          arguments: '{}',
          id: githubExampleIdentityStatusCallId,
          name: 'github_identity_status',
        },
      ],
    },
  },
  {
    match: {
      hasToolResult: true,
      model,
      predicate: (request) =>
        hasPrompt(request, 'emori', identityStatusPrompt) &&
        hasExpectedResult(request, githubExampleIdentityStatusCallId, 'emoriwan'),
    },
    response: {
      content: 'emoriwan',
      id: `${githubExampleIdentityStatusCallId}_final_response`,
    },
  },
];

export const githubExampleScenario: OpenClawAIMockScenario = {
  finalResponses: ['tanaabot', 'emoriwan'],
  fixtures,
  id: 'github',
  model: {
    match: model,
    reference: 'aimock/gpt-5.5',
  },
  systemPromptSignals: [],
  toolCalls: [
    { id: githubExampleTanaabotCallId, name: 'agent_system_github' },
    { id: githubExampleEmoriCallId, name: 'agent_system_github' },
    { id: githubExampleIdentityStatusCallId, name: 'github_identity_status' },
  ],
  userPromptSignals: [],
};
