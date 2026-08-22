import assert from 'node:assert/strict';

import resolveManifestValue from '../manifest/resolve-value.ts';

describe('manifest/resolve-value', () => {
  it('should preserve literal values without consulting the environment', () => {
    assert.deepEqual(
      resolveManifestValue('$AGENT_NAME', { AGENT_NAME: 'Private Name' }, '/agent/name'),
      { status: 'resolved', value: '$AGENT_NAME' },
    );
  });

  it('should resolve a binding from the completed agent environment', () => {
    assert.deepEqual(
      resolveManifestValue(
        { fromEnvironment: 'AGENT_NAME' },
        { AGENT_NAME: 'Data' },
        '/agent/name',
      ),
      { status: 'resolved', value: 'Data' },
    );
  });

  it('should report missing and empty bindings without exposing other values', () => {
    for (const environment of [{ PRIVATE_VALUE: 'private-value' }, { AGENT_NAME: '' }]) {
      const result = resolveManifestValue(
        { fromEnvironment: 'AGENT_NAME' },
        environment,
        '/agent/name',
      );

      assert.equal(result.status, 'invalid');
      if (result.status !== 'invalid') continue;
      assert.equal(result.diagnostic.code, 'manifest-environment-value-missing');
      assert.equal(result.diagnostic.fieldPath, '/agent/name');
      assert.equal(JSON.stringify(result).includes('private-value'), false);
    }
  });
});
