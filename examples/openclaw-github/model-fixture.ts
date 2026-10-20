import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;

export const githubExampleTanaabotPrompt =
  'Use the preferred configured GitHub integration to identify the Tanaabot account.';
export const githubExampleEmoriPrompt =
  'Use the preferred configured GitHub integration to identify the EMORI account.';

export const githubExampleTanaabotCallId = 'call_example_github_tanaabot';
export const githubExampleEmoriCallId = 'call_example_github_emori';
export const githubExampleValidationPrompt =
  'Use the managed GitHub tool to attempt setting git_protocol to ssh and report the configuration boundary.';
export const githubExampleValidationCallId = 'call_example_github_validation';
function roleText(request: ChatCompletionRequest, role: string): string {
  return request.messages
    .filter((message) => message.role === role)
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
}

function hasPrompt(request: ChatCompletionRequest, prompt: string): boolean {
  return roleText(request, 'user').includes(prompt);
}

function hasExpectedResult(
  request: ChatCompletionRequest,
  callId: string,
  expectedLogin: string,
): boolean {
  return openClawAIMockToolResultText(request.messages, callId)?.includes(expectedLogin) === true;
}

function githubIdentityFixtures(prompt: string, expectedLogin: string, callId: string): Fixture[] {
  return [
    {
      match: {
        hasToolResult: false,
        model,
        predicate: (request) => hasPrompt(request, prompt),
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
          hasPrompt(request, prompt) && hasExpectedResult(request, callId, expectedLogin),
      },
      response: {
        content: expectedLogin,
        id: `${callId}_final_response`,
      },
    },
  ];
}

const fixtures: Fixture[] = [
  ...githubIdentityFixtures(githubExampleTanaabotPrompt, 'tanaabot', githubExampleTanaabotCallId),
  ...githubIdentityFixtures(githubExampleEmoriPrompt, 'emoriwan', githubExampleEmoriCallId),
  {
    match: {
      hasToolResult: false,
      model,
      predicate: (request) => hasPrompt(request, githubExampleValidationPrompt),
      toolName: 'agent_system_github',
    },
    response: {
      id: `${githubExampleValidationCallId}_tool_response`,
      toolCalls: [
        {
          arguments: JSON.stringify({ argv: ['config', 'set', 'git_protocol', 'ssh'] }),
          id: githubExampleValidationCallId,
          name: 'agent_system_github',
        },
      ],
    },
  },
  {
    match: {
      hasToolResult: true,
      model,
      predicate: (request) => {
        const result = openClawAIMockToolResultText(
          request.messages,
          githubExampleValidationCallId,
        );
        return (
          hasPrompt(request, githubExampleValidationPrompt) &&
          result?.includes('agent.yaml') === true &&
          result.includes('may not be mutated')
        );
      },
    },
    response: {
      content: 'Managed configuration mutation was rejected.',
      id: `${githubExampleValidationCallId}_final_response`,
    },
  },
];

export const githubExampleScenario: OpenClawAIMockScenario = {
  finalResponses: ['tanaabot', 'emoriwan', 'Managed configuration mutation was rejected.'],
  fixtures,
  id: 'openclaw-github',
  model: {
    match: model,
    reference: 'aimock/gpt-5.5',
  },
  systemPromptSignals: [],
  toolCalls: [
    { id: githubExampleTanaabotCallId, name: 'agent_system_github' },
    { id: githubExampleEmoriCallId, name: 'agent_system_github' },
    { id: githubExampleValidationCallId, name: 'agent_system_github' },
  ],
  userPromptSignals: [],
};
