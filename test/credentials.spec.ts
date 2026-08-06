import assert from 'node:assert/strict';

import setCredentialsAgentSystem from '../cli/credentials-set.ts';
import unsetCredentialsAgentSystem from '../cli/credentials-unset.ts';
import validateCredentialsAgentSystem from '../cli/credentials-validate.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';

const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc123',
  manifest: {
    schemaVersion: 1,
    agent: { id: 'data', name: 'Data' },
    environment: { op: ['environment-id'] },
  },
  diagnostics: [],
};

function harness() {
  const output = { error: [] as string[], write: [] as string[] };
  const exitCodes: number[] = [];
  return {
    exitCodes,
    manifestService: {
      async loadForAgentId() {
        return loaded;
      },
      async loadForWorkspace() {
        return loaded;
      },
    },
    output: {
      error(message: string) {
        output.error.push(message);
      },
      write(message: string) {
        output.write.push(message);
      },
    },
    records: output,
    setExitCode(code: number) {
      exitCodes.push(code);
    },
  };
}

describe('cli/credentials', () => {
  it('should require explicit set inputs before loading or storing', async () => {
    const test = harness();
    let managerCalls = 0;

    await setCredentialsAgentSystem({
      credential: 'op',
      credentialManager: {
        async setFromEnvironment() {
          managerCalls += 1;
          return { status: 'stored', agentId: 'data', storeId: 'file' };
        },
      },
      fromEnvironment: false,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      storeId: 'file',
      workspaceDir: '/workspace',
    });

    assert.equal(managerCalls, 0);
    assert.deepEqual(test.exitCodes, [1]);
    assert.equal(test.records.error.join('').includes('requires --from-env'), true);
  });

  it('should report credential source and environment count without values', async () => {
    const test = harness();

    await validateCredentialsAgentSystem({
      credential: 'op',
      credentialManager: {
        async validate() {
          return {
            status: 'valid',
            agentId: 'data',
            environmentCount: 1,
            source: 'store:file',
          };
        },
      },
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      storeId: 'file',
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.exitCodes, []);
    assert.deepEqual(test.records.write, [
      'valid: op credential for data source=store:file environments=1\n',
    ]);
  });

  it('should report idempotent explicit-store removal', async () => {
    const test = harness();

    await unsetCredentialsAgentSystem({
      credential: 'op',
      credentialManager: {
        async unset() {
          return { status: 'missing', agentId: 'data', storeId: 'file' };
        },
      },
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      storeId: 'file',
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.records.write, [
      'unchanged: op credential for data is not stored in file\n',
    ]);
  });

  it('should reject unsupported credential targets', async () => {
    const test = harness();

    await validateCredentialsAgentSystem({
      credential: 'other',
      credentialManager: {
        async validate() {
          throw new Error('not expected');
        },
      },
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.exitCodes, [1]);
    assert.deepEqual(test.records.error, ['error: unsupported credential other\n']);
  });
});
