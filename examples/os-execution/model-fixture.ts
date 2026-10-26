import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const modes = ['pipe', 'pty'] as const;
// polls can return as soon as output arrives; native exec owns the elapsed-time limit.
const maxPolls = 64;
const pollIds = (mode: string) =>
  Array.from({ length: maxPolls }, (_, index) => `call_os_execution_${mode}_poll_${index + 1}`);

function latestResult(request: ChatCompletionRequest, mode: string) {
  const ids = [`call_os_execution_${mode}`, ...pollIds(mode)];
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const text = openClawAIMockToolResultText(request.messages, ids[index]!);
    if (text !== undefined) return { index, text };
  }
  return undefined;
}

function sessionId(request: ChatCompletionRequest, mode: string) {
  return openClawAIMockToolResultText(request.messages, `call_os_execution_${mode}`)?.match(
    /Command still running \(session ([A-Za-z0-9_-]+), pid [0-9]+\)/u,
  )?.[1];
}

const fixtures: Fixture[] = modes.flatMap((mode) => {
  const callId = `call_os_execution_${mode}`;
  return [
    {
      match: {
        hasToolResult: false,
        model,
        toolName: 'exec',
        predicate: (request) =>
          request.messages.some(
            (message) =>
              message.role === 'user' &&
              getTextContent(message.content)?.includes(`Run the native execution ${mode} probe`),
          ),
      },
      response: {
        id: `${callId}_response`,
        toolCalls: [
          {
            arguments: JSON.stringify({
              command: `sh ./probe.sh ${mode}`,
              pty: mode === 'pty',
              timeoutSeconds: 120,
              yieldMs: 1000,
            }),
            id: callId,
            name: 'exec',
          },
        ],
      },
    },
    ...pollIds(mode).map((id, index): Fixture => ({
      match: {
        hasToolResult: true,
        model,
        toolName: 'process',
        predicate: (request) => {
          const latest = latestResult(request, mode);
          const session = sessionId(request, mode);
          return (
            session !== undefined &&
            latest?.index === index &&
            (index === 0
              ? latest.text.includes(`Command still running (session ${session},`)
              : latest.text.includes('Process still running.') ||
                latest.text.includes('No new output; this session may be waiting for input.'))
          );
        },
      },
      response: (request) => ({
        toolCalls: [
          {
            id,
            name: 'process',
            arguments: JSON.stringify({
              action: 'poll',
              sessionId: sessionId(request, mode),
              timeout: 30000,
            }),
          },
        ],
      }),
    })),
    {
      match: {
        hasToolResult: true,
        model,
        predicate: (request) => {
          const latest = latestResult(request, mode);
          const verified = [callId, ...pollIds(mode)].some((id) =>
            openClawAIMockToolResultText(request.messages, id)?.includes('os-execution-verified'),
          );
          return (
            verified &&
            latest !== undefined &&
            (latest.index === 0
              ? sessionId(request, mode) === undefined
              : /Process exited with code 0\./u.test(latest.text))
          );
        },
      },
      response: { content: 'os-execution-ready', id: `${callId}_final` },
    },
  ];
});

export const osExecutionExampleScenario: OpenClawAIMockScenario = {
  finalResponses: ['os-execution-ready'],
  fixtures,
  id: 'os-execution',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  systemPromptSignals: [],
  toolCalls: modes.flatMap((mode) => [
    { id: `call_os_execution_${mode}`, name: 'exec' },
    ...pollIds(mode).map((id) => ({ id, name: 'process' })),
  ]),
};
