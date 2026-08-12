import type {
  AgentSystemAuthorizationDecision,
  AgentSystemOperation,
} from '../../lib/tool-types.ts';
import { resolveGitPolicyConfiguration, type GitToolConfiguration } from './config-schema.ts';
import { gitOperationProtections, type GitProtectedOperation } from './operation-classifier.ts';

export interface GitAuthorizationDependencies {
  extensionAvailable?(name: string): Promise<boolean> | boolean;
}

const policyFields: Record<GitProtectedOperation, string> = {
  deleteRemoteRef: 'delete-remote-ref',
  forcePush: 'force-push',
};

function policyReference(protection: GitProtectedOperation): string {
  return `git.policy.${policyFields[protection]}`;
}

function protectionLabel(protections: readonly GitProtectedOperation[]): string {
  return protections.map((protection) => policyFields[protection]).join(' and ');
}

function policyRemediation(references: readonly string[]): string {
  const fields = references.length === 1 ? references[0] : `each of ${references.join(' and ')}`;
  return `To permit this operation, an operator must set ${fields} to allow in agent.yaml and retry.`;
}

/** Apply explicit Git protections after semantic operation classification. */
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
  if (operation.risk === 'unknown') {
    return {
      status: 'denied',
      reason:
        typeof extension === 'string'
          ? `Git command ${extension} is not a supported built-in command or declared external helper. An operator must declare git.extensions.${extension} as allow before retrying.`
          : 'The Git operation is not recognized and cannot be authorized.',
    };
  }
  if (operation.risk !== 'destructive') {
    return { status: 'denied', reason: 'The Git operation cannot be authorized.' };
  }
  const protections = gitOperationProtections(operation);
  if (protections.length === 0) {
    return {
      status: 'denied',
      reason: 'The protected Git operation is missing its required policy selector.',
    };
  }
  const policy = resolveGitPolicyConfiguration(configuration.git);
  const denied = protections.filter((protection) => policy[protection] === 'deny');
  if (denied.length > 0) {
    const references = denied.map(policyReference);
    return {
      status: 'denied',
      reason: `Git ${protectionLabel(denied)} operations are denied by ${references.join(' and ')}. ${policyRemediation(references)}`,
    };
  }
  return { status: 'allowed' };
}
