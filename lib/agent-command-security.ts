import { isAbsolute, resolve } from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import inspectAgentCommand, {
  type AgentOperatorInvocation,
} from '../utils/inspect-agent-command.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type { Logger } from './logger.ts';

type HookApi = Pick<OpenClawPluginApi, 'on'>;
type SecurityManifestService = Pick<
  AgentManifestService,
  'loadForCommandDirectory' | 'loadForRuntimeContext'
>;

export interface AgentCommandSecurityDependencies {
  logger: Logger;
  managedExecutableDirectories: readonly string[];
  manifestService: SecurityManifestService;
}

export const agentCommandSecurityGuidance =
  'Use native agent_system_* tools for direct Agent System-managed operations. Repository helpers may invoke packaged Agent System launchers for registered command routes; OpenClaw binds those descendants to the active agent and admits only its workspace, declared local repositories, and managed worktree root. Never select another agent or directly invoke unbound openclaw agent-system tool or credentials routes through command tools. Do not access another agent workspace, manifest, environment, credentials, or identity. If neither a native capability nor a managed helper route is available, stop and ask the operator.';

interface BlockDecision {
  blockReason: string;
  code: string;
  severity: 'error' | 'warn';
  targetAgentId?: string;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function invocationTarget(
  invocations: readonly AgentOperatorInvocation[],
  activeAgentId: string,
): AgentOperatorInvocation | undefined {
  return invocations.find(
    ({ targetAgentDynamic, targetAgentId }) =>
      targetAgentDynamic || (targetAgentId !== undefined && targetAgentId !== activeAgentId),
  );
}

function operatorDecision(
  invocations: readonly AgentOperatorInvocation[],
  activeAgentId: string,
): BlockDecision | undefined {
  const crossAgent = invocationTarget(invocations, activeAgentId);
  if (crossAgent) {
    return {
      blockReason:
        'Agent System blocked an attempt to use another agent identity. Use only native agent_system_* tools bound to the active agent.',
      code: 'agent-cross-identity-blocked',
      severity: 'error',
      ...(crossAgent.targetAgentId ? { targetAgentId: crossAgent.targetAgentId } : {}),
    };
  }
  if (invocations.some(({ surface }) => surface === 'credentials')) {
    return {
      blockReason:
        'Agent System credentials are operator-only and unavailable through agent command tools.',
      code: 'agent-credentials-command-blocked',
      severity: 'error',
    };
  }

  const invocation = invocations.find(({ surface }) => surface !== 'shim');
  if (!invocation) return undefined;
  const retry = invocation.recommendedTool
    ? ` Retry this operation with ${invocation.recommendedTool} using the active agent context.`
    : ' Retry this operation with the corresponding native agent_system_* tool.';
  return {
    blockReason: `Agent System operator commands are unavailable through agent command tools.${retry}`,
    code: 'agent-operator-route-corrective',
    severity: 'warn',
  };
}

function reportBlockedCommand(
  logger: Logger,
  decision: BlockDecision,
  context: {
    agentId?: string;
    runId?: string;
    sessionId?: string;
    toolCallId?: string;
  },
  toolName: string,
): void {
  const attributes = [
    `code=${quote(decision.code)}`,
    context.agentId ? `agentId=${quote(context.agentId)}` : undefined,
    decision.targetAgentId ? `targetAgentId=${quote(decision.targetAgentId)}` : undefined,
    context.sessionId ? `sessionId=${quote(context.sessionId)}` : undefined,
    context.runId ? `runId=${quote(context.runId)}` : undefined,
    context.toolCallId ? `toolCallId=${quote(context.toolCallId)}` : undefined,
    `tool=${quote(toolName)}`,
  ].filter((value): value is string => value !== undefined);
  logger[decision.severity](`security: agent_command_blocked ${attributes.join(' ')}`);
}

/** Deny operator surfaces while allowing active-agent-bound registered command launchers. */
export default function registerAgentCommandSecurity(
  api: HookApi,
  dependencies: AgentCommandSecurityDependencies,
): void {
  api.on(
    'before_tool_call',
    async (event, context) => {
      const inspection = inspectAgentCommand(event.toolName, event.params, {
        managedExecutableDirectories: dependencies.managedExecutableDirectories,
      });
      if (inspection.status === 'irrelevant') return;
      if (!inspection.cwd && inspection.operatorInvocations.length === 0) return;

      const active = await dependencies.manifestService.loadForRuntimeContext(
        context,
        'before_tool_call',
      );
      if (active.status !== 'loaded') {
        if (inspection.operatorInvocations.length === 0) return;
        const decision: BlockDecision = {
          blockReason:
            'Agent System could not verify the active agent context for this operator command.',
          code: 'agent-command-context-unresolved',
          severity: 'error',
        };
        reportBlockedCommand(dependencies.logger, decision, context, event.toolName);
        return { block: true, blockReason: decision.blockReason };
      }

      if (inspection.cwd) {
        const commandDirectory = isAbsolute(inspection.cwd)
          ? inspection.cwd
          : resolve(active.scope.workspaceDir, inspection.cwd);
        const commandScope = await dependencies.manifestService.loadForCommandDirectory(
          commandDirectory,
          'before_tool_call',
        );
        if (
          commandScope.status === 'loaded' &&
          commandScope.manifest.agent.id !== active.manifest.agent.id
        ) {
          const decision: BlockDecision = {
            blockReason:
              'Agent System blocked command execution from another agent workspace. Use only the active agent workspace and native agent_system_* tools.',
            code: 'agent-workspace-boundary-blocked',
            severity: 'error',
            targetAgentId: commandScope.manifest.agent.id,
          };
          reportBlockedCommand(dependencies.logger, decision, context, event.toolName);
          return { block: true, blockReason: decision.blockReason };
        }
      }

      const decision = operatorDecision(inspection.operatorInvocations, active.manifest.agent.id);
      if (!decision) return;
      reportBlockedCommand(dependencies.logger, decision, context, event.toolName);
      return { block: true, blockReason: decision.blockReason };
    },
    { priority: 100 },
  );
}
