import assert from 'node:assert/strict';

import OpCredentialManager from '../lib/op-credential-manager.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data', name: 'Data' },
  environment: { op: ['environment-one', 'environment-two'] },
};

describe('lib/op-credential-manager', () => {
  it('should validate a supplied token against every environment before storing it', async () => {
    const calls: string[] = [];
    const manager = new OpCredentialManager({
      credentialService: {
        environmentServiceAccountToken: () => undefined,
        async removeServiceAccountToken() {
          return { status: 'missing', storeIds: ['file'], unavailableStoreIds: [] };
        },
        async storeServiceAccountToken(agentId, storeId, token) {
          calls.push(`store:${agentId}:${storeId}:${token}`);
          return { status: 'stored', storeId: storeId ?? 'file' };
        },
      },
      environmentService: {
        async validate() {
          throw new Error('not expected');
        },
        async validateToken(token, environmentIds) {
          calls.push(`validate:${token}:${environmentIds.length}`);
          return { status: 'valid', environmentCount: environmentIds.length };
        },
      },
    });

    assert.deepEqual(await manager.set(manifest, 'private-token', 'file'), {
      status: 'stored',
      agentId: 'data',
      storeId: 'file',
    });
    assert.deepEqual(calls, ['validate:private-token:2', 'store:data:file:private-token']);
  });

  it('should not write a token that cannot access a declared environment', async () => {
    let writes = 0;
    const manager = new OpCredentialManager({
      credentialService: {
        environmentServiceAccountToken: () => undefined,
        async removeServiceAccountToken() {
          return { status: 'missing', storeIds: ['file'], unavailableStoreIds: [] };
        },
        async storeServiceAccountToken() {
          writes += 1;
          return { status: 'stored', storeId: 'file' };
        },
      },
      environmentService: {
        async validate() {
          throw new Error('not expected');
        },
        async validateToken() {
          return {
            status: 'invalid',
            diagnostics: [
              {
                code: 'op-environment-unavailable',
                message: 'Environment unavailable.',
                severity: 'error',
              },
            ],
          };
        },
      },
    });

    assert.equal((await manager.set(manifest, 'private-token', 'file')).status, 'invalid');
    assert.equal(writes, 0);
  });

  it('should require an explicit store without falling back to the process environment', async () => {
    const manager = new OpCredentialManager({
      credentialService: {
        environmentServiceAccountToken: () => undefined,
        async removeServiceAccountToken() {
          return { status: 'missing', storeIds: ['file'], unavailableStoreIds: [] };
        },
        async storeServiceAccountToken() {
          return { status: 'stored', storeId: 'file' };
        },
      },
      environmentService: {
        async validate(agentId, environmentIds, options) {
          assert.equal(agentId, 'data');
          assert.deepEqual(environmentIds, ['environment-one', 'environment-two']);
          assert.deepEqual(options, { storeId: 'file', allowEnvironmentFallback: false });
          return {
            status: 'valid',
            environmentCount: 2,
            source: { id: 'file', type: 'store' },
          };
        },
        async validateToken() {
          throw new Error('not expected');
        },
      },
    });

    assert.deepEqual(await manager.validate(manifest, { storeId: 'file' }), {
      status: 'valid',
      agentId: 'data',
      environmentCount: 2,
      source: 'store:file',
    });
  });

  it('should validate only the fixed process-environment credential when requested', async () => {
    const manager = new OpCredentialManager({
      credentialService: {
        environmentServiceAccountToken: () => 'environment-token',
        async removeServiceAccountToken() {
          return { status: 'missing', storeIds: ['file'], unavailableStoreIds: [] };
        },
        async storeServiceAccountToken() {
          return { status: 'stored', storeId: 'file' };
        },
      },
      environmentService: {
        async validate() {
          throw new Error('not expected');
        },
        async validateToken(token, environmentIds) {
          assert.equal(token, 'environment-token');
          assert.deepEqual(environmentIds, ['environment-one', 'environment-two']);
          return { status: 'valid', environmentCount: 2 };
        },
      },
    });

    assert.deepEqual(await manager.validate(manifest, { fromEnvironment: true }), {
      status: 'valid',
      agentId: 'data',
      environmentCount: 2,
      source: 'process-environment',
    });
  });

  it('should give install an actionable error when no stored credential is available', async () => {
    const manager = new OpCredentialManager({
      credentialService: {
        environmentServiceAccountToken: () => 'environment-token',
        async removeServiceAccountToken() {
          return { status: 'missing', storeIds: ['file'], unavailableStoreIds: [] };
        },
        async storeServiceAccountToken() {
          return { status: 'stored', storeId: 'file' };
        },
      },
      environmentService: {
        async validate(agentId, environmentIds, options) {
          assert.equal(agentId, 'data');
          assert.deepEqual(environmentIds, ['environment-one', 'environment-two']);
          assert.deepEqual(options, { allowEnvironmentFallback: false });
          return {
            status: 'invalid',
            diagnostics: [
              {
                code: 'op-credential-missing',
                message: 'Credential missing.',
                severity: 'error',
              },
            ],
          };
        },
        async validateToken() {
          throw new Error('not expected');
        },
      },
    });

    const result = await manager.validateStoredForInstall(manifest);

    assert.equal(result.status, 'invalid');
    if (result.status !== 'invalid') return;
    assert.equal(result.code, 'op-credential-not-stored');
    assert.equal(result.message.includes('credentials set op'), true);
    assert.equal(result.message.includes('--from-env or --stdin'), true);
  });

  it('should unset an agent-scoped credential idempotently', async () => {
    const manager = new OpCredentialManager({
      credentialService: {
        environmentServiceAccountToken: () => undefined,
        async removeServiceAccountToken(agentId, storeId) {
          assert.equal(agentId, 'data');
          assert.equal(storeId, undefined);
          return { status: 'missing', storeIds: ['file'], unavailableStoreIds: [] };
        },
        async storeServiceAccountToken() {
          return { status: 'stored', storeId: 'file' };
        },
      },
      environmentService: {
        async validate() {
          throw new Error('not expected');
        },
        async validateToken() {
          throw new Error('not expected');
        },
      },
    });

    assert.deepEqual(await manager.unset('data'), {
      status: 'missing',
      agentId: 'data',
      storeIds: ['file'],
      unavailableStoreIds: [],
    });
  });
});
