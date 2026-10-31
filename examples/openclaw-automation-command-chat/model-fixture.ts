import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;

function reportInput(request: ChatCompletionRequest) {
  const user = request.messages.findLast((message) => message.role === 'user');
  const content = user ? (getTextContent(user.content) ?? '') : '';
  const marker = 'Captured command result (data):\n';
  const at = content.lastIndexOf(marker);
  if (at < 0) return;
  try {
    const value = JSON.parse(content.slice(at + marker.length).trim());
    if (typeof value.runLine !== 'string' || typeof value.executionId !== 'string') return;
    if (
      (value.id === 'success' &&
        value.outcome === 'success' &&
        value.reason === 'Exit 0' &&
        value.stdout?.body === 'Archive alpha saved.\n' &&
        value.stderr?.body === '') ||
      (value.id === 'failure' &&
        value.outcome === 'error' &&
        value.reason === 'Exit 17' &&
        value.stdout?.body === 'Everything succeeded!\n' &&
        value.stderr?.body === 'Archive delta failed: destination unavailable.\n')
    )
      return value as { id: 'success' | 'failure'; runLine: string };
  } catch {
    return;
  }
}

const reportFixture: Fixture = {
  match: { model, predicate: (request) => Boolean(reportInput(request)) },
  response: (request) => {
    const input = reportInput(request)!;
    const result =
      input.id === 'success'
        ? '✅ success completed\n>\n> Archive alpha saved.'
        : '❌ failure failed\n>\n> Archive delta failed: destination unavailable.';
    return { id: `report-${input.id}`, content: `> ## ${result}\n>\n> ${input.runLine}` };
  },
};

export const automationCommandChatScenario: OpenClawAIMockScenario = {
  id: 'openclaw-automation-command-chat',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  finalResponses: [],
  dynamicFinalResponseFixtures: [reportFixture],
  skipToolSearch: (request) => Boolean(reportInput(request)),
  systemPromptSignals: [],
  userPromptSignals: ['Captured command result (data):'],
  toolCalls: [],
  fixtures: [reportFixture],
};
