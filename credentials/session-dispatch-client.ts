import { createPublicKey, sign } from 'node:crypto';

import {
  GatewayClient,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
} from '@openclaw/gateway-client';
import { PROTOCOL_VERSION } from '@openclaw/gateway-protocol/version';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import {
  dispatchCredentialError,
  type DispatchAuthority,
  type DispatchCredential,
  type DispatchRequest,
} from './session-dispatch.ts';
import { sessionDispatchScopes } from '../agent/session-dispatch-requirements.ts';

/** authenticate only with the retained service identity, never ambient gateway credentials. */
export default async function connectSessionDispatch(
  config: OpenClawConfig,
  record: DispatchCredential,
  bootstrap: boolean,
  authority: DispatchAuthority,
) {
  return useSessionDispatchClient(
    config,
    record,
    bootstrap,
    authority,
    async (_request, hello) => hello,
  );
}

export async function useSessionDispatchClient<T>(
  config: OpenClawConfig,
  record: DispatchCredential,
  bootstrap: boolean,
  authority: DispatchAuthority,
  operation: (request: DispatchRequest, hello: { token?: string; scopes: string[] }) => Promise<T>,
) {
  if (config.gateway?.tls?.enabled)
    dispatchCredentialError(
      'session-dispatch-tls-unavailable',
      'Session dispatch enrollment currently requires a local non-TLS Gateway.',
    );
  const port = config.gateway?.port ?? 18789;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    dispatchCredentialError(
      'session-dispatch-endpoint-invalid',
      'The configured local Gateway port is invalid.',
    );
  const assertCurrent = () => {
    authority.signal?.throwIfAborted();
    authority.assertEnrollmentCurrent?.();
  };
  assertCurrent();
  const ready = Promise.withResolvers<{ token?: string; scopes: string[] }>();
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    env: {},
    clientName: 'gateway-client',
    clientDisplayName: 'Agent System',
    clientVersion: '1',
    mode: 'backend',
    role: 'operator',
    scopes: [...sessionDispatchScopes],
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    deviceIdentity: record.device,
    ...(bootstrap ? { bootstrapToken: record.bootstrap?.token } : { deviceToken: record.token }),
    requestTimeoutMs: 10_000,
    hostDeps: {
      beforeConnect: assertCurrent,
      signDevicePayload: (pem, payload) =>
        sign(null, Buffer.from(payload), pem).toString('base64url'),
      publicKeyRawBase64UrlFromPem: (pem) =>
        createPublicKey(pem)
          .export({ format: 'der', type: 'spki' })
          .subarray(-32)
          .toString('base64url'),
      loadDeviceAuthToken: () => null,
      storeDeviceAuthToken() {},
      clearDeviceAuthToken() {},
      logDebug() {},
      logError() {},
    },
    onHelloOk: (hello) =>
      ready.resolve({ token: hello.auth?.deviceToken, scopes: hello.auth?.scopes ?? [] }),
    onConnectError: () => ready.reject(new Error('session-dispatch-connect-failed')),
  });
  const abort = () => {
    ready.reject(new Error('session-dispatch-connect-cancelled'));
    client.stop();
  };
  authority.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => ready.reject(new Error('session-dispatch-connect-timeout')),
    12_000,
  );
  try {
    assertCurrent();
    client.start();
    const hello = await ready.promise;
    clearTimeout(timer);
    assertCurrent();
    return await operation(
      sessionDispatchRequest((method, params) => client.request(method, params), authority),
      hello,
    );
  } finally {
    clearTimeout(timer);
    authority.signal?.removeEventListener('abort', abort);
    await client.stopAndWait({ timeoutMs: 1500 });
  }
}

/** admit workflow method families; gateway grants and handler policy still govern every call. */
export function sessionDispatchRequest(
  request: DispatchRequest,
  authority: DispatchAuthority,
): DispatchRequest {
  const assertCurrent = () => {
    authority.signal?.throwIfAborted();
    authority.assertEnrollmentCurrent?.();
  };
  const operations: Record<string, string> = {
    'sessions.create': 'create',
    'sessions.describe': 'describe',
    'chat.history': 'history',
  };
  const families = [
    'sessions',
    'session',
    'chat',
    'agent',
    'agents',
    'models',
    'tools',
    'skills',
    'commands',
    'artifacts',
    'progressCard',
    'audit',
    'cron',
    'question',
    'exec.approval',
    'usage',
  ];
  const methods = new Set(['agent', 'health', 'status', 'logs.tail']);
  return async (method, params) => {
    assertCurrent();
    await authority.assertCurrent?.();
    assertCurrent();
    if (
      method.length > 96 ||
      !/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/.test(method) ||
      (!methods.has(method) && !families.some((family) => method.startsWith(`${family}.`)))
    )
      throw new Error('session-dispatch-method-unavailable');
    const operation = Object.hasOwn(operations, method)
      ? operations[method]
      : method.replaceAll('.', '-').toLowerCase();
    const result = await request(method, params).catch((error: unknown) => {
      assertCurrent();
      const reason =
        error instanceof GatewayClientRequestTimeoutError
          ? 'timeout-unverified'
          : error instanceof GatewayClientRequestError && error.code === 'INVALID_REQUEST'
            ? 'request-invalid'
            : error instanceof GatewayClientRequestError && error.code === 'FORBIDDEN'
              ? 'forbidden'
              : error instanceof GatewayClientRequestError && error.code === 'UNAVAILABLE'
                ? 'unavailable-unverified'
                : 'request-unverified';
      throw new Error(`session-dispatch-${operation}-${reason}`);
    });
    assertCurrent();
    return result;
  };
}
