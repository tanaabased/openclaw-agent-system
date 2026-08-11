import type { AgentManifest } from './manifest-types.ts';

export const agentSystemToolGrants = [
  'agent_system_git',
  'agent_system_git_worktree',
  'agent_system_github',
] as const;

export type AgentSystemToolGrant = (typeof agentSystemToolGrants)[number];
export type AgentToolAccessTarget = 'allow' | 'alsoAllow';

export type CurrentAgentToolAccessState =
  | { exists: false }
  | {
      exists: true;
      allow?: readonly string[];
      alsoAllow?: readonly string[];
    };

export type AgentToolAccessPlan =
  | { status: 'missing-agent' }
  | {
      changed: boolean;
      current: string[];
      desired: AgentSystemToolGrant[];
      missing: AgentSystemToolGrant[];
      next: string[];
      stale: AgentSystemToolGrant[];
      status: 'ready';
      target: AgentToolAccessTarget;
    };

function isAgentSystemToolGrant(value: string): value is AgentSystemToolGrant {
  return (agentSystemToolGrants as readonly string[]).includes(value);
}

function uniqueGrants(grants: readonly AgentSystemToolGrant[]): AgentSystemToolGrant[] {
  return grants.filter((grant, index) => grants.indexOf(grant) === index);
}

/** Project one manifest to the exact native Agent System tools its agent may invoke. */
export function desiredAgentSystemToolGrants(manifest: AgentManifest): AgentSystemToolGrant[] {
  return [
    ...(manifest.git === undefined ? [] : ['agent_system_git' as const]),
    ...(manifest.git?.worktrees === undefined ? [] : ['agent_system_git_worktree' as const]),
    ...(manifest.github === undefined ? [] : ['agent_system_github' as const]),
  ];
}

/** Compare manifest-derived grants with one agent's additive or exact allowlist. */
export default function planAgentToolAccess(
  manifest: AgentManifest,
  current: CurrentAgentToolAccessState,
): AgentToolAccessPlan {
  if (!current.exists) return { status: 'missing-agent' };

  const target: AgentToolAccessTarget = current.allow === undefined ? 'alsoAllow' : 'allow';
  const grants = [...(current[target] ?? [])];
  const desired = desiredAgentSystemToolGrants(manifest);
  const managed = grants.filter(isAgentSystemToolGrant);
  const missing = desired.filter((grant) => !managed.includes(grant));
  const stale = uniqueGrants(managed.filter((grant) => !desired.includes(grant)));
  const changed = managed.length !== desired.length || missing.length > 0 || stale.length > 0;

  return {
    changed,
    current: grants,
    desired,
    missing,
    next: changed
      ? [...grants.filter((grant) => !isAgentSystemToolGrant(grant)), ...desired]
      : grants,
    stale,
    status: 'ready',
    target,
  };
}
