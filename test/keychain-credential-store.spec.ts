import assert from 'node:assert/strict';

import KeychainCredentialStore, { type KeychainModule } from '../lib/keychain-credential-store.ts';

function createKeychain(): {
  calls: string[];
  keychain: KeychainModule;
  values: Map<string, string>;
} {
  const calls: string[] = [];
  const values = new Map<string, string>();
  class Entry {
    readonly #key: string;

    constructor(service: string, account: string) {
      this.#key = `${service}:${account}`;
    }

    async deleteCredential(): Promise<boolean> {
      calls.push(`delete:${this.#key}`);
      return values.delete(this.#key);
    }

    async setPassword(password: string): Promise<void> {
      calls.push(`set:${this.#key}`);
      values.set(this.#key, password);
    }
  }
  const keychain: KeychainModule = {
    AsyncEntry: Entry,
    async findCredentialsAsync(service) {
      calls.push(`find:${service}`);
      const prefix = `${service}:`;
      return [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, password]) => ({ account: key.slice(prefix.length), password }));
    },
  };
  return { calls, keychain, values };
}

describe('lib/keychain-credential-store', () => {
  it('should store, read, and idempotently remove one agent credential', async () => {
    const { calls, keychain } = createKeychain();
    const store = new KeychainCredentialStore({
      loadKeychain: async () => keychain,
      platform: 'darwin',
    });
    const key = { agentId: 'data', credentialId: 'op' };

    assert.deepEqual(await store.write(key, 'private-token'), { status: 'stored' });
    assert.deepEqual(await store.write(key, 'private-token'), { status: 'unchanged' });
    assert.deepEqual(await store.read(key), { status: 'found', value: 'private-token' });
    assert.deepEqual(await store.remove(key), { status: 'removed' });
    assert.deepEqual(await store.remove(key), { status: 'missing' });
    assert.equal(calls.includes('set:@tanaab/openclaw-agent-system/data:op'), true);
  });

  it('should report a missing binding or unsupported platform as unavailable', async () => {
    const missing = new KeychainCredentialStore({
      loadKeychain: async () => {
        throw new Error('private native error');
      },
      platform: 'darwin',
    });
    let loaded = false;
    const unsupported = new KeychainCredentialStore({
      loadKeychain: async () => {
        loaded = true;
        return createKeychain().keychain;
      },
      platform: 'linux',
    });

    assert.deepEqual(await missing.read({ agentId: 'data', credentialId: 'op' }), {
      status: 'unavailable',
      code: 'credential-keychain-unavailable',
      message: 'The macOS Keychain is not available.',
    });
    assert.equal(
      (await unsupported.read({ agentId: 'data', credentialId: 'op' })).status,
      'unavailable',
    );
    assert.equal(loaded, false);
  });

  it('should fail closed for ambiguous or invalid keychain values', async () => {
    const store = new KeychainCredentialStore({
      loadKeychain: async () => ({
        ...createKeychain().keychain,
        async findCredentialsAsync() {
          return [
            { account: 'op', password: 'first' },
            { account: 'op', password: 'second' },
          ];
        },
      }),
      platform: 'darwin',
    });

    assert.equal((await store.read({ agentId: 'data', credentialId: 'op' })).status, 'unsafe');
  });
});
