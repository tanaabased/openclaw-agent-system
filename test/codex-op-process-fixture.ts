import assert from 'node:assert/strict';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { codexOpCredential, type CodexOpDependencies } from '../credentials/codex-op.ts';
import type { CredentialKey, CredentialStore } from '../credentials/types.ts';

export function opFixture(entries: Map<string, string>): CodexOpDependencies {
  const key = (id: CredentialKey) => JSON.stringify(id);
  const store: CredentialStore = {
    id: 'keychain',
    async read(id) {
      const value = entries.get(key(id));
      return value ? { status: 'found', value } : { status: 'missing' };
    },
    async write(id, value) {
      entries.set(key(id), value);
      return { status: 'stored' };
    },
    async remove(id) {
      return { status: entries.delete(key(id)) ? 'removed' : 'missing' };
    },
  };
  return {
    store,
    input: { read: async () => ({ status: 'read', source: 'prompt', token: 'fixture-token' }) },
    async createClient(token) {
      if (token !== 'fixture-token')
        throw Object.assign(new Error('fixture-token'), { httpStatus: 401 });
      return {
        async getVariables(id) {
          assert.equal(id, 'shared-id');
          return {
            variables: [{ name: 'DB_PASSWORD', masked: true, value: 'fixture-shared-value' }],
          };
        },
        async resolveSecret(ref) {
          assert.equal(ref, 'op://private/item/password');
          return 'fixture-private-value';
        },
      };
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [data, scope] = process.argv.slice(2);
  if (!data || (scope !== 'binding' && scope !== 'installation'))
    throw new Error('invalid fixture arguments');
  // Simulate the OS store surviving between processes. Only the synthetic fixture uses stdin.
  const entries = new Map<string, string>(JSON.parse(await text(process.stdin)));
  const credential = await codexOpCredential(data, scope, opFixture(entries));
  assert.ok(credential);
  const binding = scope === 'binding';
  const value = await credential.resolve(binding ? 'PRIVATE' : 'DB_PASSWORD');
  assert.ok(value === (binding ? 'fixture-private-value' : 'fixture-shared-value'));
}
