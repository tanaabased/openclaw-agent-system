import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import {
  issueDeviceBootstrapToken,
  listDevicePairing,
  revokeDeviceBootstrapToken,
} from 'openclaw/plugin-sdk/device-bootstrap';

import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import connectSessionDispatch, { useSessionDispatchClient } from './session-dispatch-client.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import KeychainCredentialStore from './keychain-store.ts';
import SecretServiceCredentialStore from './secret-service-store.ts';
import SessionDispatchCredential from './session-dispatch.ts';
import { sessionDispatchScopes } from '../agent/session-dispatch-requirements.ts';

/** share one protected service identity across registrations and processes for this gateway. */
export default function createSessionDispatchCredential(options: {
  stateDir: string;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}) {
  const stateDir = resolve(options.stateDir);
  const scope = createHash('sha256').update(stateDir).digest('hex');
  const directory = join(stateDir, 'agent-system-session-dispatch');
  return new SessionDispatchCredential({
    key: { agentId: `gateway-${scope}`, credentialId: 'session-dispatch' },
    store:
      process.platform === 'darwin'
        ? new KeychainCredentialStore()
        : new SecretServiceCredentialStore(),
    async lock(operation) {
      await ensurePrivateStateDirectories({
        directories: [directory],
        currentUid: process.getuid?.(),
        label: 'Session dispatch lock',
      });
      const lease = await acquirePrivateStateFileLock(join(directory, 'enrollment'), {
        staleMs: 30_000,
        retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
      });
      try {
        return await operation(lease.assertHeld);
      } finally {
        await lease.release();
      }
    },
    async pairing(deviceId) {
      const inventory = await listDevicePairing(stateDir);
      const paired = inventory.paired.find((entry) => entry.deviceId === deviceId);
      const token = paired?.tokens?.operator;
      return {
        paired: !!paired,
        usable:
          !!token &&
          !token.revokedAtMs &&
          sessionDispatchScopes.every((scope) => token.scopes.includes(scope)),
        requestId: inventory.pending.find((entry) => entry.deviceId === deviceId)?.requestId,
      };
    },
    issue: (assertCurrent) =>
      issueDeviceBootstrapToken({
        baseDir: stateDir,
        roles: ['operator'],
        scopes: sessionDispatchScopes,
        assertCurrent,
      }),
    revoke: (token) => revokeDeviceBootstrapToken({ baseDir: stateDir, token }),
    use: async (record, authority, operation) =>
      useSessionDispatchClient(
        await options.readConfig(),
        record,
        false,
        authority,
        (request, hello) => operation(request, hello.scopes),
      ),
    connect: async (record, bootstrap, authority) =>
      connectSessionDispatch(await options.readConfig(), record, bootstrap, authority),
  });
}
