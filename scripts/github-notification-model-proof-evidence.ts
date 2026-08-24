export const githubNotificationModelProofCallId = 'agent-system-notification-proof-reply';

export const githubNotificationModelProofCandidate =
  "This issue needs a deterministic notification test that keeps the real OpenClaw and GitHub lifecycle while removing live model variability. I'm going to prove the assignment turn with a fixed mock tool call and response, repeat the evidence in isolation, and document the supported boundary to resolve the issue.";

export const githubNotificationModelProofFinalResponse = [
  '## Assessment',
  '',
  'The notification test needs to prove the user-visible assignment response without depending on live model capacity or wording.',
  '',
  '## Plan',
  '',
  'Run the trusted issue, work, and assignment turn through the installed Gateway, stage the fixed reply with the real Agent System tool, verify publication, and compare bounded provider evidence.',
].join('\n');

const assignmentPromptSignals = [
  'Continue the current GitHub issue lifecycle',
  'This is the initial planning turn for an assigned issue',
  'Before your final response, call `agent_system_github_reply` exactly once',
] as const;
const githubReplyToolName = 'agent_system_github_reply';

interface ProofMessage {
  content: unknown;
  role: string;
  tool_call_id?: string;
}

interface ProofToolDefinition {
  function?: { name?: string };
}

interface GitHubNotificationModelProofEntry {
  body: {
    messages?: ProofMessage[];
    model?: string;
    tools?: ProofToolDefinition[];
  } | null;
  method: string;
  path: string;
  response: {
    fixture: { response?: unknown } | null;
    status: number;
  };
}

export interface GitHubNotificationModelProofEvidence {
  assignmentPromptRequestCount: number;
  finalResponseCount: number;
  model: string;
  provider: 'aimock';
  replyToolCallResponseCount: number;
  replyToolProjectionRequestCount: number;
  replyToolResultRequestCount: number;
  requestCount: number;
  responsesApiRequestCount: number;
  schemaVersion: 1;
  strictMissCount: number;
  successfulFixtureResponseCount: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function messageText(message: ProofMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => record(part)?.text)
    .filter((part): part is string => typeof part === 'string')
    .join('');
}

function fixtureResponse(entry: GitHubNotificationModelProofEntry): Record<string, unknown> {
  return record(entry.response.fixture?.response) ?? {};
}

function isReplyToolCallResponse(entry: GitHubNotificationModelProofEntry): boolean {
  const toolCalls = fixtureResponse(entry).toolCalls;
  return (
    Array.isArray(toolCalls) &&
    toolCalls.some((toolCall) => {
      const value = record(toolCall);
      return value?.id === githubNotificationModelProofCallId && value.name === githubReplyToolName;
    })
  );
}

function modelReference(value: string | undefined): string {
  return value === 'gpt-5.5' || value === 'aimock/gpt-5.5'
    ? 'aimock/gpt-5.5'
    : (value ?? 'unknown');
}

/** Project AIMock's detailed request journal into stable proof evidence. */
export default function githubNotificationModelProofEvidence(
  entries: readonly GitHubNotificationModelProofEntry[],
): GitHubNotificationModelProofEvidence {
  const requests = entries.filter((entry) => entry.body !== null);
  return {
    assignmentPromptRequestCount: requests.filter((entry) => {
      const systemText = (entry.body?.messages ?? [])
        .filter((message) => message.role === 'system')
        .map(messageText)
        .join('\n');
      return assignmentPromptSignals.every((signal) => systemText.includes(signal));
    }).length,
    finalResponseCount: requests.filter(
      (entry) => fixtureResponse(entry).content === githubNotificationModelProofFinalResponse,
    ).length,
    model: modelReference(requests[0]?.body?.model),
    provider: 'aimock',
    replyToolCallResponseCount: requests.filter(isReplyToolCallResponse).length,
    replyToolProjectionRequestCount: requests.filter((entry) =>
      (entry.body?.tools ?? []).some((tool) => tool.function?.name === githubReplyToolName),
    ).length,
    replyToolResultRequestCount: requests.filter((entry) =>
      (entry.body?.messages ?? []).some(
        (message) =>
          message.role === 'tool' && message.tool_call_id === githubNotificationModelProofCallId,
      ),
    ).length,
    requestCount: requests.length,
    responsesApiRequestCount: requests.filter(
      (entry) => entry.method === 'POST' && entry.path === '/v1/responses',
    ).length,
    schemaVersion: 1,
    strictMissCount: requests.filter((entry) => entry.response.fixture === null).length,
    successfulFixtureResponseCount: requests.filter(
      (entry) => entry.response.status === 200 && entry.response.fixture !== null,
    ).length,
  };
}
