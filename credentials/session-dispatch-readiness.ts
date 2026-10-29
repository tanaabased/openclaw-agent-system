import { get } from 'node:http';
import { setTimeout } from 'node:timers/promises';

import type { EventLoopReadyOptions, EventLoopReadyResult } from '@openclaw/gateway-client';

import { SessionDispatchConnectionError } from './session-dispatch-diagnostic.ts';
import {
  observeReadiness,
  readinessObservationLimit,
  type ReadinessEvidence,
  type ReadinessObservation,
} from './session-dispatch-readiness-evidence.ts';
import type { DispatchAuthority } from './session-dispatch.ts';

type Probe = { statusCode: number; body: unknown; malformed?: boolean };
// cold plugin reloads can outlast the native handshake; keep their budget separate.
export const sessionDispatchReadinessTimeoutMs = 90_000;
export interface ReadinessOptions extends EventLoopReadyOptions {
  onEvidence?(evidence: ReadinessEvidence): void;
}
interface Dependencies {
  request(port: number, path: string, timeoutMs: number, signal?: AbortSignal): Promise<Probe>;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<unknown>;
}

const nativeDependencies: Dependencies = {
  request: (port, path, timeoutMs, signal) =>
    new Promise((resolve, reject) => {
      const request = get(
        { hostname: '127.0.0.1', port, path, agent: false, signal },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 16_384)
              request.destroy(
                Object.assign(new Error('probe-response-too-large'), {
                  code: 'PROBE_RESPONSE_TOO_LARGE',
                }),
              );
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve({
                statusCode: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
              });
            } catch {
              resolve({ statusCode: response.statusCode ?? 0, body: undefined, malformed: true });
            }
          });
        },
      );
      const timer = globalThis.setTimeout(
        () => request.destroy(Object.assign(new Error('probe-timeout'), { code: 'PROBE_TIMEOUT' })),
        timeoutMs,
      );
      request.once('error', reject);
      request.once('close', () => clearTimeout(timer));
    }),
  now: () => performance.now(),
  sleep: (ms, signal) => setTimeout(ms, undefined, { signal }),
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** coordinate startup/reload only; the subsequent device-authenticated hello proves readiness. */
export default async function waitForSessionDispatchGateway(
  port: number,
  authority: DispatchAuthority,
  options: ReadinessOptions,
  dependencies: Dependencies = nativeDependencies,
): Promise<EventLoopReadyResult> {
  const started = dependencies.now();
  const maxWaitMs = options.maxWaitMs ?? sessionDispatchReadinessTimeoutMs;
  const deadline = started + maxWaitMs;
  let checks = 0;
  const observations: ReadinessObservation[] = [];
  const evidence = (): ReadinessEvidence => ({
    state: 'observed',
    elapsedMs: dependencies.now() - started,
    maxWaitMs,
    totalObservations: checks,
    droppedObservations: checks - observations.length,
    observations: [...observations],
  });
  const observe = (path: ReadinessObservation['path'], probe?: Probe, error?: unknown) => {
    observations.push(observeReadiness(path, dependencies.now() - started, probe, error));
    // retain the first observation and recent tail, in chronological order.
    if (observations.length > readinessObservationLimit) observations.splice(1, 1);
    options.onEvidence?.(evidence());
  };
  const guard = async () => {
    options.signal?.throwIfAborted();
    authority.signal?.throwIfAborted();
    authority.assertEnrollmentCurrent?.();
    await authority.assertCurrent?.();
    options.signal?.throwIfAborted();
    authority.signal?.throwIfAborted();
    authority.assertEnrollmentCurrent?.();
  };
  while (dependencies.now() < deadline) {
    await guard();
    let waiting = false;
    for (const path of ['/startupz', '/readyz'] as const) {
      const remaining = Math.floor(deadline - dependencies.now());
      if (remaining <= 0) {
        waiting = true;
        break;
      }
      checks++;
      let probe: Probe;
      try {
        probe = await dependencies.request(port, path, Math.min(2_000, remaining), options.signal);
      } catch (error) {
        await guard();
        observe(path, undefined, error);
        waiting = true;
        break;
      }
      await guard();
      observe(path, probe);
      const body = object(probe.body);
      // unsupported probes fall through to authenticated hello, never to enrollment success.
      if (![200, 503].includes(probe.statusCode) || !body) break;
      if (path === '/startupz') {
        if (body.ok === false && ['starting', 'draining'].includes(String(body.status))) {
          waiting = true;
          break;
        }
        if (body.ok !== true || body.status !== 'started') break;
      } else if (
        body.ready === false &&
        Array.isArray(body.failing) &&
        body.failing.includes('plugin-reload')
      ) {
        const phase = object(body.pluginReload)?.phase;
        if (phase === 'failed')
          throw new SessionDispatchConnectionError({
            category: 'gateway-rejected',
            phase: 'connection',
            reasonCode: 'gateway-reload-failed',
            readinessEvidence: evidence(),
          });
        if (phase === 'reloading' || phase === 'recovering') waiting = true;
      }
    }
    await guard();
    if (!waiting && dependencies.now() < deadline)
      return {
        ready: true,
        elapsedMs: dependencies.now() - started,
        maxDriftMs: 0,
        checks,
        aborted: false,
      };
    const remaining = deadline - dependencies.now();
    if (remaining > 0) await dependencies.sleep(Math.min(500, remaining), options.signal);
  }
  await guard();
  throw new SessionDispatchConnectionError({
    category: 'timeout',
    phase: 'connection',
    reasonCode: 'gateway-readiness-deadline',
    readinessEvidence: evidence(),
  });
}
