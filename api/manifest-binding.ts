import { resolve } from 'node:path';

import type AgentManifestService from '../manifest/service.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import AgentSystemToolError from './error.ts';
import type { AgentSystemToolScope } from './types.ts';
import isManagedWorktreeWorkspace from '../tools/git/worktree-workspace.ts';
import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';

type LoadedAgentManifest = Extract<AgentManifestLoadResult, { status: 'loaded' }>;

/**
 * load canonical agent configuration while validating the host's execution workspace.
 *
 * @throws {AgentSystemToolError} When agent identity or workspace ownership cannot be proven.
 */
export default async function loadBoundToolManifest(
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>,
  scope: AgentSystemToolScope,
): Promise<LoadedAgentManifest> {
  if (scope.source === 'tool') {
    const agentId = scope.toolContext?.agentId?.trim();
    const workspaceDir = scope.toolContext?.workspaceDir;
    if (!agentId || !workspaceDir) {
      throw new AgentSystemToolError(
        'agent_not_resolved',
        'Agent System could not resolve the active OpenClaw agent.',
      );
    }
    const result = await manifestService.loadForAgentId(agentId, 'cli');
    if (
      result.status !== 'loaded' ||
      result.manifest.agent.id !== agentId ||
      (resolve(result.scope.workspaceDir) !== resolve(workspaceDir) &&
        (!scope.toolContext?.sessionId ||
          parseAgentSessionKey(scope.toolContext.sessionKey ?? '')?.agentId !== agentId ||
          !(await isManagedWorktreeWorkspace(
            result.scope.workspaceDir,
            result.manifest.git?.worktrees,
            workspaceDir,
          ))))
    ) {
      throw new AgentSystemToolError(
        'agent_not_resolved',
        'Agent System could not bind the active OpenClaw agent to this workspace.',
      );
    }
    return result;
  }

  if (scope.source === 'agent-command') {
    const agentId = scope.agentId?.trim();
    if (!agentId || !scope.workspaceDir) {
      throw new AgentSystemToolError(
        'agent_not_resolved',
        'Agent System could not resolve the active agent command context.',
      );
    }
    const result = await manifestService.loadForAgentId(agentId, 'cli');
    if (result.status !== 'loaded' || result.manifest.agent.id !== agentId) {
      throw new AgentSystemToolError(
        'agent_not_resolved',
        'Agent System could not bind the active agent command context.',
      );
    }
    return result;
  }

  if (scope.agentId) {
    const result = await manifestService.loadForAgentId(scope.agentId, 'cli');
    if (result.status !== 'loaded' || result.manifest.agent.id !== scope.agentId) {
      throw new AgentSystemToolError(
        'agent_not_resolved',
        `Agent System could not resolve OpenClaw agent ${scope.agentId}.`,
      );
    }
    return result;
  }

  if (!scope.workspaceDir) {
    throw new AgentSystemToolError(
      'agent_not_resolved',
      'Agent System could not resolve the tool command workspace.',
    );
  }
  const discovered = await manifestService.loadForCommandDirectory(scope.workspaceDir, 'cli');
  if (discovered.status !== 'loaded') {
    throw new AgentSystemToolError(
      'agent_not_resolved',
      'Agent System could not resolve an agent manifest for this tool command.',
    );
  }
  const result = await manifestService.loadForAgentId(discovered.manifest.agent.id, 'cli');
  if (
    result.status !== 'loaded' ||
    resolve(result.scope.workspaceDir) !== resolve(discovered.scope.workspaceDir)
  ) {
    throw new AgentSystemToolError(
      'agent_not_resolved',
      'Agent System could not bind this tool command workspace to its OpenClaw agent.',
    );
  }
  return result;
}
