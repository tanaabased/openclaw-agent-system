import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

export const agentExampleFinalResponse = 'Ready.';

const agentSystemPromptSignals = ['Name: Data'] as const;
const agentUserPromptSignals = ['Acknowledge readiness without using tools.'] as const;

function hasAgentPrompt(request: ChatCompletionRequest): boolean {
  const userText = request.messages
    .filter((message) => message.role === 'user')
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
  return agentUserPromptSignals.every((signal) => userText.includes(signal));
}

const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: hasAgentPrompt,
      systemMessage: [...agentSystemPromptSignals],
    },
    response: {
      content: agentExampleFinalResponse,
      id: 'agent-system-example-agent-final-response',
    },
  },
];

export const agentExampleScenario: OpenClawAIMockScenario = {
  finalResponses: [agentExampleFinalResponse],
  fixtures,
  id: 'agent',
  model: {
    match: /^(?:aimock\/)?gpt-5\.5$/u,
    reference: 'aimock/gpt-5.5',
  },
  systemPromptSignals: agentSystemPromptSignals,
  toolCalls: [],
  userPromptSignals: agentUserPromptSignals,
};
