import { getTextContent, type ChatCompletionRequest } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const identity = 'Name: Automation Tanaabot';
const prompt = 'Acknowledge the scheduled owning-agent context.';

function matchesPrompt(request: ChatCompletionRequest): boolean {
  const systemText = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
  const userMessage = request.messages.findLast((message) => message.role === 'user');
  const checks = {
    model: model.test(request.model),
    identity: systemText.includes(identity),
    prompt: (getTextContent(userMessage?.content ?? null) ?? '').includes(prompt),
    noToolResult: !request.messages.some((message) => message.role === 'tool'),
  };
  const matches = Object.values(checks).every(Boolean);
  if (!matches) console.error(`automation-fixture-match: ${JSON.stringify(checks)}`);
  return matches;
}

export const automationExampleScenario: OpenClawAIMockScenario = {
  id: 'automations',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  finalResponses: ['automation-owner-ready'],
  systemPromptSignals: [identity],
  userPromptSignals: [prompt],
  toolCalls: [],
  fixtures: [
    {
      match: { predicate: matchesPrompt },
      response: { id: 'automation-owner-final', content: 'automation-owner-ready' },
    },
  ],
};
