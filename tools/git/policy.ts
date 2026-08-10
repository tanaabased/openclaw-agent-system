import type {
  AgentSystemAuthorizationDecision,
  AgentSystemOperation,
} from '../../lib/tool-types.ts';
import { resolveGitPolicyConfiguration, type GitToolConfiguration } from './config-schema.ts';
import {
  gitOperationHazards,
  isRawGitWorktreeMutationOperation,
  type GitPolicyHazard,
} from './operation-classifier.ts';

export interface GitAuthorizationDependencies {
  extensionAvailable?(name: string): Promise<boolean> | boolean;
}

function policyReferences(hazards: readonly (GitPolicyHazard | 'unknown')[]): string {
  return hazards.map((hazard) => `git.policy.${hazard}`).join(' and ');
}

function hazardLabel(hazards: readonly (GitPolicyHazard | 'unknown')[]): string {
  return hazards.join(' and ');
}

/** Apply the manifest's Git-specific hazard policy after classification. */
export async function authorizeGitOperation(
  operation: AgentSystemOperation,
  configuration: GitToolConfiguration,
  dependencies: GitAuthorizationDependencies = {},
): Promise<AgentSystemAuthorizationDecision> {
  if (isRawGitWorktreeMutationOperation(operation)) {
    return {
      status: 'denied',
      reason:
        'Raw Git worktree mutation is unavailable; use agent_system_git_worktree for managed lifecycle changes.',
    };
  }
  if (operation.risk === 'read' || operation.risk === 'write') return { status: 'allowed' };
  const extension = operation.attributes?.['git.extension'];
  if (
    operation.risk === 'unknown' &&
    typeof extension === 'string' &&
    Object.hasOwn(configuration.git.extensions ?? {}, extension)
  ) {
    const decision = configuration.git.extensions?.[extension] ?? 'deny';
    if (decision === 'deny') {
      return {
        status: 'denied',
        reason: `Git extension ${extension} is denied by git.extensions.${extension}.`,
      };
    }
    if (!(await dependencies.extensionAvailable?.(extension))) {
      return {
        status: 'denied',
        reason: `Git extension ${extension} is unavailable as an external git-${extension} executable.`,
      };
    }
    if (decision === 'ask') {
      return {
        status: 'approval_required',
        reason: `Git extension ${extension} requires approval in an OpenClaw agent conversation; direct tool commands cannot request approval.`,
        request: {
          description: `Allow the active agent to ${operation.summary.toLowerCase()}?`,
          severity: 'warning',
          title: `Approve Git extension ${extension}`,
        },
      };
    }
    return { status: 'allowed' };
  }
  const policy = resolveGitPolicyConfiguration(configuration.git);
  const hazards: Array<GitPolicyHazard | 'unknown'> =
    operation.risk === 'destructive' ? gitOperationHazards(operation) : ['unknown'];
  if (hazards.length === 0) hazards.push('unknown');
  const denied = hazards.filter((hazard) => policy[hazard] === 'deny');
  if (denied.length > 0) {
    return {
      status: 'denied',
      reason: `Git ${hazardLabel(denied)} operations are denied by ${policyReferences(denied)}.`,
    };
  }
  const approvals = hazards.filter((hazard) => policy[hazard] === 'ask');
  if (approvals.length > 0) {
    return {
      status: 'approval_required',
      reason: `Git ${hazardLabel(approvals)} operations require approval in an OpenClaw agent conversation; direct tool commands cannot request approval.`,
      request: {
        description: `Allow the active agent to ${operation.summary.toLowerCase()}?`,
        severity: approvals.includes('unknown') ? 'warning' : 'critical',
        title: `Approve ${hazardLabel(approvals)} Git operation`,
      },
    };
  }
  return { status: 'allowed' };
}
