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
export const githubExampleCacheChecks = ['hit', 'refill', 'mutation'].map((phase) => ({
  callId: `call_example_github_cache_${phase}`,
  prompt: `Identify the EMORI GitHub account for the cache ${phase} check.`,
}));

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
  ...githubExampleCacheChecks.flatMap(({ prompt, callId }) =>
    githubIdentityFixtures(prompt, 'emoriwan', callId),
  ),
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
    ...githubExampleCacheChecks.map(({ callId }) => ({ id: callId, name: 'agent_system_github' })),
  ],
  userPromptSignals: [],
};
