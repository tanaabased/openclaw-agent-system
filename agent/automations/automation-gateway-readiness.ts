import { setTimeout } from 'node:timers/promises';
import gatewayErrorDiagnostic from '../../utils/gateway-error-diagnostic.ts';
import { nativeObject } from '../../utils/native-object.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { AutomationError } from './automation-errors.ts';
import {
  assertPrivateStateLocksHeld,
  privateStateLockSignal,
} from '../../core/private-state-lock-context.ts';
import { SessionDispatchConnectionError } from '../../credentials/session-dispatch-diagnostic.ts';
import waitForSessionDispatchGateway, {
  sessionDispatchReadinessTimeoutMs,
} from '../../credentials/session-dispatch-readiness.ts';

interface Dependencies {
  isLocal(): Promise<boolean>;
  readConfig(): OpenClawConfig;
  port(config: OpenClawConfig): number;
  wait: typeof waitForSessionDispatchGateway;
}

/** Reuse enrollment's bounded public readiness observation, not another plugin reload. */
export default async function waitForAutomationGateway(dependencies?: Dependencies): Promise<void> {
  assertPrivateStateLocksHeld();
  if (!dependencies) {
    const { isImplicitLocalGatewayTargetFromCli } =
      await import('openclaw/plugin-sdk/gateway-runtime');
    const { resolveGatewayPort } = await import('openclaw/plugin-sdk/core');
    const { captureRuntimeConfigAsyncReader, readRuntimeConfig: readConfig } =
      await import('openclaw/plugin-sdk/runtime-config-snapshot');
    await captureRuntimeConfigAsyncReader()();
    dependencies = {
      isLocal: () => isImplicitLocalGatewayTargetFromCli({}),
      readConfig,
      port: resolveGatewayPort,
      wait: waitForSessionDispatchGateway,
    };
  }
  // The existing probe supports local HTTP only. Never probe another endpoint or
  // reinterpret unsupported readiness as a successful model/session operation.
  if (!(await dependencies.isLocal())) return;
  const config = dependencies.readConfig();
  if (config.gateway?.tls?.enabled) return;
  const signal = privateStateLockSignal();
  try {
    await dependencies.wait(
      dependencies.port(config),
      {
        signal,
        assertCurrent: async () => {
          assertPrivateStateLocksHeld();
        },
      },
      { signal },
    );
  } catch (error) {
    assertPrivateStateLocksHeld();
    if (error instanceof SessionDispatchConnectionError)
      throw new AutomationError(`automation-${error.sessionDispatchDiagnostic.reasonCode}`);
    throw error;
  }
  assertPrivateStateLocksHeld();
}

/** A reachable scheduler can still be using the revision from before Install's config writes. */
export async function waitForSchedulerConfig(
  method: 'cron.add' | 'cron.update',
  read: (timeoutMs: number, signal?: AbortSignal) => Promise<unknown>,
  now = () => performance.now(),
  sleep = (ms: number, signal?: AbortSignal) => setTimeout(ms, undefined, { signal }),
) {
  const deadline = now() + sessionDispatchReadinessTimeoutMs;
  const signal = privateStateLockSignal();
  const guard = () => {
    assertPrivateStateLocksHeld();
    signal?.throwIfAborted();
  };
  try {
    while (now() < deadline) {
      guard();
      const snapshot = await read(Math.max(1, Math.floor(deadline - now())), signal);
      guard();
      if (
        !nativeObject(snapshot) ||
        snapshot.valid !== true ||
        typeof snapshot.configRevisionHash !== 'string' ||
        !snapshot.configRevisionHash
      )
        throw new AutomationError('automation-gateway-config-invalid');
      if (snapshot.configRevisionHash === snapshot.appliedConfigHash) return;
      await sleep(Math.min(500, Math.max(0, deadline - now())), signal);
    }
    throw new AutomationError('automation-gateway-config-revision-deadline');
  } catch (error) {
    guard();
    // A failed read never dispatched the scheduler write or consumed its create receipt.
    throw new AutomationError(
      error instanceof AutomationError ? error.code : 'automation-gateway-config-read-failed',
      { ...gatewayErrorDiagnostic(error), method, requestDispatched: false },
    );
  }
}
