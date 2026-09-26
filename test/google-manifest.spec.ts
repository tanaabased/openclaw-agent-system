import assert from 'node:assert/strict';

import parseAgentManifest from '../manifest/parse.ts';
import resolveManifestValue from '../manifest/resolve-value.ts';
import { resolveGoogleConfiguration } from '../tools/google/config-schema.ts';

const bindings = '  oauth-client: CLIENT\n  oauth-token: TOKEN\n  keyring-password: PASSWORD';
describe('google manifest', () => {
  it('should parse both account declarations without resolving environment values', () => {
    for (const account of [
      '  account: one@example.com',
      '  account:\n    from-environment: GOOGLE_ACCOUNT',
    ]) {
      const parsed = parseAgentManifest(
        'schema-version: 1\nagent:\n  id: one\ngoogle:\n' + account + '\n' + bindings,
      );
      assert.equal(parsed.status, 'valid');
      if (parsed.status !== 'valid') throw new Error();
      const resolved = resolveGoogleConfiguration(parsed.manifest.google!, {
        resolve(value, path) {
          const resolution = resolveManifestValue(
            value,
            { GOOGLE_ACCOUNT: 'one@example.com' },
            path,
          );
          if (resolution.status !== 'resolved') throw new Error(resolution.diagnostic.code);
          return resolution.value;
        },
      });
      assert.equal(resolved.account, 'one@example.com');
      assert.equal(resolved.oauthClient, 'CLIENT');
    }
  });
  it('should reject unknown keys, raw secrets in binding fields and missing references', () => {
    assert.equal(
      parseAgentManifest(
        'schema-version: 1\nagent:\n  id: one\ngoogle:\n  account: one@example.com\n' +
          bindings +
          '\n  policy: {}',
      ).status,
      'invalid',
    );
    assert.equal(
      parseAgentManifest(
        'schema-version: 1\nagent:\n  id: one\ngoogle:\n  account: one@example.com\n' +
          bindings.replace('CLIENT', '"{secret}"'),
      ).status,
      'invalid',
    );
    const missing = resolveManifestValue({ fromEnvironment: 'MISSING' }, {}, '/google/account');
    assert.equal(missing.status, 'invalid');
    if (missing.status === 'invalid')
      assert.equal(missing.diagnostic.code, 'manifest-environment-value-missing');
  });
});
