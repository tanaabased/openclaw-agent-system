import { resolveAgentConfig } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { AgentSystemLifecycleContribution } from '../core/lifecycle-registry.ts';

export interface ToolSecurityLifecycleDependencies {
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

interface CommandIsolationPosture {
  contained: boolean;
  reasons: string[];
}

function inspectCommandIsolation(config: OpenClawConfig, agentId: string): CommandIsolationPosture {
  const agent = resolveAgentConfig(config, agentId);
  const globalTools = config.tools;
  const agentTools = agent?.tools;
  const exec = { ...globalTools?.exec, ...agentTools?.exec };
  const sandbox = agent?.sandbox ?? config.agents?.defaults?.sandbox;
  const sandboxMode = sandbox?.mode ?? 'off';
  const sandboxScope = sandbox?.scope ?? 'agent';
  const execHost = exec.host ?? 'auto';
  const execDenied = exec.mode === 'deny' || (exec.mode === undefined && exec.security === 'deny');
  const elevatedEnabled =
    globalTools?.elevated?.enabled !== false && agentTools?.elevated?.enabled !== false;
  const sandboxOnly =
    sandboxScope !== 'shared' &&
    (execHost === 'sandbox' || (execHost === 'auto' && sandboxMode === 'all'));
  const reasons: string[] = [];

  if (!execDenied && !sandboxOnly) {
    if (execHost === 'gateway') reasons.push('exec targets the Gateway host');
    else if (execHost === 'node') reasons.push('exec targets an external node');
    else if (sandboxScope === 'shared') reasons.push('sandbox scope is shared across agents');
    else reasons.push(`sandbox mode ${sandboxMode} lets exec fall back to the Gateway host`);
  }
  if (elevatedEnabled) reasons.push('elevated host execution is enabled');

  return { contained: reasons.length === 0, reasons };
}

/** Report whether managed tools coexist with command paths that can reach operator surfaces. */
export default function createToolSecurityLifecycleContribution(
  dependencies: ToolSecurityLifecycleDependencies,
): AgentSystemLifecycleContribution {
  return {
    id: 'security',
    isConfigured: (manifest) => manifest.git !== undefined || manifest.github !== undefined,
    async inspect(context) {
      const posture = inspectCommandIsolation(
        await dependencies.readConfig(),
        context.manifest.agent.id,
      );
      if (posture.contained) {
        return [
          {
            code: 'agent-command-posture-contained',
            message:
              'Normal command routing is sandbox-only or denied, and elevated execution is disabled.',
            status: 'healthy',
          },
        ];
      }
      return [
        {
          code: 'agent-operator-boundary-exposed',
          message: `This agent may reach Agent System operator command surfaces: ${posture.reasons.join('; ')}.`,
          remediation:
            'Use native agent_system_* tools for agent work and restrict generic command execution with agent- or session-scoped sandboxing or a deny policy.',
          status: 'warning',
        },
      ];
    },
  };
}
