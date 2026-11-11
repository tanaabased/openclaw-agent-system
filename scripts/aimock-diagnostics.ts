import { getTextContent, type ChatCompletionRequest } from '@copilotkit/aimock';

import openClawAIMockEvidence from './aimock-evidence.ts';
import type { OpenClawAIMockScenario } from './aimock-scenario.ts';
import { matchesOpenClawAIMockToolCallId } from './aimock-tool-result.ts';
import { normalizeToolSearchRequest } from './aimock-tool-search.ts';

type JournalEntry = Parameters<typeof openClawAIMockEvidence>[1][number];

interface OpenClawAIMockDiagnostics {
  scenario: string;
  failed: boolean;
  error?: string;
  requests?: Array<{
    method: string;
    path: string;
    status: number;
    matched: boolean;
    intakeCondition?: ReturnType<typeof intakeConditionDiagnostic>;
    toolCalls: Array<{ id: string | undefined; name: string | undefined }>;
    checks: {
      model: boolean;
      systemPrompt: boolean;
      userPrompt: boolean;
      toolSearch: boolean;
      tools: Record<string, boolean>;
    };
    results: Array<{ callId: string | undefined; content: string }>;
  }>;
}

/** Extract only generated condition diagnostics, never the surrounding prompt or provider text. */
function intakeConditionDiagnostic(request: ChatCompletionRequest) {
  for (const message of (request.messages ?? [])
    .filter((item) => item.role === 'user')
    .slice(-4)
    .reverse()) {
    const text = getTextContent(message.content) ?? '';
    const failure =
      /The (dispatch|intake) condition failed \(([a-z][a-z0-9-]{0,100})\) after (\d{1,12}) ms\./u.exec(
        text,
      );
    if (failure) return { phase: failure[1], reason: failure[2], elapsedMs: Number(failure[3]) };
    const match = /Intake check: (\{[^\n]{1,4096}?\})\. /u.exec(text);
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]!);
      const label = (input: unknown) =>
        typeof input === 'string' && /^[a-z][a-z0-9-]{0,100}$/u.test(input) ? input : undefined;
      return {
        phase: label(value.phase),
        reason: label(value.reason),
        elapsedMs:
          Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0
            ? value.elapsedMs
            : undefined,
      };
    } catch {
      // A malformed diagnostic must not expose the rest of the prompt.
    }
  }
  return undefined;
}

function requestChecks(scenario: OpenClawAIMockScenario, entry: JournalEntry) {
  const request = entry.body as ChatCompletionRequest;
  const text = (role: string) =>
    (request.messages ?? [])
      .filter((message) => message.role === role)
      .map((message) => getTextContent(message.content) ?? '')
      .join('\n');
  const normalized = (() => {
    try {
      return normalizeToolSearchRequest(
        request,
        scenario.expectedDeniedToolCalls,
        scenario.expectedInvalidToolCalls,
      );
    } catch {
      return undefined;
    }
  })();
  return {
    model: scenario.model.match.test(request.model ?? ''),
    systemPrompt: scenario.systemPromptSignals.every((signal) => text('system').includes(signal)),
    userPrompt: (scenario.userPromptSignals ?? []).every((signal) => text('user').includes(signal)),
    toolSearch: normalized !== undefined,
    tools: Object.fromEntries(
      scenario.toolCalls.map(({ name }) => [
        name,
        normalized?.tools?.some((tool) => tool.function.name === name) === true,
      ]),
    ),
  };
}

/** Report bounded, scenario-owned tool results without prompts or transport credentials. */
export default function openClawAIMockDiagnostics(
  scenario: OpenClawAIMockScenario,
  entries: readonly JournalEntry[],
): OpenClawAIMockDiagnostics {
  const error = (() => {
    try {
      openClawAIMockEvidence(scenario, entries);
      return undefined;
    } catch (cause) {
      return (cause instanceof Error ? cause.message : String(cause)).slice(0, 4096);
    }
  })();
  const failed =
    error !== undefined ||
    entries.some(
      (entry) =>
        entry.body !== null && (entry.response.fixture === null || entry.response.status >= 400),
    );
  if (!failed && !entries.some((entry) => entry.body !== null))
    return { scenario: scenario.id, failed: false };
  const firstFailure = entries.findIndex(
    (entry) =>
      entry.body !== null && (entry.response.fixture === null || entry.response.status >= 400),
  );
  const recent = entries
    .flatMap((entry, index) =>
      entry.body !== null &&
      (index >= entries.length - 4 ||
        entry.response.fixture === null ||
        entry.response.status >= 400)
        ? [index]
        : [],
    )
    .slice(firstFailure === -1 ? -6 : -5);
  const relevant = (
    firstFailure === -1
      ? recent
      : [firstFailure, ...recent.filter((index) => index !== firstFailure)]
  ).map((index) => entries[index]!);
  return {
    scenario: scenario.id,
    failed,
    ...(error === undefined ? {} : { error }),
    requests: relevant.map((entry) => ({
      method: entry.method,
      path: entry.path,
      status: entry.response.status,
      matched: entry.response.fixture !== null,
      ...(intakeConditionDiagnostic(entry.body as ChatCompletionRequest)
        ? { intakeCondition: intakeConditionDiagnostic(entry.body as ChatCompletionRequest) }
        : {}),
      toolCalls: (entry.body?.messages ?? [])
        .flatMap((message) => message.tool_calls ?? [])
        .slice(-3)
        .map((call) => ({ id: call.id?.slice(0, 128), name: call.function?.name?.slice(0, 128) })),
      checks: requestChecks(scenario, entry),
      results: (entry.body?.messages ?? [])
        .filter(
          (message) =>
            message.role === 'tool' &&
            scenario.toolCalls.some((call) =>
              matchesOpenClawAIMockToolCallId(message.tool_call_id ?? '', call.id),
            ),
        )
        .slice(-3)
        .map((message) => ({
          callId: message.tool_call_id,
          content: (typeof message.content === 'string'
            ? message.content
            : (JSON.stringify(message.content) ?? '')
          ).slice(-4096),
        })),
    })),
  };
}
