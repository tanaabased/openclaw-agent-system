import { appendFileSync } from 'node:fs';

import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;

function reportInput(request: ChatCompletionRequest, diagnose = false) {
  const reject = (field: string) => {
    if (diagnose) process.stderr.write(`automation command report fixture rejected: ${field}\n`);
    return undefined;
  };
  const marker = 'Captured command result (data):\n<captured_result>\n';
  const messages = request.messages
    .filter((message) => message.role === 'user')
    .map((message) => getTextContent(message.content) ?? '');
  // codex carries stop-hook feedback in xml; retain the original literal copy target.
  const promptIndex = messages.findLastIndex(
    (text) => text.includes(marker) && !text.trimStart().startsWith('<hook_prompt '),
  );
  const content = messages[promptIndex] ?? '';
  const bodyMarker = '\n<response_body>\n';
  const at = content.lastIndexOf(marker);
  if (at < 0) return reject('captured result marker');
  try {
    const captured = content.slice(at + marker.length);
    const capturedEnd = captured.indexOf('\n</captured_result>');
    if (capturedEnd < 0) return reject('captured result closing tag');
    const value = JSON.parse(captured.slice(0, capturedEnd));
    const bodyAt = captured.indexOf(bodyMarker, capturedEnd);
    const bodyEnd = captured.indexOf('\n</response_body>', bodyAt + bodyMarker.length);
    const body =
      bodyAt < 0 || bodyEnd < 0 ? undefined : captured.slice(bodyAt + bodyMarker.length, bodyEnd);
    const failure = value.id === 'failure';
    const checks = {
      id: failure || value.id === 'success',
      runLine: typeof value.runLine === 'string',
      executionId: typeof value.executionId === 'string',
      outcome: value.outcome === (failure ? 'error' : 'success'),
      reason: value.reason === (failure ? 'Exit 17' : 'Exit 0'),
      stdout: value.stdout?.body === (failure ? 'Everything succeeded!\n' : ''),
      stderr:
        value.stderr?.body === (failure ? 'Archive delta failed: destination unavailable.\n' : ''),
      presentation: value.presentation?.kind === (failure ? 'fallback' : 'preferred'),
      reportBody:
        failure ||
        body ===
          ['alpha', 'beta', 'gamma', 'delta']
            .map(
              (source) =>
                `> ## ${source === 'alpha' ? '⚠️' : '✅'} Source ${source}\n>\n> Archive ${source} saved${source === 'alpha' ? '; activation unverified' : ''}.`,
            )
            .join('\n\n') +
            `\n\n**Runner result:** ✅ success · Exit 0\n\n${value.runLine}`,
      footer:
        !failure ||
        (typeof value.runLine === 'string' &&
          typeof value.presentation?.footer === 'string' &&
          value.presentation.footer.includes(value.runLine)),
    };
    const mismatch = Object.entries(checks).find(([, passed]) => !passed);
    if (mismatch) return reject(`field ${mismatch[0]}`);
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
    return reject('captured result parsing');
  }
}

const reportFixture: Fixture = {
  match: { model, predicate: (request) => Boolean(reportInput(request, true)) },
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
