import assert from 'node:assert/strict';

import type {
  CredentialKey,
  CredentialStore,
  CredentialStoreReadResult,
  CredentialStoreRemoveResult,
  CredentialStoreWriteResult,
} from '../credentials/types.ts';
import OpCredentialService from '../credentials/op-service.ts';

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

describe('credentials/op-service', () => {
  it('should prefer stored credentials before the process-environment fallback', async () => {
    const calls: Array<{ key: CredentialKey; operation: string }> = [];
    const service = new OpCredentialService({
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

  it('should continue from a missing native store to the file store', async () => {
    const calls: Array<{ key: CredentialKey; operation: string }> = [];
    const service = new OpCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      stores: [
        createStore('keychain', { status: 'missing' }, calls),
        createStore('file', { status: 'found', value: 'stored-token' }, calls),
      ],
    });

    assert.deepEqual(await service.resolveServiceAccountToken('data'), {
      status: 'resolved',
      source: { id: 'file', type: 'store' },
      token: 'stored-token',
    });
    assert.deepEqual(
      calls.map(({ operation }) => operation),
      ['read', 'read'],
    );
  });

  it('should permanently support a fixed process-environment fallback', async () => {
    const hostEnvironment = { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' };
    const service = new OpCredentialService({
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
    const service = new OpCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      stores: [createStore('file', { status: 'missing' }, calls)],
    });

    assert.deepEqual(await service.resolveServiceAccountToken('data', { storeId: 'file' }), {
      status: 'missing',
    });
  });

  it('should allow an unavailable store to fall through but fail closed on unsafe state', async () => {
    const unavailable = new OpCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      stores: [
        createStore(
          'file',
          { status: 'unavailable', code: 'store-down', message: 'Store unavailable.' },
          [],
        ),
      ],
    });
    const unsafe = new OpCredentialService({
      hostEnvironment: { OP_SERVICE_ACCOUNT_TOKEN: 'environment-token' },
      stores: [
        createStore(
          'file',
          { status: 'unsafe', code: 'store-unsafe', message: 'Store unsafe.' },
          [],
        ),
      ],
    });
    const missing = new OpCredentialService({
      hostEnvironment: {},
      stores: [
        createStore(
          'keychain',
          { status: 'unavailable', code: 'store-down', message: 'Store unavailable.' },
          [],
        ),
        createStore('file', { status: 'missing' }, []),
      ],
    });

    assert.equal((await unavailable.resolveServiceAccountToken('data')).status, 'resolved');
    assert.deepEqual(await missing.resolveServiceAccountToken('data'), { status: 'missing' });
    assert.deepEqual(await unsafe.resolveServiceAccountToken('data'), {
      status: 'unsafe',
      code: 'store-unsafe',
      message: 'Store unsafe.',
    });
  });

  it('should route writes and removals through one exact store', async () => {
    const calls: Array<{ key: CredentialKey; operation: string; value?: string }> = [];
    const service = new OpCredentialService({
      hostEnvironment: {},
      stores: [createStore('file', { status: 'missing' }, calls)],
    });

    assert.deepEqual(await service.storeServiceAccountToken('data', 'file', 'private-token'), {
      status: 'stored',
      storeId: 'file',
    });
    assert.deepEqual(await service.removeServiceAccountToken('data', 'file'), {
      status: 'removed',
      storeIds: ['file'],
      unavailableStoreIds: [],
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

  it('should select the first writable store and remove every available copy by default', async () => {
    const calls: Array<{ key: CredentialKey; operation: string; value?: string }> = [];
    const unavailable = createStore('keychain', { status: 'missing' }, calls);
    unavailable.write = async (key, value) => {
      calls.push({ key, operation: 'write', value });
      return { status: 'unavailable', code: 'store-down', message: 'Store unavailable.' };
    };
    unavailable.remove = async (key) => {
      calls.push({ key, operation: 'remove' });
      return { status: 'unavailable', code: 'store-down', message: 'Store unavailable.' };
    };
    const service = new OpCredentialService({
      hostEnvironment: {},
      stores: [unavailable, createStore('file', { status: 'missing' }, calls)],
    });

    assert.deepEqual(await service.storeServiceAccountToken('data', undefined, 'private-token'), {
      status: 'stored',
      storeId: 'file',
    });
    assert.deepEqual(await service.removeServiceAccountToken('data'), {
      status: 'removed',
      storeIds: ['file'],
      unavailableStoreIds: ['keychain'],
    });
  });

  it('should keep exact and unsafe writes from falling through', async () => {
    const calls: Array<{ key: CredentialKey; operation: string; value?: string }> = [];
    const unavailable = createStore('keychain', { status: 'missing' }, calls);
    unavailable.write = async (key, value) => {
      calls.push({ key, operation: 'write', value });
      return { status: 'unavailable', code: 'store-down', message: 'Store unavailable.' };
    };
    const file = createStore('file', { status: 'missing' }, calls);
    const exactService = new OpCredentialService({
      hostEnvironment: {},
      stores: [unavailable, file],
    });

    assert.deepEqual(
      await exactService.storeServiceAccountToken('data', 'keychain', 'private-token'),
      {
        status: 'unavailable',
        code: 'store-down',
        message: 'Store unavailable.',
      },
    );
    assert.deepEqual(
      calls.map(({ operation }) => operation),
      ['write'],
    );

    calls.length = 0;
    const unsafe = createStore('keychain', { status: 'missing' }, calls);
    unsafe.write = async (key, value) => {
      calls.push({ key, operation: 'write', value });
      return { status: 'unsafe', code: 'store-unsafe', message: 'Store unsafe.' };
    };
    const automaticService = new OpCredentialService({
      hostEnvironment: {},
      stores: [unsafe, file],
    });

    assert.deepEqual(
      await automaticService.storeServiceAccountToken('data', undefined, 'private-token'),
      {
        status: 'unsafe',
        code: 'store-unsafe',
        message: 'Store unsafe.',
      },
    );
    assert.deepEqual(
      calls.map(({ operation }) => operation),
      ['write'],
    );
  });

  it('should reject unknown stores without trying the process environment', async () => {
    const service = new OpCredentialService({
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
