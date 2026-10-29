import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.(?:5|4-nano)$/u;
const execCall = 'call_runtime_exec';
// polling may return early on output; native exec owns the three-minute deadline.
const execPollCalls = Array.from({ length: 16 }, (_, index) => `call_runtime_poll_${index + 1}`);
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

function openClawExecResult(request: ChatCompletionRequest) {
  const ids = [execCall, ...execPollCalls];
  for (let index = ids.length - 1; index >= 0; index--) {
    const text = openClawAIMockToolResultText(request.messages, ids[index]!);
    if (text !== undefined) return { index, text };
  }
  return undefined;
}

function openClawExecSession(request: ChatCompletionRequest) {
  return openClawAIMockToolResultText(request.messages, execCall)?.match(
    /Command still running \(session ([A-Za-z0-9_-]+), pid [0-9]+\)/u,
  )?.[1];
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
            timeoutSeconds: 180,
            yieldMs: 1000,
          }),
        },
      ],
    },
  },
  ...execPollCalls.map((id, index): Fixture => ({
    match: {
      model,
      hasToolResult: true,
      toolName: 'process',
      predicate: (request) => {
        const latest = openClawExecResult(request);
        const session = openClawExecSession(request);
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
            sessionId: openClawExecSession(request),
            timeout: 30000,
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
        const latest = openClawExecResult(request);
        const verified = [execCall, ...execPollCalls].some((id) =>
          /^runtime-boundary-verified\r?$/mu.test(
            openClawAIMockToolResultText(request.messages, id) ?? '',
          ),
        );
        return (
          verified &&
          latest !== undefined &&
          (latest.index === 0
            ? openClawExecSession(request) === undefined &&
              !/Command timed out|Process exited with code [1-9]/u.test(latest.text)
            : openClawExecSession(request) !== undefined &&
              /Process exited with code 0\./u.test(latest.text))
        );
      },
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
    ...execPollCalls.map((id) => ({ id, name: 'process' })),
    { id: codexExecCall, name: 'exec_command' },
    ...codexPollCalls.map((id) => ({ id, name: 'write_stdin' })),
  ],
};
