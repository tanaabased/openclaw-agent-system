import assert from 'node:assert/strict';

import AgentDoctorService from '../lib/agent-doctor-service.ts';

const input = {
  manifest: { schemaVersion: 1 as const, agent: { id: 'data' } },
  workspaceDir: '/workspace',
};

describe('lib/agent-doctor-service', () => {
  it('should report healthy managed path projection', async () => {
    const service = new AgentDoctorService({
      pathService: {
        async inspect() {
          return {
            codex: { gitignored: true, ownership: 'managed', pathMatches: true },
            openClawMatches: true,
            projection: { entries: [], path: '/usr/bin' },
          };
        },
      },
    });

    const result = await service.inspect(input);

    assert.equal(result.status, 'healthy');
    assert.deepEqual(
      result.findings.map(({ code, status }) => ({ code, status })),
      [
        { code: 'openclaw-exec-path-ready', status: 'healthy' },
        { code: 'codex-path-ready', status: 'healthy' },
        { code: 'codex-config-gitignored', status: 'healthy' },
      ],
    );
  });

  it('should keep user-managed codex configuration outside automatic repair', async () => {
    const service = new AgentDoctorService({
      pathService: {
        async inspect() {
          return {
            codex: { gitignored: false, ownership: 'manual', pathMatches: false },
            openClawMatches: true,
            projection: { entries: [], path: '/usr/bin' },
          };
        },
      },
    });

    const result = await service.inspect(input);

    assert.equal(result.status, 'healthy');
    assert.deepEqual(
      result.findings.map(({ code, status }) => ({ code, status })),
      [
        { code: 'openclaw-exec-path-ready', status: 'healthy' },
        { code: 'codex-config-manual', status: 'manual' },
        { code: 'codex-config-not-gitignored', status: 'warning' },
      ],
    );
  });

  it('should convert an invalid path projection into drift', async () => {
    const service = new AgentDoctorService({
      pathService: {
        async inspect() {
          throw new Error('The declared path is missing.');
        },
      },
    });

    const result = await service.inspect(input);

    assert.equal(result.status, 'drift');
    assert.equal(result.findings[0]?.code, 'path-projection-invalid');
    assert.match(result.findings[0]?.remediation ?? '', /agent-system install/u);
  });
});
