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
    environment: { set: { AGENT_COLOR: 'green' } },
  },
  diagnostics: [],
};

describe('lib/agent-environment-service', () => {
  it('should resolve literal data and log only metadata', async () => {
    const logs: string[] = [];
    const service = new AgentEnvironmentService({
      logger: { info: (message) => logs.push(message) },
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

    const result = await service.loadForAgentId('data');

    assert.equal(result.status, 'loaded');
    if (result.status !== 'loaded') return;
    assert.deepEqual(result.environment.values, { AGENT_COLOR: 'green' });
    assert.equal(logs[0]?.includes('variables=1'), true);
    assert.equal(logs[0]?.includes('green'), false);
  });

  it('should preserve non-loaded manifest results without logging environment state', async () => {
    const logs: string[] = [];
    const invalid: AgentManifestLoadResult = {
      status: 'invalid',
      scope: { workspaceDir: '/workspace' },
      diagnostics: [],
    };
    const service = new AgentEnvironmentService({
      logger: { info: (message) => logs.push(message) },
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
    assert.deepEqual(logs, []);
  });
});
