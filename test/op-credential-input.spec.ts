import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import OpCredentialInput from '../credentials/op-input.ts';

function stream(isTTY = false): PassThrough & { isTTY?: boolean } {
  return Object.assign(new PassThrough(), { isTTY });
}

describe('credentials/op-input', () => {
  it('should read the fixed process-environment credential without changing it', async () => {
    const input = stream();
    const output = stream();
    const environment = { OP_SERVICE_ACCOUNT_TOKEN: 'private-token' };
    const reader = new OpCredentialInput({ hostEnvironment: environment, input, output });
    environment.OP_SERVICE_ACCOUNT_TOKEN = 'changed-token';

    assert.deepEqual(await reader.read('environment'), {
      status: 'read',
      source: 'environment',
      token: 'private-token',
    });
  });

  it('should read stdin and remove one terminal line ending', async () => {
    const input = stream();
    input.end('private-token\r\n');
    const reader = new OpCredentialInput({ hostEnvironment: {}, input, output: stream() });

    assert.deepEqual(await reader.read('stdin'), {
      status: 'read',
      source: 'stdin',
      token: 'private-token',
    });
  });

  it('should use a masked prompt only with interactive streams', async () => {
    const input = stream(true);
    const output = stream(true);
    let promptMessage = '';
    const reader = new OpCredentialInput({
      hostEnvironment: {},
      input,
      output,
      async prompt(options) {
        promptMessage = options.message;
        return 'private-token';
      },
    });

    assert.deepEqual(await reader.read('prompt'), {
      status: 'read',
      source: 'prompt',
      token: 'private-token',
    });
    assert.equal(promptMessage, 'Enter OP service account token');
  });

  it('should direct noninteractive users to explicit input sources', async () => {
    const reader = new OpCredentialInput({
      hostEnvironment: {},
      input: stream(),
      output: stream(),
    });

    assert.deepEqual(await reader.read('prompt'), {
      status: 'invalid',
      code: 'op-credential-input-required',
      message: 'Interactive credential input requires a terminal. Use --from-env or --stdin.',
    });
  });

  it('should reject empty, cancelled, and oversized credential input', async () => {
    const cancelled = new OpCredentialInput({
      hostEnvironment: {},
      input: stream(true),
      output: stream(true),
      async prompt() {
        return Symbol('cancel');
      },
    });
    const oversizedInput = stream();
    oversizedInput.end('x'.repeat(64 * 1024 + 1));
    const oversized = new OpCredentialInput({
      hostEnvironment: {},
      input: oversizedInput,
      output: stream(),
    });

    assert.equal((await cancelled.read('prompt')).status, 'invalid');
    assert.equal((await oversized.read('stdin')).status, 'invalid');
  });
});
