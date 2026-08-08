import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
} from '../../lib/lifecycle-registry.ts';
import type GitHubConfigStore from './config-store.ts';
import { resolveGitHubCliConfiguration } from './config-schema.ts';

export interface GitHubLifecycleDependencies {
  configStore: Pick<GitHubConfigStore, 'inspect' | 'reconcile'>;
}

/** Contribute generated GitHub CLI configuration to validation, doctor, and install. */
export default function createGitHubLifecycleContribution(
  dependencies: GitHubLifecycleDependencies,
): AgentSystemLifecycleContribution {
  return {
    id: 'github',
    isConfigured: (manifest) => manifest.github !== undefined,
    validate: () => ({
      code: 'github-config-valid',
      summary: 'GitHub tool configuration',
    }),
    async inspect({ manifest }) {
      try {
        const github = await dependencies.configStore.inspect(
          manifest.agent.id,
          resolveGitHubCliConfiguration(manifest.github ?? {}),
        );
        return [
          github.status === 'ready'
            ? {
                code: 'github-config-ready',
                message: 'Generated GitHub CLI config matches the agent manifest.',
                status: 'healthy' as const,
              }
            : {
                code: 'github-config-drift',
                message: 'Generated GitHub CLI config does not match the agent manifest.',
                remediation: 'Run openclaw agent-system install from this workspace.',
                status: 'drift' as const,
              },
        ];
      } catch (error) {
        return [
          {
            code: 'github-config-unsafe',
            message:
              error instanceof Error
                ? error.message
                : 'Generated GitHub CLI config could not be inspected.',
            remediation: 'Correct the private config path, then run openclaw agent-system install.',
            status: 'drift',
          },
        ];
      }
    },
    async reconcile({ manifest }) {
      try {
        const configuration = resolveGitHubCliConfiguration(manifest.github ?? {});
        const result = await dependencies.configStore.reconcile(manifest.agent.id, configuration);
        const verification = await dependencies.configStore.inspect(
          manifest.agent.id,
          configuration,
        );
        if (verification.status !== 'ready') {
          throw new AgentSystemLifecycleError(
            'github',
            'github-config-verification-failed',
            `GitHub CLI configuration for ${manifest.agent.id} did not match after installation.`,
          );
        }
        return {
          outcomes:
            result.status === 'created'
              ? [
                  {
                    code: 'create-github-config',
                    message: 'private GitHub CLI config',
                    status: 'created',
                  } as const,
                ]
              : result.status === 'updated'
                ? [
                    {
                      code: 'update-github-config',
                      message: 'private GitHub CLI config',
                      status: 'updated',
                    } as const,
                  ]
                : [
                    {
                      code: 'github-config-unchanged',
                      message: 'private GitHub CLI config',
                      status: 'unchanged',
                    } as const,
                  ],
        };
      } catch (error) {
        if (error instanceof AgentSystemLifecycleError) throw error;
        throw new AgentSystemLifecycleError(
          'github',
          'github-config-reconcile-failed',
          error instanceof Error
            ? error.message
            : 'Generated GitHub CLI config could not be reconciled.',
          { cause: error },
        );
      }
    },
  };
}
