import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { AutomationError } from './automation-errors.ts';
import {
  assertPrivateStateLocksHeld,
  privateStateLockSignal,
} from '../../core/private-state-lock-context.ts';
import { SessionDispatchConnectionError } from '../../credentials/session-dispatch-diagnostic.ts';
import waitForSessionDispatchGateway from '../../credentials/session-dispatch-readiness.ts';

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
    const { default: readConfig } = await import('../../core/read-fresh-runtime-config.ts');
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
