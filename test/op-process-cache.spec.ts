import assert from 'node:assert/strict';

import processOpCache from '../environment/op-process-cache.ts';
import OpEnvironmentService from '../environment/op-service.ts';

const scope = { packageDir: '/test/plugin', stateDir: '/test/profile' };

describe('environment/op-process-cache', () => {
  it('should share an installation across module evaluations but isolate profiles and stores', async () => {
    const cache = processOpCache(scope);
    const reloaded = await import(
      new URL('../environment/op-process-cache.ts?registration=second', import.meta.url).href
    );
    assert.equal(reloaded.default(scope), cache);
    assert.equal(processOpCache({ ...scope, stateDir: '/test/profile/.' }), cache);
    assert.notEqual(processOpCache({ ...scope, stateDir: '/test/other-profile' }), cache);
    assert.notEqual(processOpCache({ ...scope, packageDir: '/test/other-plugin' }), cache);
    assert.notEqual(processOpCache({ ...scope, credentialRoot: '/test/other-store' }), cache);
  });

  it('should share configuration invalidation and failure backoff across registrations', async () => {
    const cache = processOpCache({ ...scope, stateDir: '/test/configuration' });
    let reads = 0;
    let fail = false;
    const registration = () =>
      new OpEnvironmentService({
        cache: processOpCache({ ...scope, stateDir: '/test/configuration' }),
        integrationVersion: 'test',
        readCachePolicy: () => ({ mode: 'process-lifetime' }),
        credentialService: {
          async resolveServiceAccountToken() {
            return {
              status: 'resolved',
              token: 'private-token',
              source: { id: 'file', type: 'store' },
            };
          },
        },
        async createClient() {
          return {
            async resolveSecret() {
              reads += 1;
              if (fail) throw new Error('private-provider-error');
              return 'private-value';
            },
            async getVariables() {
              return { variables: [] };
            },
          };
        },
      });
    const first = registration();
    const load = (service: OpEnvironmentService) =>
      service.load(
        'data',
        {
          environmentIds: [],
          secrets: [{ name: 'KEY', reference: 'op://private/item/key' }],
        },
        { workspaceDir: '/workspace' },
      );
    cache.configureContext({ agents: ['data'] });
    await load(first);
    const second = registration();
    cache.configureContext({ agents: ['data'] });
    await load(second);
    assert.equal(reads, 1);
    cache.configureContext({ agents: ['data', 'other'] });
    assert.equal(first.status().entries.length, 0);
    await load(first);
    assert.equal(reads, 2);
    second.flush();
    fail = true;
    assert.equal((await load(first)).status, 'invalid');
    second.flush();
    assert.equal((await load(second)).status, 'invalid');
    assert.equal(reads, 3);
    assert.equal(second.status().counts.backoffSkips, 1);
    assert.equal(JSON.stringify(second.status()).includes('private'), false);
  });
});
