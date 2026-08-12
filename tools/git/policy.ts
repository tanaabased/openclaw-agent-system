import type {
  AgentSystemAuthorizationDecision,
  AgentSystemOperation,
} from '../../lib/tool-types.ts';
import { resolveGitPolicyConfiguration, type GitToolConfiguration } from './config-schema.ts';
import { gitOperationHazards, type GitPolicyHazard } from './operation-classifier.ts';

export interface GitAuthorizationDependencies {
  extensionAvailable?(name: string): Promise<boolean> | boolean;
}

function policyReferences(hazards: readonly (GitPolicyHazard | 'unknown')[]): string {
  return hazards.map((hazard) => `git.policy.${hazard}`).join(' and ');
}

function hazardLabel(hazards: readonly (GitPolicyHazard | 'unknown')[]): string {
  return hazards.join(' and ');
}

function policyRemediation(references: readonly string[]): string {
  const fields = references.length === 1 ? references[0] : `each of ${references.join(' and ')}`;
  return `To permit this operation, an operator must set ${fields} to allow in agent.yaml and retry.`;
}

/** Apply the manifest's Git-specific hazard policy after classification. */
export async function authorizeGitOperation(
  operation: AgentSystemOperation,
  configuration: GitToolConfiguration,
  dependencies: GitAuthorizationDependencies = {},
): Promise<AgentSystemAuthorizationDecision> {
  if (operation.risk === 'read' || operation.risk === 'write') return { status: 'allowed' };
  const extension = operation.attributes?.['git.extension'];
  if (
    operation.risk === 'unknown' &&
    typeof extension === 'string' &&
    Object.hasOwn(configuration.git.extensions ?? {}, extension)
  ) {
    const decision = configuration.git.extensions?.[extension] ?? 'deny';
    if (decision === 'deny') {
      const reference = `git.extensions.${extension}`;
      return {
        status: 'denied',
        reason: `Git extension ${extension} is denied by ${reference}. ${policyRemediation([reference])}`,
      };
    }
    if (!(await dependencies.extensionAvailable?.(extension))) {
      return {
        status: 'denied',
        reason: `Git extension ${extension} is unavailable as an external git-${extension} executable. An operator must install that executable on the trusted tool PATH before retrying.`,
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
    const references = denied.map((hazard) => `git.policy.${hazard}`);
    return {
      status: 'denied',
      reason: `Git ${hazardLabel(denied)} operations are denied by ${policyReferences(denied)}. ${policyRemediation(references)}`,
    };
  }
  return { status: 'allowed' };
}
