import assert from 'node:assert/strict';

import setCredentialsAgentSystem from '../cli/credentials-set.ts';
import unsetCredentialsAgentSystem from '../cli/credentials-unset.ts';
import validateCredentialsAgentSystem from '../cli/credentials-validate.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { createCliStyles } from '../cli/output.ts';

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
  validationChecks: [],
};

function harness() {
  const diagnostics: string[] = [];
  const output: string[] = [];
  const exitCodes: number[] = [];
  const manifestDirectories: string[] = [];
  return {
    exitCodes,
    manifestService: {
      async loadForAgentId() {
        return loaded;
      },
      async loadForCommandDirectory(commandDirectory: string) {
        manifestDirectories.push(commandDirectory);
        return loaded;
      },
    },
    output: {
      writeStderr: (message: string) => diagnostics.push(message),
      writeStdout: (message: string) => output.push(message),
    },
    records: { diagnostics, manifestDirectories, output },
    setExitCode(code: number) {
      exitCodes.push(code);
    },
    styles: createCliStyles({ NO_COLOR: '1' }),
  };
}

describe('cli/credentials', () => {
  it('should read and store a credential from the selected input source', async () => {
    const test = harness();
    const calls: string[] = [];

    await setCredentialsAgentSystem({
      credential: 'op',
      credentialInput: {
        async read(source) {
          calls.push(`read:${source}`);
          return { status: 'read', source, token: 'private-token' };
        },
      },
      credentialManager: {
        async set(manifest, token, storeId) {
          calls.push(`set:${manifest.agent.id}:${token}:${storeId ?? 'automatic'}`);
          return { status: 'stored', agentId: 'data', storeId: 'file' };
        },
      },
      fromEnvironment: true,
      fromStdin: false,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(calls, ['read:environment', 'set:data:private-token:automatic']);
    assert.deepEqual(test.records.manifestDirectories, ['/workspace']);
    assert.deepEqual(test.exitCodes, []);
    assert.deepEqual(test.records.output, ['stored  op credential for data\nstore   file\n']);
  });

  it('should reject conflicting set input sources before loading the manifest', async () => {
    const test = harness();

    await setCredentialsAgentSystem({
      credential: 'op',
      credentialInput: {
        async read() {
          throw new Error('not expected');
        },
      },
      credentialManager: {
        async set() {
          throw new Error('not expected');
        },
      },
      fromEnvironment: true,
      fromStdin: true,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.exitCodes, [1]);
    assert.equal(test.records.diagnostics.join('').includes('cannot be used together'), true);
    assert.deepEqual(test.records.output, []);
  });

  it('should report credential source and environment count without values', async () => {
    const test = harness();

    await validateCredentialsAgentSystem({
      credential: 'op',
      credentialManager: {
        async validate(_manifest, options) {
          assert.deepEqual(options, { storeId: 'file' });
          return {
            status: 'valid',
            agentId: 'data',
            environmentCount: 1,
            secretCount: 2,
            source: 'store:file',
          };
        },
      },
      fromEnvironment: false,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      storeId: 'file',
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.exitCodes, []);
    assert.deepEqual(test.records.output, [
      'valid         op credential for data\nsource        store:file\nenvironments  1\nsecrets       2\n',
    ]);
  });

  it('should validate only the process-environment credential when requested', async () => {
    const test = harness();

    await validateCredentialsAgentSystem({
      credential: 'op',
      credentialManager: {
        async validate(_manifest, options) {
          assert.deepEqual(options, { fromEnvironment: true });
          return {
            status: 'valid',
            agentId: 'data',
            environmentCount: 1,
            secretCount: 0,
            source: 'process-environment',
          };
        },
      },
      fromEnvironment: true,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.exitCodes, []);
    assert.equal(test.records.output.join('').includes('process-environment'), true);
  });

  it('should reject conflicting validation selectors before loading the manifest', async () => {
    const test = harness();

    await validateCredentialsAgentSystem({
      credential: 'op',
      credentialManager: {
        async validate() {
          throw new Error('not expected');
        },
      },
      fromEnvironment: true,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      storeId: 'file',
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.exitCodes, [1]);
    assert.equal(test.records.diagnostics.join('').includes('cannot be used together'), true);
    assert.deepEqual(test.records.output, []);
  });

  it('should report idempotent explicit-store removal', async () => {
    const test = harness();

    await unsetCredentialsAgentSystem({
      credential: 'op',
      credentialManager: {
        async unset() {
          return {
            status: 'missing',
            agentId: 'data',
            storeIds: ['file'],
            unavailableStoreIds: [],
          };
        },
      },
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
      fromEnvironment: false,
      manifestService: test.manifestService,
      output: test.output,
      setExitCode: test.setExitCode,
      styles: test.styles,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(test.exitCodes, [1]);
    assert.deepEqual(test.records.output, []);
    assert.deepEqual(test.records.diagnostics, ['credentials: unsupported credential other\n']);
  });
});
