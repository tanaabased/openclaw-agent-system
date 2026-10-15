import openClawAIMockEvidence from './aimock-evidence.ts';
import type { OpenClawAIMockScenario } from './aimock-scenario.ts';
import { matchesOpenClawAIMockToolCallId } from './aimock-tool-result.ts';

type JournalEntry = Parameters<typeof openClawAIMockEvidence>[1][number];

interface OpenClawAIMockDiagnostics {
  scenario: string;
  failed: boolean;
  error?: string;
  requests?: Array<{
    path: string;
    status: number;
    matched: boolean;
    results: Array<{ callId: string | undefined; content: string }>;
  }>;
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
