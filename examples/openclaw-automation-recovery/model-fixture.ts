import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const identity = 'Name: Automation Recovery Tanaabot';
const prompt = 'Acknowledge the scheduled owning-agent context.';

function reportInput(request: ChatCompletionRequest) {
  const user = request.messages.findLast((message) => message.role === 'user');
  const content = user ? (getTextContent(user.content) ?? '') : '';
  const marker = 'Captured command result (data):\n';
  const at = content.lastIndexOf(marker);
  if (at < 0) return;
  try {
    const value = JSON.parse(content.slice(at + marker.length).trim());
    if (value.id === 'identity' && value.outcome === 'success' && typeof value.runLine === 'string')
      return value as { runLine: string };
  } catch {
    return;
  }
}
const reportFixture: Fixture = {
  match: { model, predicate: (request) => Boolean(reportInput(request)) },
  response: (request) => ({
    id: 'recovered-report',
    content: `> ## ✅ Identity completed\n>\n> ${reportInput(request)!.runLine}\n>\n> The command completed successfully.`,
  }),
};

function matchesPrompt(request: ChatCompletionRequest): boolean {
  const systemText = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
  const hasPrompt = request.messages.some(
    (message) =>
      message.role === 'user' && (getTextContent(message.content) ?? '').includes(prompt),
  );
  const checks = {
    model: model.test(request.model),
    identity: systemText.includes(identity),
    prompt: hasPrompt,
    noToolResult: !request.messages.some((message) => message.role === 'tool'),
    reportHistory: request.messages.some(
      (message) =>
        message.role === 'assistant' &&
        (getTextContent(message.content) ?? '').includes('✅ Identity completed'),
    ),
  };
  const matches = Object.values(checks).every(Boolean);
  if (!matches) process.stderr.write(`automation-fixture-match: ${JSON.stringify(checks)}\n`);
  return matches;
}

export const automationRecoveryScenario: OpenClawAIMockScenario = {
  id: 'openclaw-automation-recovery',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  finalResponses: ['automation-owner-ready'],
  dynamicFinalResponseFixtures: [reportFixture],
  skipToolSearch: (request) => Boolean(reportInput(request)),
  systemPromptSignals: [identity],
  userPromptSignals: [prompt],
  toolCalls: [],
  fixtures: [
    reportFixture,
    {
      match: { predicate: matchesPrompt },
      response: { id: 'automation-owner-final', content: 'automation-owner-ready' },
    },
  ],
};
