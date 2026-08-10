import type { AgentSystemLifecycleContribution } from '../../lib/lifecycle-registry.ts';
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
    async inspect({ manifest }) {
      if (!manifest.git?.ssh?.privateKeys.length) return [];
      if (!dependencies.sshResourceService) {
        return [
          {
            code: 'git-ssh-runtime-unavailable',
            message: 'Git SSH authentication is unavailable in this runtime.',
            remediation: 'Reload Agent System with its Git SSH runtime enabled.',
            status: 'blocked',
          },
        ];
      }
      const { missing } = await dependencies.sshResourceService.inspectDependencies();
      if (missing.length > 0) {
        return [
          {
            code: 'git-ssh-dependencies-missing',
            message: `Git SSH authentication requires missing executables: ${missing.join(', ')}.`,
            remediation: 'Install OpenSSH and make ssh, ssh-agent, and ssh-add available on PATH.',
            status: 'blocked',
          },
        ];
      }
      return [
        {
          code: 'git-ssh-dependencies-ready',
          message: 'Git SSH authentication dependencies are available.',
          status: 'healthy',
        },
      ];
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
