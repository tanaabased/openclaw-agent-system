import type { OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry';

import {
  buildEnableGatewayExecCommand,
  createExecEnvironmentProbe,
  parseExecEnvironmentProbeResult,
  type ObservedExecEnvironmentVariable,
} from '../utils/exec-env-probe.ts';
import type { AgentEnvironmentVariable } from '../utils/resolve-agent-environment.ts';

export type AgentExecProbeResult =
  | {
      status: 'completed';
      variables: ObservedExecEnvironmentVariable[];
    }
  | {
      status: 'disabled';
      code: 'exec-probe-disabled';
      enableCommand: string;
    }
  | {
      status: 'failed';
      code: 'exec-probe-approval-required' | 'exec-probe-failed' | 'gateway-unavailable';
      message: string;
    };

export interface AgentExecProbeServiceDependencies {
  callGateway(method: string, params: unknown): Promise<Record<string, unknown>>;
  logger: {
    info(message: string): void;
    warn(message: string): void;
  };
  nodePath?: string;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedGatewayResponse(
  response: Record<string, unknown>,
): Extract<AgentExecProbeResult, { status: 'failed' }> | undefined {
  if (response.ok !== false) return undefined;
  const error =
    response.error && typeof response.error === 'object'
      ? (response.error as Record<string, unknown>)
      : {};
  const message = typeof error.message === 'string' ? error.message : 'Gateway exec probe failed.';
  if (response.requiresApproval === true || error.code === 'requires_approval') {
    return { status: 'failed', code: 'exec-probe-approval-required', message };
  }
  return { status: 'failed', code: 'exec-probe-failed', message };
}

function failedToolOutput(
  response: Record<string, unknown>,
): Extract<AgentExecProbeResult, { status: 'failed' }> | undefined {
  const output =
    response.output && typeof response.output === 'object'
      ? (response.output as Record<string, unknown>)
      : undefined;
  const details =
    output?.details && typeof output.details === 'object'
      ? (output.details as Record<string, unknown>)
      : undefined;
  const status = details?.status;
  if (status === 'approval-pending' || status === 'approval-unavailable') {
    return {
      status: 'failed',
      code: 'exec-probe-approval-required',
      message: 'OpenClaw exec approval is required before the probe can run.',
    };
  }
  if (status === 'failed') {
    return {
      status: 'failed',
      code: 'exec-probe-failed',
      message: 'The Gateway exec probe process failed.',
    };
  }
  return undefined;
}

/** Observe OpenClaw's active exec filter using value-free, one-time sentinels. */
export default class AgentExecProbeService {
  readonly #dependencies: AgentExecProbeServiceDependencies;

  constructor(dependencies: AgentExecProbeServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async probe(
    agentId: string,
    variables: AgentEnvironmentVariable[],
  ): Promise<AgentExecProbeResult> {
    let config: OpenClawConfig;
    try {
      config = await this.#dependencies.readConfig();
    } catch {
      this.#dependencies.logger.warn(
        `agent_system.exec_environment_probe_failed agentId=${quote(agentId)} stage=${quote('config')}`,
      );
      return {
        status: 'failed',
        code: 'exec-probe-failed',
        message: 'The current OpenClaw configuration could not be read.',
      };
    }
    const allow = config.gateway?.tools?.allow ?? [];
    if (!allow.includes('exec')) {
      return {
        status: 'disabled',
        code: 'exec-probe-disabled',
        enableCommand: buildEnableGatewayExecCommand(allow),
      };
    }

    const probe = createExecEnvironmentProbe(agentId, variables, {
      nodePath: this.#dependencies.nodePath,
    });
    try {
      const response = await this.#dependencies.callGateway('tools.invoke', {
        name: 'exec',
        agentId,
        sessionKey: probe.sessionKey,
        idempotencyKey: probe.idempotencyKey,
        args: { command: probe.command, host: 'gateway' },
      });
      const failed = failedGatewayResponse(response);
      if (failed) return failed;
      const failedOutput = failedToolOutput(response);
      if (failedOutput) return failedOutput;
      const variablesWithDelivery = parseExecEnvironmentProbeResult(response, probe);
      this.#dependencies.logger.info(
        `agent_system.exec_environment_probed agentId=${quote(agentId)} variables=${variablesWithDelivery.length} accepted=${variablesWithDelivery.filter(({ observedExecDelivery }) => observedExecDelivery === 'accepted').length} filtered=${variablesWithDelivery.filter(({ observedExecDelivery }) => observedExecDelivery === 'filtered').length}`,
      );
      return { status: 'completed', variables: variablesWithDelivery };
    } catch (error) {
      const message = errorMessage(error);
      this.#dependencies.logger.warn(
        `agent_system.exec_environment_probe_failed agentId=${quote(agentId)}`,
      );
      if (/approval|requires_approval/i.test(message)) {
        return { status: 'failed', code: 'exec-probe-approval-required', message };
      }
      if (/connect|ECONNREFUSED|gateway.*(offline|unavailable)|timeout/i.test(message)) {
        return { status: 'failed', code: 'gateway-unavailable', message };
      }
      return { status: 'failed', code: 'exec-probe-failed', message };
    }
  }
}
