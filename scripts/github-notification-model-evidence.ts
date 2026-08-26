import type { GitHubNotificationModelScenario } from './github-notification-model-scenarios.ts';

interface EvidenceMessage {
  content: unknown;
  role: string;
  tool_calls?: Array<{
    function?: { name?: string };
    id?: string;
  }>;
  tool_call_id?: string;
}

interface EvidenceToolDefinition {
  function?: { name?: string };
}

interface GitHubNotificationModelJournalEntry {
  body: {
    messages?: EvidenceMessage[];
    model?: string;
    tools?: EvidenceToolDefinition[];
  } | null;
  method: string;
  path: string;
  response: {
    fixture: { response?: unknown } | null;
    status: number;
  };
}

export interface GitHubNotificationModelToolEvidence {
  callResponseCount: number;
  name: string;
  projectionRequestCount: number;
  resultRequestCount: number;
}

export interface GitHubNotificationModelEvidence {
  finalResponseCount: number;
  model: string;
  promptRequestCount: number;
  provider: 'aimock';
  requestCount: number;
  responsesApiRequestCount: number;
  scenario: string;
  schemaVersion: 2;
  strictMissCount: number;
  successfulFixtureResponseCount: number;
  tools: GitHubNotificationModelToolEvidence[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageText(message: EvidenceMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => record(part)?.text)
    .filter((part): part is string => typeof part === 'string')
    .join('');
}

function roleText(messages: readonly EvidenceMessage[], role: string): string {
  return messages
    .filter((message) => message.role === role)
    .map(messageText)
    .join('\n');
}

function fixtureResponse(entry: GitHubNotificationModelJournalEntry): Record<string, unknown> {
  return record(entry.response.fixture?.response) ?? {};
}

function observedToolCallIds(
  requests: readonly GitHubNotificationModelJournalEntry[],
  name: string,
  acceptedCallIds: readonly string[],
): Set<string> {
  return new Set(
    requests.flatMap((entry) =>
      (entry.body?.messages ?? []).flatMap((message) =>
        (message.tool_calls ?? [])
          .filter(
            (toolCall) =>
              toolCall.function?.name === name &&
              typeof toolCall.id === 'string' &&
              acceptedCallIds.includes(toolCall.id),
          )
          .map((toolCall) => toolCall.id as string),
      ),
    ),
  );
}

function hasToolResult(messages: readonly EvidenceMessage[], callId: string): boolean {
  return messages.some((message) => message.role === 'tool' && message.tool_call_id === callId);
}

function normalizedModel(
  value: string | undefined,
  scenario: GitHubNotificationModelScenario,
): string {
  return value !== undefined && scenario.model.match.test(value)
    ? scenario.model.reference
    : (value ?? 'unknown');
}

/** Project AIMock's request journal into one provider-neutral scenario report. */
export default function githubNotificationModelEvidence(
  scenario: GitHubNotificationModelScenario,
  entries: readonly GitHubNotificationModelJournalEntry[],
): GitHubNotificationModelEvidence {
  const requests = entries.filter((entry) => entry.body !== null);
  const toolNames = [...new Set(scenario.toolCalls.map(({ name }) => name))].sort();
  return {
    finalResponseCount: requests.filter(
      (entry) => typeof fixtureResponse(entry).content === 'string',
    ).length,
    model: normalizedModel(requests[0]?.body?.model, scenario),
    promptRequestCount: requests.filter((entry) => {
      const messages = entry.body?.messages ?? [];
      const systemText = roleText(messages, 'system');
      const userText = roleText(messages, 'user');
      return (
        scenario.systemPromptSignals.every((signal) => systemText.includes(signal)) &&
        (scenario.userPromptSignals ?? []).every((signal) => userText.includes(signal))
      );
    }).length,
    provider: 'aimock',
    requestCount: requests.length,
    responsesApiRequestCount: requests.filter(
      (entry) =>
        entry.method === 'POST' && (entry.path === '/responses' || entry.path === '/v1/responses'),
    ).length,
    scenario: scenario.id,
    schemaVersion: 2,
    strictMissCount: requests.filter((entry) => entry.response.fixture === null).length,
    successfulFixtureResponseCount: requests.filter(
      (entry) => entry.response.status === 200 && entry.response.fixture !== null,
    ).length,
    tools: toolNames.map((name) => {
      const callIds = scenario.toolCalls
        .filter((toolCall) => toolCall.name === name)
        .map(({ id }) => id);
      return {
        callResponseCount: observedToolCallIds(requests, name, callIds).size,
        name,
        projectionRequestCount: requests.filter((entry) =>
          (entry.body?.tools ?? []).some((tool) => tool.function?.name === name),
        ).length,
        resultRequestCount: requests.reduce(
          (count, entry) =>
            count +
            callIds.filter((callId) => hasToolResult(entry.body?.messages ?? [], callId)).length,
          0,
        ),
      };
    }),
  };
}
