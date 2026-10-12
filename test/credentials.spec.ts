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
    assert.deepEqual(test.records.output, [
      'credential     op for data stored\nstore          file\ninput source   environment\ngateway cache  invalidation not required\n',
    ]);
  });

  it('should warn about pending invalidation after successful credential writes', async () => {
    for (const operation of ['set', 'unset']) {
      const test = harness();
      if (operation === 'set')
        await setCredentialsAgentSystem({
          ...test,
          credential: 'op',
          fromEnvironment: true,
          fromStdin: false,
          workspaceDir: '/workspace',
          credentialInput: {
            read: async () => ({ status: 'read', source: 'environment', token: 'private-token' }),
          },
          credentialManager: {
            set: async () => ({
              status: 'stored',
              agentId: 'data',
              storeId: 'file',
              gatewayInvalidation: 'pending',
            }),
          },
        });
      else
        await unsetCredentialsAgentSystem({
          ...test,
          credential: 'op',
          workspaceDir: '/workspace',
          credentialManager: {
            unset: async () => ({
              status: 'removed',
              agentId: 'data',
              storeIds: ['file'],
              unavailableStoreIds: ['keychain'],
              gatewayInvalidation: 'pending',
            }),
          },
        });
      assert.deepEqual(test.exitCodes, []);
      assert.match(test.records.diagnostics.join(''), /warning/u);
      assert.ok(test.records.diagnostics.join('').indexOf('messages') > -1);
      assert.doesNotMatch(test.records.diagnostics.join(''), /error|private-token/u);
      assert.match(test.records.output.join(''), /stored|removed/u);
      assert.doesNotMatch(test.records.output.join(''), /warning/u);
      assert.match(test.records.output.join(''), /gateway cache\s+invalidation pending/u);
      assert.doesNotMatch(test.records.output.join(''), /invalidation not required/u);
    }
  });

  it('should show confirmed cache invalidation with the stored result', async () => {
    const test = harness();
    await setCredentialsAgentSystem({
      ...test,
      credential: 'op',
      fromEnvironment: false,
      fromStdin: true,
      workspaceDir: '/workspace',
      credentialInput: {
        read: async () => ({ status: 'read', source: 'stdin', token: 'private-token' }),
      },
      credentialManager: {
        set: async () => ({
          status: 'unchanged',
          agentId: 'data',
          storeId: 'keychain',
          gatewayInvalidation: 'confirmed',
        }),
      },
    });
    assert.deepEqual(test.records.output, [
      'credential     op for data unchanged\nstore          keychain\ninput source   stdin\ngateway cache  invalidation confirmed\n',
    ]);
    assert.doesNotMatch(test.records.output.join(''), /private-token/u);
  });

  it('should keep input and validation failures as sorted trailing diagnostics', async () => {
    const inputFailure = harness();
    await setCredentialsAgentSystem({
      ...inputFailure,
      credential: 'op',
      fromEnvironment: false,
      fromStdin: false,
      workspaceDir: '/workspace',
      credentialInput: {
        read: async () => ({ status: 'invalid', code: 'z-input', message: 'input failed' }),
      },
      credentialManager: {
        set: async () => {
          throw new Error('not expected');
        },
      },
    });
    assert.deepEqual(inputFailure.records.output, []);
    assert.match(inputFailure.records.diagnostics.join(''), /input failed/u);
    assert.deepEqual(inputFailure.exitCodes, [1]);

    const validationFailure = harness();
    await setCredentialsAgentSystem({
      ...validationFailure,
      credential: 'op',
      fromEnvironment: false,
      fromStdin: true,
      workspaceDir: '/workspace',
      credentialInput: {
        read: async () => ({ status: 'read', source: 'stdin', token: 'private-token' }),
      },
      credentialManager: {
        set: async () => ({
          status: 'invalid',
          code: 'z-validation',
          message: 'validation failed',
          gatewayInvalidation: 'pending',
        }),
      },
    });
    const diagnostics = validationFailure.records.diagnostics.join('');
    assert.ok(diagnostics.indexOf('error') < diagnostics.indexOf('warning'));
    assert.match(diagnostics, /validation failed/u);
    assert.match(diagnostics, /invalidation is pending/u);
    assert.doesNotMatch(diagnostics, /private-token/u);
    assert.deepEqual(validationFailure.records.output, []);
    assert.deepEqual(validationFailure.exitCodes, [1]);
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
      'status                valid\nagent                 data\nstore                 file\nenvironments checked  1\nsecrets checked       2\n',
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
    assert.match(test.records.output.join(''), /source\s+process-environment/u);
    assert.doesNotMatch(test.records.output.join(''), /store/u);
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

    assert.match(test.records.output.join(''), /scope +one store \(file\)/u);
    assert.match(test.records.output.join(''), /unchanged +file +op credential is not stored/u);
    assert.deepEqual(test.exitCodes, []);
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
    assert.match(test.records.diagnostics.join(''), /error/u);
    assert.match(test.records.diagnostics.join(''), /unsupported credential other/u);
  });
});
