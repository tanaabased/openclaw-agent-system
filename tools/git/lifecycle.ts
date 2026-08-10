import type { AgentSystemLifecycleContribution } from '../../lib/lifecycle-registry.ts';
import resolveGitAllowedSignersFile from './allowed-signers-file.ts';
import type GitSshResourceService from './ssh-resource-service.ts';

export interface GitLifecycleDependencies {
  sshResourceService?: Pick<GitSshResourceService, 'inspectDependencies'>;
}

/** Validate the declaration-only Git identity and policy contract. */
export default function createGitLifecycleContribution(
  dependencies: GitLifecycleDependencies = {},
): AgentSystemLifecycleContribution {
  return {
    id: 'git',
    isConfigured: (manifest) => manifest.git !== undefined,
    async inspect({ manifest, workspaceDir }) {
      const authentication = Boolean(manifest.git?.ssh?.privateKeys.length);
      const signing = Boolean(manifest.git?.signing);
      if (!authentication && !signing) return [];
      const diagnostics = [];
      const allowedSignersFile = manifest.git?.signing?.allowedSignersFile;
      if (allowedSignersFile) {
        try {
          resolveGitAllowedSignersFile(allowedSignersFile, workspaceDir);
          diagnostics.push({
            code: 'git-signing-allowed-signers-ready',
            message: 'Git SSH allowed signers file is available.',
            status: 'healthy' as const,
          });
        } catch {
          diagnostics.push({
            code: 'git-signing-allowed-signers-unavailable',
            message: 'Git SSH allowed signers file is unavailable or unsafe.',
            remediation:
              'Provide a regular non-symlinked allowed signers file inside the agent workspace.',
            status: 'blocked' as const,
          });
        }
      }
      if (!dependencies.sshResourceService) {
        diagnostics.push({
          code: 'git-ssh-runtime-unavailable',
          message: 'Git SSH authentication or signing is unavailable in this runtime.',
          remediation: 'Reload Agent System with its Git SSH runtime enabled.',
          status: 'blocked' as const,
        });
        return diagnostics;
      }
      const { missing } = await dependencies.sshResourceService.inspectDependencies({
        authentication,
        signing,
      });
      const capability =
        authentication && signing
          ? 'authentication and signing'
          : authentication
            ? 'authentication'
            : 'signing';
      if (missing.length > 0) {
        diagnostics.push({
          code: 'git-ssh-dependencies-missing',
          message: `Git SSH ${capability} requires missing executables: ${missing.join(', ')}.`,
          remediation: `Install OpenSSH and make ${missing.join(', ')} available on PATH.`,
          status: 'blocked' as const,
        });
        return diagnostics;
      }
      diagnostics.push({
        code: 'git-ssh-dependencies-ready',
        message: `Git SSH ${capability} dependencies are available.`,
        status: 'healthy' as const,
      });
      return diagnostics;
    },
    validate: ({ manifest }) => {
      const diagnostics = [];
      if (manifest.git?.name === undefined && manifest.agent.name === undefined) {
        diagnostics.push({
          code: 'git-name-required',
          fieldPath: '/git/name',
          message: 'Git requires git.name or agent.name.',
          severity: 'error' as const,
        });
      }
      if (manifest.git?.email === undefined && manifest.agent.email === undefined) {
        diagnostics.push({
          code: 'git-email-required',
          fieldPath: '/git/email',
          message: 'Git requires git.email or agent.email.',
          severity: 'error' as const,
        });
      }
      if (manifest.git?.policy?.unknown === 'allow') {
        diagnostics.push({
          code: 'git-policy-unknown-allowed',
          fieldPath: '/git/policy/unknown',
          message:
            'Unknown Git operations are allowed; new or unclassified git syntax may execute.',
          severity: 'warning' as const,
        });
      }
      return {
        code: 'git-config-valid',
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
        summary: 'Git tool identity and policy configuration',
      };
    },
  };
}
