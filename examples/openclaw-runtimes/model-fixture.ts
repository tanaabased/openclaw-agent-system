import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.(?:5|4-nano)$/u;
const execCall = 'call_runtime_exec';
const codexExecCall = 'call_runtime_codex_exec';
const codexPollCalls = [1, 2, 3].map((attempt) => `call_runtime_codex_poll_${attempt}`);

function codexExecResult(request: ChatCompletionRequest) {
  const ids = [codexExecCall, ...codexPollCalls];
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const text = openClawAIMockToolResultText(request.messages, ids[index]!);
    if (text !== undefined) return { index, text };
  }
  return undefined;
}

function codexExecSession(request: ChatCompletionRequest): number | undefined {
  const initial = openClawAIMockToolResultText(request.messages, codexExecCall);
  const match = initial?.match(/^Process running with session ID ([0-9]+)\r?$/mu);
  const sessionId = match ? Number(match[1]) : undefined;
  return sessionId !== undefined && Number.isSafeInteger(sessionId) ? sessionId : undefined;
}

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
      toolName: 'exec_command',
      predicate: (request) => userIncludes(request, 'agent-system-runtime-probe codex'),
    },
    response: {
      toolCalls: [
        {
          id: codexExecCall,
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: 'agent-system-runtime-probe codex',
            yield_time_ms: 30000,
            max_output_tokens: 1000,
          }),
        },
      ],
    },
  },
  ...codexPollCalls.map((callId, index): Fixture => ({
    match: {
      model: /^gpt-5\.4-nano$/u,
      hasToolResult: true,
      toolName: 'write_stdin',
      predicate: (request) => {
        const latest = codexExecResult(request);
        const sessionId = codexExecSession(request);
        return (
          latest?.index === index &&
          sessionId !== undefined &&
          latest.text.split(/\r?\n/u).includes(`Process running with session ID ${sessionId}`)
        );
      },
    },
    response: (request) => ({
      toolCalls: [
        {
          id: callId,
          name: 'write_stdin',
          arguments: JSON.stringify({
            session_id: codexExecSession(request),
            chars: '',
            yield_time_ms: 300000,
            max_output_tokens: 1000,
          }),
        },
      ],
    }),
  })),
  {
    match: {
      model,
      hasToolResult: true,
      predicate: (request) => {
        const latest = codexExecResult(request);
        return (
          latest !== undefined &&
          /^Process exited with code 0\r?$/mu.test(latest.text) &&
          /^runtime-boundary-verified\r?$/mu.test(latest.text)
        );
      },
    },
    response: { content: 'runtime-codex-exec-ready', id: 'runtime-codex-exec-final' },
  },
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
];

export const runtimeBoundaryScenario: OpenClawAIMockScenario = {
  id: 'openclaw-runtimes',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  fixtures,
  finalResponses: ['runtime-codex-exec-ready', 'runtime-exec-ready'],
  systemPromptSignals: [],
  toolCalls: [
    { id: execCall, name: 'exec' },
    { id: codexExecCall, name: 'exec_command' },
    ...codexPollCalls.map((id) => ({ id, name: 'write_stdin' })),
  ],
};
