import assert from 'node:assert/strict';

import { googleConfiguration, googleValues, material } from './google-test-fixture.ts';

describe('google credential encoding', () => {
  it('should decode base64 consistently with json and redact both representations', () => {
    const configuration = { ...googleConfiguration, credentialEncoding: 'base64' as const };
    const values = {
      ...googleValues,
      CLIENT: Buffer.from(googleValues.CLIENT).toString('base64'),
      TOKEN: Buffer.from(googleValues.TOKEN).toString('base64'),
    };
    const decoded = material(configuration, values);
    assert.equal(decoded.fingerprint, material().fingerprint);
    assert.equal(decoded.clientJSON, material().clientJSON);
    assert.equal(decoded.tokenJSON, material().tokenJSON);
    for (const secret of [
      values.CLIENT,
      values.TOKEN,
      googleValues.CLIENT,
      googleValues.TOKEN,
      decoded.clientJSON,
      decoded.tokenJSON,
      googleValues.PASSWORD,
    ])
      assert.ok(decoded.sensitiveValues.includes(secret));
  });
  it('should reject malformed, oversized, wrong-account and incorrectly selected encodings', () => {
    const configuration = { ...googleConfiguration, credentialEncoding: 'base64' as const };
    const token = Buffer.from(googleValues.TOKEN).toString('base64');
    for (const client of [
      '!',
      'abcd=',
      'Zh==',
      'a'.repeat(65537),
      Buffer.from([0xff]).toString('base64'),
      googleValues.CLIENT,
    ])
      assert.throws(
        () => material(configuration, { ...googleValues, CLIENT: client, TOKEN: token }),
        { code: 'credential_unavailable' },
      );
    assert.throws(
      () =>
        material(configuration, {
          ...googleValues,
          CLIENT: Buffer.from(googleValues.CLIENT).toString('base64'),
          TOKEN: Buffer.from('{"email":"other@example.com","refresh_token":"secret"}').toString(
            'base64',
          ),
        }),
      { code: 'credential_unavailable' },
    );
    assert.throws(
      () =>
        material(googleConfiguration, {
          ...googleValues,
          CLIENT: Buffer.from(googleValues.CLIENT).toString('base64'),
        }),
      { code: 'credential_unavailable' },
    );
  });
});
