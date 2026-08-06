import assert from 'node:assert/strict';

import setCredentialsAgentSystem from '../cli/credentials-set.ts';
import unsetCredentialsAgentSystem from '../cli/credentials-unset.ts';
import validateCredentialsAgentSystem from '../cli/credentials-validate.ts';
import type { AgentManifestLoadResult } from '../lib/agent-manifest-service.ts';
import { createCliStyles } from '../lib/cli-output.ts';

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
  const logs = { error: [] as string[], info: [] as string[], warn: [] as string[] };
  const output: string[] = [];
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
    logger: {
      error(message: string) {
        logs.error.push(message);
      },
      info(message: string) {
        logs.info.push(message);
      },
      warn(message: string) {
        logs.warn.push(message);
      },
    },
    output: { writeStdout: (message: string) => output.push(message) },
    records: { logs, output },
    setExitCode(code: number) {
      exitCodes.push(code);
    },
    styles: createCliStyles({ NO_COLOR: '1' }),
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
      logger: test.logger,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      storeId: 'file',
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.equal(managerCalls, 0);
    assert.deepEqual(test.exitCodes, [1]);
    assert.equal(test.records.logs.error.join('').includes('requires --from-env'), true);
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
      logger: test.logger,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      storeId: 'file',
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.exitCodes, []);
    assert.deepEqual(test.records.output, [
      'valid         op credential for data\nsource        store:file\nenvironments  1\n',
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
      logger: test.logger,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      storeId: 'file',
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.records.output, [
      'unchanged  op credential for data is not stored\nstore      file\n',
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
      logger: test.logger,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.exitCodes, [1]);
    assert.deepEqual(test.records.logs.error, ['credentials: unsupported credential other']);
  });
});
