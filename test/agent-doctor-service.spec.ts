import assert from 'node:assert/strict';

import AgentDoctorService from '../agent/doctor-service.ts';

const input = {
  manifest: { schemaVersion: 1 as const, agent: { id: 'data', name: 'Data' } },
  workspaceDir: '/workspace',
};

describe('agent/doctor-service', () => {
  it('should aggregate lifecycle findings and preserve their order', async () => {
    const service = new AgentDoctorService({
      lifecycleRegistry: {
        async inspect() {
          return [
            {
              code: 'agent-ready',
              component: 'agent',
              message: 'OpenClaw agent state matches.',
              status: 'healthy',
            },
            {
              code: 'github-config-drift',
              component: 'github',
              message: 'Generated GitHub CLI config drifted.',
              status: 'drift',
            },
          ];
        },
      },
    });

    const result = await service.inspect(input);

    assert.equal(result.status, 'drift');
    assert.deepEqual(
      result.findings.map(({ component }) => component),
      ['agent', 'github'],
    );
  });

  it('should give blocked findings precedence over drift', async () => {
    const service = new AgentDoctorService({
      lifecycleRegistry: {
        async inspect() {
          return [
            {
              code: 'path-drift',
              component: 'path',
              message: 'Path drifted.',
              status: 'drift',
            },
            {
              code: 'agent-conflict',
              component: 'agent',
              message: 'Agent registration conflicts.',
              status: 'blocked',
            },
          ];
        },
      },
    });

    assert.equal((await service.inspect(input)).status, 'blocked');
  });

  it('should treat manual and warning findings as healthy aggregate state', async () => {
    const service = new AgentDoctorService({
      lifecycleRegistry: {
        async inspect() {
          return [
            {
              code: 'codex-config-manual',
              component: 'path',
              message: 'Codex configuration is user-managed.',
              status: 'manual',
            },
          ];
        },
      },
    });

    assert.equal((await service.inspect(input)).status, 'healthy');
  });
});
