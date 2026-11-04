import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;

function reportInput(request: ChatCompletionRequest) {
  const marker = 'Captured command result (data):\n';
  const content =
    request.messages
      .filter((message) => message.role === 'user')
      .map((message) => getTextContent(message.content) ?? '')
      .findLast((text) => text.includes(marker)) ?? '';
  const bodyMarker = '\n\nResponse body (copy literally from the next line to end of message):\n';
  const at = content.lastIndexOf(marker);
  if (at < 0) return;
  try {
    const captured = content.slice(at + marker.length);
    const bodyAt = captured.indexOf(bodyMarker);
    const value = JSON.parse((bodyAt < 0 ? captured : captured.slice(0, bodyAt)).trim());
    const body = bodyAt < 0 ? undefined : captured.slice(bodyAt + bodyMarker.length);
    if (typeof value.runLine !== 'string' || typeof value.executionId !== 'string') return;
    if (
      (value.id === 'success' &&
        value.outcome === 'success' &&
        value.reason === 'Exit 0' &&
        value.stdout?.body === '' &&
        value.presentation?.kind === 'preferred' &&
        body ===
          ['alpha', 'beta', 'gamma', 'delta']
            .map(
              (source) =>
                `> ## ${source === 'alpha' ? '⚠️' : '✅'} Source ${source}\n>\n> Archive ${source} saved${source === 'alpha' ? '; activation unverified' : ''}.`,
            )
            .join('\n\n') +
            `\n\n**Runner result:** ✅ success · Exit 0\n\n${value.runLine}` &&
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
      return {
        ...value,
        body,
        correction: content.includes('Replace the rejected response in full.'),
      } as {
        id: 'success' | 'failure';
        runLine: string;
        body?: string;
        correction: boolean;
        presentation: { kind: 'preferred' } | { kind: 'fallback'; footer: string };
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
          ? input.correction
            ? input.body!
            : input.body!.replaceAll('\n\n', '\n>\n') + '\n\n' + JSON.stringify(input.body)
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
