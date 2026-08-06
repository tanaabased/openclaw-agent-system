import assert from 'node:assert/strict';

import type {
  CredentialKey,
  CredentialStore,
  CredentialStoreReadResult,
  CredentialStoreRemoveResult,
  CredentialStoreWriteResult,
} from '../lib/credential-store.ts';
import OnePasswordCredentialService from '../lib/onepassword-credential-service.ts';

function createStore(
  id: string,
  readResult: CredentialStoreReadResult,
  calls: Array<{ key: CredentialKey; operation: string; value?: string }>,
): CredentialStore {
  return {
    id,
    async read(key) {
      calls.push({ key, operation: 'read' });
      return readResult;
    },
    async remove(key): Promise<CredentialStoreRemoveResult> {
      calls.push({ key, operation: 'remove' });
      return { status: 'removed' };
    },
    async write(key, value): Promise<CredentialStoreWriteResult> {
      calls.push({ key, operation: 'write', value });
      return { status: 'stored' };
    },
  };
}

describe('lib/onepassword-credential-service', () => {
  it('should prefer stored credentials before the process-environment fallback', async () => {
    const calls: Array<{ key: CredentialKey; operation: string }> = [];
    const service = new OnePasswordCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      stores: [createStore('file', { status: 'found', value: 'stored-token' }, calls)],
    });

    assert.deepEqual(await service.resolveServiceAccountToken('data'), {
      status: 'resolved',
      source: { id: 'file', type: 'store' },
      token: 'stored-token',
    });
    assert.deepEqual(calls, [
      {
        key: { agentId: 'data', credentialId: 'op' },
        operation: 'read',
      },
    ]);
  });

  it('should permanently support a fixed process-environment fallback', async () => {
    const hostEnvironment = { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' };
    const service = new OnePasswordCredentialService({
      hostEnvironment,
      stores: [],
    });
    hostEnvironment.OP_SERVICE_ACCOUNT_TOKEN = 'changed-token';

    assert.deepEqual(await service.resolveServiceAccountToken('data'), {
      status: 'resolved',
      source: { id: 'process-environment', type: 'environment' },
      token: 'environment-token',
    });
  });

  it('should bypass the process environment for an exact store request', async () => {
    const calls: Array<{ key: CredentialKey; operation: string }> = [];
    const service = new OnePasswordCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      stores: [createStore('file', { status: 'missing' }, calls)],
    });

    assert.deepEqual(await service.resolveServiceAccountToken('data', { storeId: 'file' }), {
      status: 'missing',
    });
  });

  it('should allow an unavailable store to fall through but fail closed on unsafe state', async () => {
    const unavailable = new OnePasswordCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      stores: [
        createStore(
          'file',
          { status: 'unavailable', code: 'store-down', message: 'Store unavailable.' },
          [],
        ),
      ],
    });
    const unsafe = new OnePasswordCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      stores: [
        createStore(
          'file',
          { status: 'unsafe', code: 'store-unsafe', message: 'Store unsafe.' },
          [],
        ),
      ],
    });

    assert.equal((await unavailable.resolveServiceAccountToken('data')).status, 'resolved');
    assert.deepEqual(await unsafe.resolveServiceAccountToken('data'), {
      status: 'unsafe',
      code: 'store-unsafe',
      message: 'Store unsafe.',
    });
  });

  it('should route writes and removals through the selected store', async () => {
    const calls: Array<{ key: CredentialKey; operation: string; value?: string }> = [];
    const service = new OnePasswordCredentialService({
      hostEnvironment: {},
      stores: [createStore('file', { status: 'missing' }, calls)],
    });

    assert.deepEqual(await service.storeServiceAccountToken('data', 'file', 'private-token'), {
      status: 'stored',
    });
    assert.deepEqual(await service.removeServiceAccountToken('data', 'file'), {
      status: 'removed',
    });
    assert.deepEqual(calls.slice(-2), [
      {
        key: { agentId: 'data', credentialId: 'op' },
        operation: 'write',
        value: 'private-token',
      },
      {
        key: { agentId: 'data', credentialId: 'op' },
        operation: 'remove',
      },
    ]);
  });

  it('should reject unknown stores without trying the process environment', async () => {
    const service = new OnePasswordCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      stores: [],
    });

    assert.deepEqual(await service.resolveServiceAccountToken('data', { storeId: 'missing' }), {
      status: 'unavailable',
      code: 'credential-store-unknown',
      message: 'Credential store missing is not available.',
    });
  });
});
