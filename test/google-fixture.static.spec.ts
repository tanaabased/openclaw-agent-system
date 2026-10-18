import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import parseAgentManifest from '../manifest/parse.ts';

describe('google example configuration', () => {
  it('should declare environment-backed google credentials', async () => {
    const fixture = parseAgentManifest(
      await readFile('examples/openclaw-google/agent.yaml', 'utf8'),
    );
    assert.equal(fixture.status, 'valid');
    if (fixture.status !== 'valid') throw new Error();
    assert.equal(fixture.manifest.google?.credentialEncoding, 'base64');
    assert.equal(fixture.manifest.google?.account, undefined);
    assert.deepEqual(fixture.manifest.agent.email, { fromEnvironment: 'GOG_ACCOUNT' });
    assert.deepEqual(fixture.manifest.environment?.required, [
      'GOG_ACCOUNT',
      'GOG_CREDENTIALS_JSON_B64',
      'GOG_TOKEN_JSON_B64',
      'GOG_KEYRING_PASSWORD',
    ]);
  });
});
