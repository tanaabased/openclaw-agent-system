import assert from 'node:assert/strict';
import redact from '../agent/codex-feedback-redaction.ts';

describe('agent/codex-feedback-redaction', () => {
  it('should allow harmless file references without weakening credential checks', () => {
    for (const value of [
      '/Users/example/repo/README.md',
      '/home/example/project/test.ts',
      '/private/tmp/fixture.txt',
      'C:\\Users\\example\\repo\\README.md',
    ])
      assert.equal(redact(value), value);
    for (const value of [
      'password: example-secret',
      'Bearer example-token',
      'https://user:pass@example.com',
      'https://example.com?token=example',
      '-----BEGIN PRIVATE KEY-----',
    ])
      assert.notEqual(redact(value), value);
  });
});
