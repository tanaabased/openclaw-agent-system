import { createPublicKey, sign } from 'node:crypto';

import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  GatewayClient,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
  startGatewayClientWithReadinessWait,
  type EventLoopReadyResult,
  type GatewayClientOptions,
} from '@openclaw/gateway-client';
import { PROTOCOL_VERSION } from '@openclaw/gateway-protocol/version';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import {
  classifySessionDispatchFailure,
  SessionDispatchConnectionError,
  sessionDispatchDeadlineError,
} from './session-dispatch-diagnostic.ts';
import waitForSessionDispatchGateway, {
  sessionDispatchReadinessTimeoutMs,
  type ReadinessOptions,
} from './session-dispatch-readiness.ts';
import type { ReadinessEvidence } from './session-dispatch-readiness-evidence.ts';
import {
  dispatchCredentialError,
  type DispatchAuthority,
  type DispatchCredential,
  type DispatchRequest,
} from './session-dispatch.ts';
import { sessionDispatchScopes } from '../agent/session-dispatch-requirements.ts';
import { openclawSessionCreateTimeoutMs } from '../agent/openclaw-session-timeout.ts';
import automationGatewayDiagnostic from '../agent/automation-gateway-diagnostic.ts';

interface SessionDispatchClientDependencies {
  createClient(
    options: GatewayClientOptions,
  ): Pick<GatewayClient, 'start' | 'stop' | 'stopAndWait' | 'request'>;
  scheduleDeadline(callback: () => void, milliseconds: number): () => void;
  waitForGateway?(
    port: number,
    authority: DispatchAuthority,
    options: ReadinessOptions,
  ): Promise<EventLoopReadyResult>;
}

const clientDependencies: SessionDispatchClientDependencies = {
  createClient: (options) => new GatewayClient(options),
  waitForGateway: waitForSessionDispatchGateway,
  scheduleDeadline(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

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
  dependencies: SessionDispatchClientDependencies = clientDependencies,
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
  const startup = new AbortController();
  let awaitingReadiness = !!authority.waitForGateway;
  let readinessEvidence: ReadinessEvidence | undefined;
  const ready = Promise.withResolvers<{ token?: string; scopes: string[] }>();
  const client = dependencies.createClient({
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
    onConnectError: (error) => {
      const diagnostic = classifySessionDispatchFailure(error);
      // the sdk reconnects these transport failures with the same explicit credential.
      if (
        authority.waitForGateway &&
        ['connection-refused', 'connection-reset', 'broken-pipe', 'transport-timeout'].includes(
          diagnostic.reasonCode,
        )
      )
        return;
      ready.reject(new SessionDispatchConnectionError(diagnostic));
    },
  });
  const abort = () => {
    ready.reject(new Error('session-dispatch-connect-cancelled'));
    startup.abort();
    client.stop();
  };
  authority.signal?.addEventListener('abort', abort, { once: true });
  const clearDeadline = dependencies.scheduleDeadline(
    () => {
      ready.reject(
        awaitingReadiness
          ? new SessionDispatchConnectionError({
              category: 'timeout',
              phase: 'connection',
              reasonCode: 'gateway-readiness-deadline',
              ...(readinessEvidence ? { readinessEvidence } : {}),
            })
          : sessionDispatchDeadlineError(),
      );
      startup.abort();
    },
    DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS +
      DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS +
      (authority.waitForGateway ? sessionDispatchReadinessTimeoutMs : 0),
  );
  let failed = false;
  try {
    assertCurrent();
    const start = authority.waitForGateway
      ? startGatewayClientWithReadinessWait(
          (options) =>
            (dependencies.waitForGateway ?? waitForSessionDispatchGateway)(port, authority, {
              ...options,
              onEvidence: (evidence) => {
                readinessEvidence = evidence;
              },
            }),
          {
            start() {
              assertCurrent();
              awaitingReadiness = false;
              client.start();
            },
          },
          { signal: startup.signal, timeoutMs: sessionDispatchReadinessTimeoutMs },
        )
      : Promise.resolve(client.start());
    const hello = await Promise.race([ready.promise, start.then(() => ready.promise)]).catch(
      (error: unknown) => {
        assertCurrent();
        throw error;
      },
    );
    clearDeadline();
    assertCurrent();
    return await operation(
      sessionDispatchRequest(
        (method, params) =>
          method === 'sessions.create'
            ? client.request(method, params, {
                timeoutMs: openclawSessionCreateTimeoutMs,
                signal: authority.signal,
              })
            : client.request(method, params),
        authority,
      ),
      hello,
    );
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    startup.abort();
    clearDeadline();
    authority.signal?.removeEventListener('abort', abort);
    await client.stopAndWait().catch(() => {
      // cleanup must not hide the original failure or expose unrestricted sdk errors.
      if (!failed) {
        assertCurrent();
        throw new SessionDispatchConnectionError(classifySessionDispatchFailure(undefined));
      }
    });
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
      // preserve only the known settings rejection, never the native model name or prose.
      if (
        method === 'sessions.patch' &&
        automationGatewayDiagnostic('sessions.patch', error).reason === 'model-runtime-unavailable'
      )
        throw new Error('session-dispatch-sessions-patch-model-runtime-unavailable');
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
