import assert from 'node:assert/strict';

import AgentEnvironmentService from '../lib/agent-environment-service.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';

const loaded: AgentManifestLoadResult = {
  status: 'loaded',
  scope: { agentId: 'data', workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'manifest-digest',
  manifest: {
    schemaVersion: 1,
    agent: { id: 'data' },
    environment: { set: { AGENT_COLOR: '$AGENT_COLOR_SOURCE' } },
  },
  diagnostics: [],
};

describe('lib/agent-environment-service', () => {
  it('should resolve host references from a fixed lookup and log only metadata', async () => {
    const logs = { error: [] as string[], info: [] as string[] };
    const hostEnvironment = { AGENT_COLOR_SOURCE: 'green' };
    const service = new AgentEnvironmentService({
      hostEnvironment,
      logger: {
        error: (message) => logs.error.push(message),
        info: (message) => logs.info.push(message),
      },
      manifestService: {
        async loadForAgentId() {
          return loaded;
        },
        async loadForRuntimeContext() {
          return loaded;
        },
        async loadForWorkspace() {
          return loaded;
        },
      },
    });
    hostEnvironment.AGENT_COLOR_SOURCE = 'blue';

    const result = await service.loadForAgentId('data');

    assert.equal(result.status, 'loaded');
    if (result.status !== 'loaded') return;
    assert.deepEqual(result.environment.values, { AGENT_COLOR: 'green' });
    assert.equal(logs.info[0]?.includes('variables=1'), true);
    assert.equal(logs.info[0]?.includes('green'), false);
    assert.deepEqual(logs.error, []);
  });

  it('should preserve non-loaded manifest results without logging environment state', async () => {
    const logs = { error: [] as string[], info: [] as string[] };
    const invalid: AgentManifestLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/workspace' },
      diagnostics: [],
    };
    const service = new AgentEnvironmentService({
      hostEnvironment: {},
      logger: {
        error: (message) => logs.error.push(message),
        info: (message) => logs.info.push(message),
      },
      manifestService: {
        async loadForAgentId() {
          return invalid;
        },
        async loadForRuntimeContext() {
          return invalid;
        },
        async loadForWorkspace() {
          return invalid;
        },
      },
    });

    assert.equal((await service.loadForWorkspace('/workspace')).status, 'invalid');
    assert.deepEqual(logs, { error: [], info: [] });
  });

  it('should fail closed and log only diagnostic codes when environment resolution fails', async () => {
    const logs = { error: [] as string[], info: [] as string[] };
    const service = new AgentEnvironmentService({
      hostEnvironment: {},
      logger: {
        error: (message) => logs.error.push(message),
        info: (message) => logs.info.push(message),
      },
      manifestService: {
        async loadForAgentId() {
          return {
            ...loaded,
            manifest: {
              ...loaded.manifest,
              environment: {
                required: ['AGENT_COLOR'],
                set: { AGENT_COLOR: '$PRIVATE_SOURCE' },
              },
            },
          };
        },
        async loadForRuntimeContext() {
          return loaded;
        },
        async loadForWorkspace() {
          return loaded;
        },
      },
    });

    const result = await service.loadForAgentId('data');

    assert.equal(result.status, 'invalid');
    assert.equal(logs.error[0]?.includes('environment-reference-missing'), true);
    assert.equal(logs.error[0]?.includes('PRIVATE_SOURCE'), false);
    assert.deepEqual(logs.info, []);
  });
});
