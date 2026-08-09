import type { AgentSystemLifecycleContribution } from '../../lib/lifecycle-registry.ts';

/** Validate the declaration-only Git identity and policy contract. */
export default function createGitLifecycleContribution(): AgentSystemLifecycleContribution {
  return {
    id: 'git',
    isConfigured: (manifest) => manifest.git !== undefined,
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
