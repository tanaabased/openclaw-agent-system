import assert from 'node:assert/strict';

import createCredentialStores from '../lib/credential-store-registry.ts';

describe('lib/credential-store-registry', () => {
  it('should prefer keychain on macos', () => {
    assert.deepEqual(
      createCredentialStores({ environment: { HOME: '/tmp/home' }, platform: 'darwin' }).map(
        ({ id }) => id,
      ),
      ['keychain', 'file'],
    );
  });

  it('should prefer secret service on linux', () => {
    assert.deepEqual(
      createCredentialStores({ environment: { HOME: '/tmp/home' }, platform: 'linux' }).map(
        ({ id }) => id,
      ),
      ['secret-service', 'file'],
    );
  });

  it('should use only the file fallback on other platforms', () => {
    assert.deepEqual(
      createCredentialStores({ environment: { HOME: '/tmp/home' }, platform: 'aix' }).map(
        ({ id }) => id,
      ),
      ['file'],
    );
  });
});
