import assert from 'node:assert/strict';

import AgentInstallService, { AgentInstallError } from '../lib/agent-install-service.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data', name: 'Data' },
};

describe('lib/agent-install-service', () => {
  it('should reconcile lifecycle components after global prerequisites pass', async () => {
    const calls: string[] = [];
    const service = new AgentInstallService({
      lifecycleRegistry: {
        async reconcile(input) {
          calls.push(`reconcile:${input.manifest.agent.id}`);
          return {
            outcomes: [
              {
                code: 'agent-unchanged',
                component: 'agent',
                message: 'OpenClaw registration and identity for data',
                status: 'unchanged',
              },
            ],
            warnings: [],
          };
        },
      },
    });

    const result = await service.install({ manifest, workspaceDir: '/workspace/data' });

    assert.deepEqual(calls, ['reconcile:data']);
    assert.equal(result.agentId, 'data');
    assert.equal(result.outcomes[0]?.component, 'agent');
    assert.equal(result.workspaceDir, '/workspace/data');
  });

  it('should validate stored op access before lifecycle reconciliation', async () => {
    const calls: string[] = [];
    const opManifest: AgentManifest = {
      ...manifest,
      environment: { op: ['private-environment-id'] },
    };
    const service = new AgentInstallService({
      credentialManager: {
        async validateStoredForInstall(input) {
          calls.push(`credential:${input.agent.id}`);
          return { status: 'ready' };
        },
      },
      lifecycleRegistry: {
        async reconcile() {
          calls.push('reconcile');
          return { outcomes: [], warnings: [] };
        },
      },
    });

    await service.install({ manifest: opManifest, workspaceDir: '/workspace/data' });

    assert.deepEqual(calls, ['credential:data', 'reconcile']);
  });

  it('should stop before reconciliation when stored op access is invalid', async () => {
    let reconciliations = 0;
    const service = new AgentInstallService({
      credentialManager: {
        async validateStoredForInstall() {
          return {
            code: 'op-credential-not-stored',
            message: 'Set the credential first.',
            status: 'invalid',
          };
        },
      },
      lifecycleRegistry: {
        async reconcile() {
          reconciliations += 1;
          return { outcomes: [], warnings: [] };
        },
      },
    });

    await assert.rejects(
      service.install({
        manifest: { ...manifest, environment: { op: ['private-environment-id'] } },
        workspaceDir: '/workspace/data',
      }),
      (error: unknown) => {
        assert.equal(error instanceof AgentInstallError, true);
        if (error instanceof AgentInstallError) {
          assert.equal(error.code, 'op-credential-not-stored');
        }
        return true;
      },
    );
    assert.equal(reconciliations, 0);
  });

  it('should fail closed when stored credential validation is unavailable', async () => {
    const service = new AgentInstallService({
      lifecycleRegistry: {
        async reconcile() {
          return { outcomes: [], warnings: [] };
        },
      },
    });

    await assert.rejects(
      service.install({
        manifest: { ...manifest, environment: { op: ['private-environment-id'] } },
        workspaceDir: '/workspace/data',
      }),
      (error: unknown) =>
        error instanceof AgentInstallError && error.code === 'op-credential-unavailable',
    );
  });
});
