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
    path: string;
    status: number;
    matched: boolean;
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

function requestChecks(scenario: OpenClawAIMockScenario, entry: JournalEntry) {
  const request = entry.body as ChatCompletionRequest;
  const text = (role: string) =>
    (request.messages ?? [])
      .filter((message) => message.role === role)
      .map((message) => getTextContent(message.content) ?? '')
      .join('\n');
  const normalized = (() => {
    try {
      return normalizeToolSearchRequest(request, scenario.expectedDeniedToolCalls);
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
  if (!failed) return { scenario: scenario.id, failed: false };
  const relevant = entries
    .filter(
      (entry, index) =>
        entry.body !== null &&
        (index >= entries.length - 4 ||
          entry.response.fixture === null ||
          entry.response.status >= 400),
    )
    .slice(-6);
  return {
    scenario: scenario.id,
    failed: true,
    ...(error === undefined ? {} : { error }),
    requests: relevant.map((entry) => ({
      path: entry.path,
      status: entry.response.status,
      matched: entry.response.fixture !== null,
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
