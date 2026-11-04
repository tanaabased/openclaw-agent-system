import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import currentMessages, { isOpenClawAIMockRuntimeContext } from '../../scripts/aimock-messages.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;

function reportInput(request: ChatCompletionRequest) {
  const user = currentMessages(request).find(
    (message) =>
      message.role === 'user' &&
      !isOpenClawAIMockRuntimeContext(getTextContent(message.content) ?? ''),
  );
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
        value.stdout?.body === '' &&
        value.presentation?.kind === 'preferred' &&
        value.presentation.body ===
          `> ## ⚠️ Source alpha\n>\n> Archive alpha saved; activation unverified.\n\n## Source beta\n\nArchive beta already current.\n\n**Runner result:** ✅ success · Exit 0\n\n${value.runLine}` &&
        value.stderr?.body === '') ||
      (value.id === 'failure' &&
        value.outcome === 'error' &&
        value.reason === 'Exit 17' &&
        value.stdout?.body === 'Everything succeeded!\n' &&
        value.stderr?.body === 'Archive delta failed: destination unavailable.\n' &&
        value.presentation?.kind === 'fallback' &&
        typeof value.presentation.footer === 'string' &&
        value.presentation.footer.includes(value.runLine))
    )
      return value as {
        id: 'success' | 'failure';
        runLine: string;
        presentation: { kind: 'preferred'; body: string } | { kind: 'fallback'; footer: string };
      };
  } catch {
    return;
  }
}

const reportFixture: Fixture = {
  match: { model, predicate: (request) => Boolean(reportInput(request)) },
  response: (request) => {
    const input = reportInput(request)!;
    return {
      id: `report-${input.id}`,
      content:
        input.presentation.kind === 'preferred'
          ? input.presentation.body
          : `> ## ❌ failure failed\n>\n> Archive delta failed: destination unavailable.\n\n${input.presentation.footer}`,
    };
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
