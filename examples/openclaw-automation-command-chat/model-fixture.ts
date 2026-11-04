import { appendFileSync } from 'node:fs';

import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;

function reportInput(request: ChatCompletionRequest) {
  const marker = 'Captured command result (data):\n';
  const messages = request.messages
    .filter((message) => message.role === 'user')
    .map((message) => getTextContent(message.content) ?? '');
  // codex carries stop-hook feedback in xml; retain the original literal copy target.
  const promptIndex = messages.findLastIndex(
    (text) => text.includes(marker) && !text.trimStart().startsWith('<hook_prompt '),
  );
  const content = messages[promptIndex] ?? '';
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
        correction: messages
          .slice(promptIndex)
          .some((text) => text.includes('Replace the rejected response in full.')),
        prompts: messages.slice(promptIndex),
      } as {
        id: 'success' | 'failure';
        runLine: string;
        body?: string;
        correction: boolean;
        executionId: string;
        prompts: string[];
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
    const response = {
      id: `report-${input.executionId}-${input.correction ? 'corrected' : 'initial'}`,
      content:
        input.presentation.kind === 'preferred'
          ? input.correction
            ? input.body!
            : input.body!.replaceAll('\n\n', '\n>\n') + '\n\n' + JSON.stringify(input.body)
          : `> ## ❌ failure failed\n>\n> Archive delta failed: destination unavailable.\n\n${input.presentation.footer}`,
    };
    if (process.env.COMMAND_CHAT_EVIDENCE_PATH)
      appendFileSync(
        process.env.COMMAND_CHAT_EVIDENCE_PATH,
        JSON.stringify({
          executionId: input.executionId,
          correction: input.correction,
          prompts: input.prompts,
          prepared: input.body,
          response: response.content,
        }) + '\n',
      );
    return response;
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
