import { setTimeout } from 'node:timers/promises';

import {
  callGatewayFromCli,
  ErrorCodes,
  isGatewayClientRequestError,
  isGatewayTransportError,
} from 'openclaw/plugin-sdk/gateway-runtime';

import gatewayUnavailable from './automation-gateway-unavailable.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import type { Logger } from '../core/logger.ts';

export default async function waitForGatewayAgent(
  agentId: string,
  logger?: Pick<Logger, 'debug' | 'info'>,
): Promise<void> {
  const started = performance.now();
  const deadline = started + 30_000;
  let observedGateway = false;
  let target: 'unverified' | 'absent' | 'visible' = 'unverified';
  let attempts = 0;
  let requestMs = 0;
  const evidence = () => ({
    agentId,
    config: 'verified',
    lastGatewayObservation: observedGateway ? 'reachable' : 'unverified',
    target,
    attempts,
    elapsedMs: Math.round(performance.now() - started),
    lastRequestMs: requestMs,
  });
  const finish = (outcome: string, failure?: Record<string, unknown>) => {
    const details = JSON.stringify({ ...evidence(), ...(failure ? { failure } : {}) });
    logger?.info(`agent registration ${outcome}: ${details}`);
    return details;
  };
  logger?.debug?.(`agent registration visibility started: ${JSON.stringify(evidence())}`);
  while (performance.now() < deadline) {
    const requestBudget = deadline - performance.now();
    // do not start a gateway request with only the deadline's fractional tail left.
    if (requestBudget < 1000) {
      if (requestBudget > 0) await setTimeout(requestBudget);
      break;
    }
    const timeoutMs = Math.min(10_000, Math.floor(requestBudget));
    const requestStarted = performance.now();
    attempts += 1;
    logger?.debug?.(
      `agent registration gateway request: ${JSON.stringify({ ...evidence(), timeoutMs })}`,
    );
    let response: unknown;
    try {
      response = await callGatewayFromCli(
        'agents.list',
        { timeout: String(timeoutMs) },
        {},
        { progress: false, scopes: ['operator.read'], sharedStateMode: 'read-only' },
      );
    } catch (error) {
      requestMs = Math.round(performance.now() - requestStarted);
      // retain safe sdk facts, never raw errors, connection URLs, reasons, or response bodies.
      const failure = isGatewayTransportError(error)
        ? {
            kind: error.kind,
            closeCode: error.code,
            timeoutMs: error.timeoutMs,
            requestDispatched: error.requestDispatched,
          }
        : isGatewayClientRequestError(error)
          ? {
              kind: 'request',
              code:
                Object.values(ErrorCodes).find((code) => code === error.gatewayCode) ?? 'unknown',
              retryable: error.retryable,
            }
          : { kind: 'unknown' };
      if (!observedGateway && gatewayUnavailable(error)) {
        finish('verification-skipped', failure);
        return;
      }
      const details = finish('verification-failed', failure);
      throw new AgentSystemLifecycleError(
        'agent',
        'agent-gateway-verification-failed',
        `Could not verify agent registration in the running Gateway; check Gateway connectivity and operator access, then rerun install. Registration evidence: ${details}`,
        { cause: error },
      );
    }
    requestMs = Math.round(performance.now() - requestStarted);
    observedGateway = true;
    const agents = (response as { agents?: unknown } | null)?.agents;
    if (!Array.isArray(agents) || agents.some((agent) => !agent || typeof agent.id !== 'string')) {
      const details = finish('response-invalid');
      throw new AgentSystemLifecycleError(
        'agent',
        'agent-gateway-response-invalid',
        `The Gateway returned an invalid agent list; registration visibility could not be verified. Registration evidence: ${details}`,
      );
    }
    target = agents.some((agent) => agent.id === agentId) ? 'visible' : 'absent';
    logger?.debug?.(`agent registration gateway response: ${JSON.stringify(evidence())}`);
    if (target === 'visible') {
      finish('visible');
      return;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await setTimeout(Math.min(1000, remaining));
  }
  const details = finish('registration-pending');
  throw new AgentSystemLifecycleError(
    'agent',
    'agent-gateway-registration-pending',
    `Agent registration is saved but is still absent from the running Gateway after 30 seconds; check Gateway configuration reload, then rerun install. Registration evidence: ${details}`,
  );
}
