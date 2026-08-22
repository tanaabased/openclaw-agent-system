import assert from 'node:assert/strict';

import SecretServiceCredentialStore, {
  type SecretServiceCommandRunner,
} from '../credentials/secret-service-store.ts';
import type { CredentialCommandResult } from '../credentials/run-command.ts';

function completed(exitCode: number, stdout = '', stderr = ''): CredentialCommandResult {
  return {
    exitCode,
    status: 'completed',
    stderr: Buffer.from(stderr),
    stdout: Buffer.from(stdout),
  };
}

describe('credentials/secret-service-store', () => {
  it('should use deterministic attributes and pass credentials only through stdin', async () => {
    const results = [
      completed(1),
      completed(0),
      completed(0, 'private-token'),
      completed(0, 'private-token'),
      completed(0),
      completed(1),
    ];
    const calls: Parameters<SecretServiceCommandRunner>[0][] = [];
    const store = new SecretServiceCredentialStore({
      environment: {
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/test-bus',
        OP_SERVICE_ACCOUNT_TOKEN: 'environment-token',
      },
      platform: 'linux',
      async runCommand(options) {
        calls.push(options);
        return results.shift() ?? completed(1);
      },
    });
    const key = { agentId: 'data', credentialId: 'op' };

    assert.deepEqual(await store.write(key, 'private-token'), { status: 'stored' });
    assert.deepEqual(await store.write(key, 'private-token'), { status: 'unchanged' });
    assert.deepEqual(await store.remove(key), { status: 'removed' });
    assert.deepEqual(await store.remove(key), { status: 'missing' });

    const storeCall = calls.find(({ args }) => args[0] === 'store');
    assert.equal(storeCall?.command, 'secret-tool');
    assert.equal(storeCall?.input, 'private-token');
    assert.equal(storeCall?.args.includes('private-token'), false);
    assert.equal(storeCall?.environment?.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/tmp/test-bus');
    assert.equal(storeCall?.environment?.OP_SERVICE_ACCOUNT_TOKEN, undefined);
    assert.deepEqual(storeCall?.args.slice(-6), [
      'application',
      'tanaab-openclaw-agent-system',
      'agent',
      'data',
      'credential',
      'op',
    ]);
  });

  it('should distinguish missing credentials from an unavailable session', async () => {
    const missing = new SecretServiceCredentialStore({
      platform: 'linux',
      runCommand: async () => completed(1),
    });
    const unavailable = new SecretServiceCredentialStore({
      platform: 'linux',
      runCommand: async () => completed(1, '', 'No such interface'),
    });

    assert.deepEqual(await missing.read({ agentId: 'data', credentialId: 'op' }), {
      status: 'missing',
    });
    assert.deepEqual(await unavailable.read({ agentId: 'data', credentialId: 'op' }), {
      status: 'unavailable',
      code: 'credential-secret-service-unavailable',
      message: 'The Linux Secret Service is not available in this session.',
    });
  });

  it('should fall back safely for tool limits, failures, and unsupported platforms', async () => {
    let calls = 0;
    const store = new SecretServiceCredentialStore({
      platform: 'linux',
      runCommand: async () => {
        calls += 1;
        throw new Error('private subprocess error');
      },
    });
    const unsupported = new SecretServiceCredentialStore({ platform: 'darwin' });

    assert.equal(
      (await store.write({ agentId: 'data', credentialId: 'op' }, 'x'.repeat(8_192))).status,
      'unavailable',
    );
    assert.equal(calls, 0);
    assert.equal((await store.read({ agentId: 'data', credentialId: 'op' })).status, 'unavailable');
    assert.equal(
      (await unsupported.read({ agentId: 'data', credentialId: 'op' })).status,
      'unavailable',
    );
  });
});
