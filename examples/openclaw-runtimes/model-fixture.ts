import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const execCall = 'call_runtime_exec';
const installCall = 'call_runtime_install';
const doctorCall = 'call_runtime_doctor';

function userIncludes(request: ChatCompletionRequest, signal: string): boolean {
  return request.messages.some(
    ({ role, content }) => role === 'user' && getTextContent(content)?.includes(signal),
  );
}

const fixtures: Fixture[] = [
  {
    match: {
      model,
      hasToolResult: false,
      toolName: 'exec',
      predicate: (request) => userIncludes(request, 'agent-system-runtime-probe openclaw'),
    },
    response: {
      toolCalls: [
        {
          id: execCall,
          name: 'exec',
          arguments: JSON.stringify({
            command: 'agent-system-runtime-probe openclaw',
            host: 'gateway',
            timeoutSeconds: 60,
            yieldMs: 120000,
          }),
        },
      ],
    },
  },
  {
    match: {
      model,
      hasToolResult: true,
      predicate: (request) =>
        openClawAIMockToolResultText(request.messages, execCall)?.includes(
          'runtime-boundary-verified',
        ) === true,
    },
    response: { content: 'runtime-exec-ready', id: 'runtime-exec-final' },
  },
  ...[
    { name: 'agent_system_install', callId: installCall },
    { name: 'agent_system_doctor', callId: doctorCall },
  ].map(({ name, callId }): Fixture => ({
    match: {
      model,
      hasToolResult: false,
      toolName: name,
      predicate: (request) => userIncludes(request, `Call ${name} exactly once`),
    },
    response: {
      toolCalls: [{ id: callId, name, arguments: '{"timeoutMs":600000}' }],
    },
  })),
  {
    match: {
      model,
      hasToolResult: true,
      predicate: (request) => {
        const text = openClawAIMockToolResultText(request.messages, doctorCall);
        if (!text) return false;
        try {
          return Array.isArray(JSON.parse(text).findings);
        } catch {
          return false;
        }
      },
    },
    response: { content: 'runtime-doctor-ready', id: 'runtime-doctor-final' },
  },
  {
    match: {
      model,
      hasToolResult: true,
      predicate: (request) =>
        openClawAIMockToolResultText(request.messages, installCall)
          ?.toLowerCase()
          .includes('denied by user') === true,
    },
    response: { content: 'runtime-install-denied', id: 'runtime-install-final' },
  },
];

export const runtimeBoundaryScenario: OpenClawAIMockScenario = {
  id: 'openclaw-runtimes',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  fixtures,
  finalResponses: ['runtime-exec-ready', 'runtime-doctor-ready', 'runtime-install-denied'],
  expectedErrorToolCallIds: [installCall],
  systemPromptSignals: [],
  toolCalls: [
    { id: execCall, name: 'exec' },
    { id: installCall, name: 'agent_system_install' },
    { id: doctorCall, name: 'agent_system_doctor' },
  ],
};
