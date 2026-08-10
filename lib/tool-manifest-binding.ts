import { resolve } from 'node:path';

import type AgentManifestService from './agent-manifest-service.ts';
import type { AgentManifestLoadResult } from './agent-manifest-service.ts';
import AgentSystemToolError from './tool-error.ts';
import type { AgentSystemToolScope } from './tool-types.ts';

type LoadedAgentManifest = Extract<AgentManifestLoadResult, { status: 'loaded' }>;

/**
 * Load an agent manifest that is exactly bound to the authoritative tool scope.
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
      resolve(result.scope.workspaceDir) !== resolve(workspaceDir)
    ) {
      throw new AgentSystemToolError(
        'agent_not_resolved',
        'Agent System could not bind the active OpenClaw agent to this workspace.',
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
