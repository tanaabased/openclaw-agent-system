import { resolve } from 'node:path';

export interface DesiredAgentInstallState {
  agentId: string;
  workspaceDir: string;
  identity: {
    name: string;
    avatar?: string;
    emoji?: string;
  };
}

export interface CurrentAgentInstallState {
  exists: boolean;
  workspaceDir?: string;
  identity?: {
    name?: string;
    avatar?: string;
    emoji?: string;
  };
}

export type AgentInstallAction = 'add-agent' | 'set-identity';

export type AgentInstallPlan =
  | {
      status: 'conflict';
      agentId: string;
      configuredWorkspaceDir?: string;
      desiredWorkspaceDir: string;
    }
  | {
      status: 'ready';
      agentId: string;
      actions: AgentInstallAction[];
      workspaceDir: string;
    };

/** Compare one manifest-owned agent with the current OpenClaw registration. */
export default function planAgentInstall(
  desired: DesiredAgentInstallState,
  current: CurrentAgentInstallState,
): AgentInstallPlan {
  const workspaceDir = resolve(desired.workspaceDir);
  if (
    current.exists &&
    (current.workspaceDir === undefined || resolve(current.workspaceDir) !== workspaceDir)
  ) {
    return {
      status: 'conflict',
      agentId: desired.agentId,
      configuredWorkspaceDir: current.workspaceDir,
      desiredWorkspaceDir: workspaceDir,
    };
  }

  const actions: AgentInstallAction[] = [];
  if (!current.exists) actions.push('add-agent');

  const identityDiffers =
    !current.exists ||
    current.identity?.name !== desired.identity.name ||
    (desired.identity.avatar !== undefined &&
      current.identity?.avatar !== desired.identity.avatar) ||
    (desired.identity.emoji !== undefined && current.identity?.emoji !== desired.identity.emoji);
  if (identityDiffers) actions.push('set-identity');

  return {
    status: 'ready',
    agentId: desired.agentId,
    actions,
    workspaceDir,
  };
}
