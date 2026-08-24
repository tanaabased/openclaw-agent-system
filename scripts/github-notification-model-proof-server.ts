import type { ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';

import { LLMock, type Mountable } from '@copilotkit/aimock';

import githubNotificationModelProofEvidence, {
  githubNotificationModelProofCallId,
  githubNotificationModelProofCandidate,
  githubNotificationModelProofFinalResponse,
} from './github-notification-model-proof-evidence.ts';

const { values: options } = parseArgs({
  options: {
    host: { default: '127.0.0.1', type: 'string' },
    port: { default: '4010', type: 'string' },
  },
  strict: true,
});
const providerHost = options.host.trim();
const providerPort = Number(options.port);
if (
  !providerHost ||
  !Number.isSafeInteger(providerPort) ||
  providerPort < 0 ||
  providerPort > 65_535
) {
  throw new Error('The notification model proof host or port is invalid.');
}
const promptSignals = [
  'Continue the current GitHub issue lifecycle',
  'This is the initial planning turn for an assigned issue',
  'Before your final response, call `agent_system_github_reply` exactly once',
];

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

const mock = new LLMock({
  host: providerHost,
  journalMaxEntries: 10,
  logLevel: 'warn',
  port: providerPort,
  strict: true,
});

mock.on(
  {
    hasToolResult: false,
    model: /^(?:aimock\/)?gpt-5\.5$/u,
    systemMessage: promptSignals,
    toolName: 'agent_system_github_reply',
  },
  {
    id: 'agent-system-notification-proof-tool-response',
    toolCalls: [
      {
        arguments: JSON.stringify({ body: githubNotificationModelProofCandidate }),
        id: githubNotificationModelProofCallId,
        name: 'agent_system_github_reply',
      },
    ],
  },
);
mock.on(
  {
    hasToolResult: true,
    model: /^(?:aimock\/)?gpt-5\.5$/u,
    systemMessage: promptSignals,
    toolCallId: githubNotificationModelProofCallId,
  },
  {
    content: githubNotificationModelProofFinalResponse,
    id: 'agent-system-notification-proof-final-response',
  },
);

const proofService: Mountable = {
  async handleRequest(req, res, pathname) {
    if (pathname !== '/evidence') return false;
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return true;
    }
    json(res, 200, githubNotificationModelProofEvidence(mock.getRequests()));
    return true;
  },
};
mock.mount('/proof', proofService);

async function stop(): Promise<void> {
  await mock.stop();
  process.exitCode = 0;
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  const baseUrl = await mock.start();
  process.stdout.write(`${baseUrl}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
