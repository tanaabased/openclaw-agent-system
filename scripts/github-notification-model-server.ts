import type { ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';

import { LLMock, type Mountable } from '@copilotkit/aimock';

import githubNotificationModelEvidence from './github-notification-model-evidence.ts';
import resolveGitHubNotificationModelScenario from './github-notification-model-scenarios.ts';

const { values: options } = parseArgs({
  options: {
    host: { default: '127.0.0.1', type: 'string' },
    port: { default: '4010', type: 'string' },
    scenario: { type: 'string' },
  },
  strict: true,
});
const providerHost = options.host.trim();
const providerPort = Number(options.port);
const scenario = resolveGitHubNotificationModelScenario(options.scenario?.trim() ?? '');
if (
  !providerHost ||
  !Number.isSafeInteger(providerPort) ||
  providerPort < 0 ||
  providerPort > 65_535
) {
  throw new Error('The notification model host or port is invalid.');
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

const mock = new LLMock({
  host: providerHost,
  journalMaxEntries: 100,
  logLevel: 'warn',
  port: providerPort,
  strict: true,
});
mock.addFixtures([...scenario.fixtures]);

const evidenceService: Mountable = {
  async handleRequest(req, res, pathname) {
    if (pathname !== '/evidence') return false;
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return true;
    }
    json(res, 200, githubNotificationModelEvidence(scenario, mock.getRequests()));
    return true;
  },
};
mock.mount('/proof', evidenceService);

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
