import type { ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';

import { LLMock, type Mountable } from '@copilotkit/aimock';

import openClawAIMockDiagnostics from './aimock-diagnostics.ts';
import openClawAIMockEvidence from './aimock-evidence.ts';
import httpResponses from './aimock-http-responses.ts';
import resolveExampleModelScenario from './example-model-scenarios.ts';
import withToolSearch from './aimock-tool-search.ts';
import captureFixtureErrors from './aimock-fixture-errors.ts';
import { matchesOpenClawAIMockToolCallId } from './aimock-tool-result.ts';

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
const { scenario, errors: fixtureErrors } = captureFixtureErrors(
  withToolSearch(resolveExampleModelScenario(options.scenario?.trim() ?? '')),
);
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
const reasoningRequests: { model: string; effort: string | null }[] = [];
const observeReasoning = [
  'openclaw-automation-prompt',
  'openclaw-automation-recovery',
  'openclaw-automation-command-chat',
].includes(scenario.id);
const observeResponses = ['openclaw-runtimes', 'openclaw-lifecycle-approvals'].includes(
  scenario.id,
);
const rejectedResponses: object[] = [];
const frameTypes = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'tool_search_call',
  'tool_search_output',
  'local_shell_call',
  'local_shell_call_output',
]);
const responses: Mountable = {
  ...httpResponses,
  async handleRequest(req, res) {
    const observeFrames = observeResponses;
    if ((observeReasoning || observeFrames) && req.method === 'POST') {
      // AIMock's normalized journal drops Responses reasoning options.
      const chunks: Buffer[] = [];
      let remaining = 10 * 1024 * 1024;
      // Attach only when AIMock registers its own reader. An earlier data
      // listener would put the request into flowing mode across the mount await.
      const observeRead = (event: string | symbol) => {
        if (event !== 'data') return;
        req.off('newListener', observeRead);
        req.on('data', (chunk: Buffer) => {
          remaining -= chunk.length;
          if (remaining >= 0) chunks.push(chunk);
        });
      };
      req.on('newListener', observeRead);
      req.once('end', () => {
        if (remaining < 0) return;
        try {
          const { model, reasoning, input, previous_response_id } = JSON.parse(
            Buffer.concat(chunks).toString(),
          );
          if (observeReasoning && typeof model === 'string') {
            reasoningRequests.push({
              model,
              effort: typeof reasoning?.effort === 'string' ? reasoning.effort : null,
            });
            if (reasoningRequests.length > 100) reasoningRequests.shift();
          }
          if (observeFrames) {
            const ids = new Map<string, number>();
            const reference = (id: unknown) => {
              if (typeof id !== 'string' || !id) return undefined;
              if (!ids.has(id)) ids.set(id, ids.size + 1);
              const authored = scenario.toolCalls.findIndex((call) =>
                matchesOpenClawAIMockToolCallId(id, call.id),
              );
              return { ref: ids.get(id), authored: authored < 0 ? undefined : authored + 1 };
            };
            const items = Array.isArray(input) ? input : [];
            const trace = {
              inputCount: items.length,
              previousResponse: typeof previous_response_id === 'string',
              frames: items.slice(-20).map((item) => ({
                type: frameTypes.has(item?.type) ? item.type : 'other',
                itemId: reference(item?.id),
                callId: reference(item?.call_id),
                hasName: typeof item?.name === 'string' && item.name.length > 0,
              })),
            };
            res.once('finish', () => {
              if (res.statusCode !== 503) return;
              rejectedResponses.push(trace);
              if (rejectedResponses.length > 8) rejectedResponses.splice(1, 1);
            });
          }
        } catch {
          // AIMock still owns malformed request handling.
        }
      });
    }
    return false;
  },
};
mock.mount('/responses', responses);
mock.mount('/v1/responses', responses);

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
    if (pathname !== '/evidence' && pathname !== '/diagnostics' && pathname !== '/reasoning')
      return false;
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (pathname === '/reasoning') {
      json(res, 200, reasoningRequests);
      return true;
    }
    if (pathname === '/diagnostics' || fixtureErrors.length) {
      const diagnostics = {
        ...openClawAIMockDiagnostics(scenario, mock.getRequests()),
        ...(fixtureErrors.length ? { failed: true, fixtureErrors } : {}),
        ...(rejectedResponses.length ? { rejectedResponses } : {}),
      };
      json(res, diagnostics.failed ? 500 : 200, diagnostics);
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
