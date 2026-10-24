import { setTimeout } from 'node:timers/promises';

import {
  callGatewayFromCli,
  ErrorCodes,
  isGatewayClientRequestError,
  isGatewayTransportError,
} from 'openclaw/plugin-sdk/gateway-runtime';

import gatewayUnavailable from './automation-gateway-unavailable.ts';
import gatewayAgentReapply from './gateway-agent-reapply.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import type { Logger } from '../core/logger.ts';

type Dependencies = {
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  now(): number;
  sleep(ms: number): Promise<unknown>;
};

const nativeDependencies: Dependencies = {
  request: (method, params, timeoutMs) =>
    callGatewayFromCli(method, { timeout: String(timeoutMs) }, params, {
      progress: false,
      scopes: [method === 'config.apply' ? 'operator.admin' : 'operator.read'],
      ...(method === 'config.apply' ? {} : { sharedStateMode: 'read-only' as const }),
    }),
  now: () => performance.now(),
  sleep: setTimeout,
};

/** Installation may reapply one saved revision; success still requires native agent visibility. */
export default async function waitForGatewayAgent(
  agentId: string,
  logger?: Pick<Logger, 'debug' | 'info'>,
  dependencies: Dependencies = nativeDependencies,
): Promise<void> {
  const { request, now, sleep } = dependencies;
  const started = now();
  const deadline = started + 30_000;
  let observedGateway = false;
  let target: 'unverified' | 'absent' | 'visible' = 'unverified';
  let attempts = 0;
  let requestMs = 0;
  let reapply = 'not-needed';
  let method = 'agents.list';
  const evidence = () => ({
    agentId,
    config: 'verified',
    lastGatewayObservation: observedGateway ? 'reachable' : 'unverified',
    target,
    attempts,
    reapply,
    method,
    elapsedMs: Math.round(now() - started),
    lastRequestMs: requestMs,
  });
  const finish = (outcome: string, failure?: Record<string, unknown>) => {
    const details = JSON.stringify({ ...evidence(), ...(failure ? { failure } : {}) });
    logger?.info(`agent registration ${outcome}: ${details}`);
    return details;
  };
  logger?.debug?.(`agent registration visibility started: ${JSON.stringify(evidence())}`);
  while (now() < deadline) {
    const requestBudget = deadline - now();
    // do not start a gateway request with only the deadline's fractional tail left.
    if (requestBudget < 1000) {
      if (requestBudget > 0) await sleep(requestBudget);
      break;
    }
    const timeoutMs = Math.floor(requestBudget);
    const requestStarted = now();
    method = target === 'absent' && reapply === 'not-needed' ? 'config.get' : 'agents.list';
    attempts += 1;
    logger?.debug?.(
      `agent registration gateway request: ${JSON.stringify({ ...evidence(), timeoutMs })}`,
    );
    let response: unknown;
    try {
      if (method === 'config.get') {
        const prepared = gatewayAgentReapply(agentId, await request(method, {}, timeoutMs));
        reapply = prepared.status;
        if (prepared.status === 'prepared') {
          const applyBudget = Math.floor(deadline - now());
          if (applyBudget < 1000) {
            reapply = 'deadline-exhausted';
            continue;
          }
          method = 'config.apply';
          reapply = 'requested';
          const applied = await request(method, prepared.params, applyBudget);
          if ((applied as { ok?: unknown } | null)?.ok !== true)
            throw new Error('invalid configuration application response');
          reapply = 'acknowledged';
        }
        requestMs = Math.round(now() - requestStarted);
        continue;
      }
      response = await request(method, {}, timeoutMs);
    } catch (error) {
      requestMs = Math.round(now() - requestStarted);
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
      if (
        !observedGateway &&
        isGatewayTransportError(error) &&
        error.kind === 'closed' &&
        error.code === undefined &&
        error.requestDispatched === undefined &&
        gatewayUnavailable(error)
      ) {
        finish('verification-skipped', failure);
        return;
      }
      const retryableRead =
        method !== 'config.apply' &&
        ((isGatewayTransportError(error) &&
          (error.kind === 'timeout' || [1006, 1012].includes(error.code ?? 0))) ||
          (isGatewayClientRequestError(error) &&
            error.gatewayCode === ErrorCodes.UNAVAILABLE &&
            error.retryable === true));
      if (retryableRead) {
        const remaining = deadline - now();
        if (remaining > 0) await sleep(Math.min(1000, remaining));
        continue;
      }
      const details = finish('verification-failed', failure);
      throw new AgentSystemLifecycleError(
        'agent',
        'agent-gateway-verification-failed',
        `Could not verify agent registration in the running Gateway; check Gateway connectivity and operator access, then rerun install. Registration evidence: ${details}`,
        { cause: error },
      );
    }
    requestMs = Math.round(now() - requestStarted);
    if (now() >= deadline) break;
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
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(1000, remaining));
  }
  const details = finish('registration-pending');
  throw new AgentSystemLifecycleError(
    'agent',
    'agent-gateway-registration-pending',
    `Agent registration is saved but could not be confirmed in the running Gateway within 30 seconds; check Gateway configuration reload, then rerun install. Registration evidence: ${details}`,
  );
}
