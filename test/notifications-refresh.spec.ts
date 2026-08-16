import assert from 'node:assert/strict';

import refreshNotificationsAgentSystem from '../cli/notifications-refresh.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';

const manifest: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot' } },
  diagnostics: [],
  validationChecks: [],
};

describe('cli/notifications-refresh', () => {
  it('should dispose one-shot agent harnesses when the refresh fails', async () => {
    let disposals = 0;

    await assert.rejects(
      refreshNotificationsAgentSystem({
        async disposeAgentHarnesses() {
          disposals += 1;
        },
        json: true,
        logger: { error() {}, info() {}, warn() {} },
        manifestService: {
          loadForAgentId: async () => manifest,
          loadForCommandDirectory: async () => manifest,
        },
        monitorService: {
          async runOnce() {
            throw new Error('refresh failed');
          },
        },
        output: { writeStdout() {} },
        setExitCode() {},
        workspaceDir: '/workspace',
      }),
      /refresh failed/u,
    );

    assert.equal(disposals, 1);
  });
});
