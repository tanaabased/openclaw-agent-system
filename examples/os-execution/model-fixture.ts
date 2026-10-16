import { getTextContent, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const modes = ['pipe', 'pty'] as const;
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
              yieldMs: 120000,
            }),
            id: callId,
            name: 'exec',
          },
        ],
      },
    },
    {
      match: {
        hasToolResult: true,
        model,
        predicate: (request) =>
          openClawAIMockToolResultText(request.messages, callId)?.includes(
            'os-execution-verified',
          ) === true,
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
  toolCalls: modes.map((mode) => ({ id: `call_os_execution_${mode}`, name: 'exec' })),
};
