import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { getRuntimeConfig } from 'openclaw/plugin-sdk/runtime-config-snapshot';

import { configuredAgentValue } from '../core/configured-agents.ts';
import createCredentialStores from '../credentials/registry.ts';
import OpCredentialService from '../credentials/op-service.ts';
import AgentManifestService from '../manifest/service.ts';
import AgentEnvironmentService from './service.ts';
import OpEnvironmentService from './op-service.ts';
import resolveMemorySecretProviderRequest, {
  parseMemorySecretProviderRequest,
} from './memory-secret-provider.ts';

const maximumInputBytes = 1024 * 1024;

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maximumInputBytes) throw new Error('Secret-provider input is too large.');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const quietLogger = { debug() {}, error() {}, info() {}, warn() {} };
const manifestService = new AgentManifestService({
  getConfig: () => getRuntimeConfig({ pin: false }),
  logger: quietLogger,
  parseSessionAgentId: () => undefined,
  resolveAgentWorkspaceDir(config, agentId) {
    const workspaceDir = configuredAgentValue(
      config as unknown as OpenClawConfig,
      agentId,
    )?.workspace?.trim();
    if (!workspaceDir) throw new Error('The configured agent workspace is unavailable.');
    return workspaceDir;
  },
});
const credentialService = new OpCredentialService({
  hostEnvironment: process.env,
  stores: createCredentialStores({
    ...(process.getuid?.() === undefined ? {} : { currentUid: process.getuid!() }),
    environment: process.env,
    platform: process.platform,
  }),
});
const environmentService = new AgentEnvironmentService({
  hostEnvironment: process.env,
  logger: quietLogger,
  manifestService,
  opEnvironmentService: new OpEnvironmentService({
    credentialService,
    integrationVersion: 'agent-system-memory',
  }),
});

try {
  const request = parseMemorySecretProviderRequest(await readInput());
  const result = await resolveMemorySecretProviderRequest(request, {
    async resolveBinding(agentId, binding) {
      const loaded = await environmentService.loadForAgentId(agentId, 'service');
      if (
        loaded.status !== 'loaded' ||
        loaded.manifest.memory?.search.provider !== 'openai' ||
        loaded.manifest.memory.search.apiKey !== binding
      ) {
        return;
      }
      return loaded.environment.values[binding];
    },
  });
  process.stdout.write(JSON.stringify(result));
} catch {
  process.exitCode = 1;
}
