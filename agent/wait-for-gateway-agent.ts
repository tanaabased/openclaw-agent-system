import { setTimeout } from 'node:timers/promises';

import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

import gatewayUnavailable from './automation-gateway-unavailable.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';

export default async function waitForGatewayAgent(agentId: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  let observedGateway = false;
  while (performance.now() < deadline) {
    const requestBudget = deadline - performance.now();
    // do not start a gateway request with only the deadline's fractional tail left.
    if (requestBudget < 1000) {
      if (requestBudget > 0) await setTimeout(requestBudget);
      break;
    }
    let response: unknown;
    try {
      response = await callGatewayFromCli(
        'agents.list',
        { timeout: String(Math.min(10_000, Math.floor(requestBudget))) },
        {},
        { progress: false, scopes: ['operator.read'], sharedStateMode: 'read-only' },
      );
    } catch (error) {
      if (!observedGateway && gatewayUnavailable(error)) return;
      throw new AgentSystemLifecycleError(
        'agent',
        'agent-gateway-verification-failed',
        'Could not verify agent registration in the running Gateway; check Gateway connectivity and operator access, then rerun install.',
        { cause: error },
      );
    }
    observedGateway = true;
    const agents = (response as { agents?: unknown } | null)?.agents;
    if (!Array.isArray(agents) || agents.some((agent) => !agent || typeof agent.id !== 'string'))
      throw new AgentSystemLifecycleError(
        'agent',
        'agent-gateway-response-invalid',
        'The Gateway returned an invalid agent list; registration visibility could not be verified.',
      );
    if (agents.some((agent) => agent.id === agentId)) return;
    const remaining = deadline - performance.now();
    if (remaining > 0) await setTimeout(Math.min(1000, remaining));
  }
  throw new AgentSystemLifecycleError(
    'agent',
    'agent-gateway-registration-pending',
    'Agent registration is saved but is still absent from the running Gateway after 30 seconds; check Gateway configuration reload, then rerun install.',
  );
}
