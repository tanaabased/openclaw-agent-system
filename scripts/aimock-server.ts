import type { ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';

import { LLMock, type Mountable } from '@copilotkit/aimock';

import openClawAIMockDiagnostics from './aimock-diagnostics.ts';
import openClawAIMockEvidence from './aimock-evidence.ts';
import resolveExampleModelScenario from './example-model-scenarios.ts';
import withToolSearch from './aimock-tool-search.ts';

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
const scenario = withToolSearch(resolveExampleModelScenario(options.scenario?.trim() ?? ''));
if (
  !providerHost ||
  !Number.isSafeInteger(providerPort) ||
  providerPort < 0 ||
  providerPort > 65_535
) {
  throw new Error('The AIMock host or port is invalid.');
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

let authenticatedEmbeddings = 0;
let rejectedEmbeddings = 0;
if (scenario.embeddingAuthorization) {
  mock.mount('/v1', {
    async handleRequest(req, res, pathname) {
      if (pathname !== '/embeddings') return false;
      if (req.headers.authorization !== scenario.embeddingAuthorization) {
        rejectedEmbeddings += 1;
        json(res, 401, { error: 'fixture credential required' });
        return true;
      }
      authenticatedEmbeddings += 1;
      return false;
    },
  });
}

const evidenceService: Mountable = {
  async handleRequest(req, res, pathname) {
    if (pathname !== '/evidence' && pathname !== '/diagnostics') return false;
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (pathname === '/diagnostics') {
      json(res, 200, openClawAIMockDiagnostics(scenario, mock.getRequests()));
      return true;
    }
    try {
      json(res, 200, {
        ...openClawAIMockEvidence(scenario, mock.getRequests()),
        ...(scenario.embeddingAuthorization
          ? {
              embeddingAuthentication: {
                accepted: authenticatedEmbeddings,
                rejected: rejectedEmbeddings,
              },
            }
          : {}),
      });
    } catch {
      json(res, 500, openClawAIMockDiagnostics(scenario, mock.getRequests()));
    }
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
