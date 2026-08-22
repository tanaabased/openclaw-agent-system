import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleOutcome,
} from '../../core/lifecycle-registry.ts';
import type GitHubConfigStore from './config-store.ts';
import { resolveGitHubCliConfiguration } from './config-schema.ts';
import { validateGitHubAccountKeyDeclarations } from './account-key-declarations.ts';
import GitHubAccountKeyError from './account-key-error.ts';
import type GitHubAccountKeyService from './account-key-service.ts';

export interface GitHubLifecycleDependencies {
  accountKeyService?: Pick<GitHubAccountKeyService, 'inspect' | 'reconcile'>;
  configStore: Pick<GitHubConfigStore, 'inspect' | 'reconcile'>;
}

function hasAccountKeys(manifest: Parameters<AgentSystemLifecycleContribution['isConfigured']>[0]) {
  return Boolean(manifest.github?.sshKeys || manifest.github?.sshSigningKeys);
}

function categoryLabel(category: 'ssh' | 'ssh-signing'): string {
  return category === 'ssh' ? 'SSH authentication' : 'SSH signing';
}

/** Contribute generated GitHub CLI configuration to validation, doctor, and install. */
export default function createGitHubLifecycleContribution(
  dependencies: GitHubLifecycleDependencies,
): AgentSystemLifecycleContribution {
  return {
    id: 'github',
    isConfigured: (manifest) => manifest.github !== undefined,
    validate: ({ manifest }) => {
      const diagnostics = validateGitHubAccountKeyDeclarations(manifest.github ?? {});
      return {
        code: 'github-config-valid',
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
        summary: hasAccountKeys(manifest)
          ? 'GitHub tool and account key configuration'
          : 'GitHub tool configuration',
      };
    },
    async inspect(context) {
      const { manifest } = context;
      const findings = [];
      let configReady = false;
      try {
        const github = await dependencies.configStore.inspect(
          manifest.agent.id,
          resolveGitHubCliConfiguration(manifest.github ?? {}),
        );
        configReady = github.status === 'ready';
        findings.push(
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
        );
      } catch (error) {
        findings.push({
          code: 'github-config-unsafe',
          message:
            error instanceof Error
              ? error.message
              : 'Generated GitHub CLI config could not be inspected.',
          remediation: 'Correct the private config path, then run openclaw agent-system install.',
          status: 'drift',
        } as const);
      }

      if (!hasAccountKeys(manifest)) return findings;
      if (!configReady) {
        findings.push({
          code: 'github-account-keys-blocked',
          message: 'GitHub account keys cannot be inspected until the private CLI config is ready.',
          remediation: 'Run openclaw agent-system install from this workspace.',
          status: 'blocked' as const,
        });
        return findings;
      }

      try {
        const accountKeyService = dependencies.accountKeyService;
        if (!accountKeyService) {
          throw new GitHubAccountKeyError(
            'github-account-key-service-unavailable',
            'GitHub account key inspection is unavailable in this runtime.',
          );
        }
        const inspections = await accountKeyService.inspect(context);
        findings.push(
          ...inspections.map((inspection) =>
            inspection.status === 'ready'
              ? {
                  code: `github-${inspection.category}-keys-ready`,
                  message: `GitHub ${categoryLabel(inspection.category)} keys match the manifest (${inspection.declared} declared).`,
                  status: 'healthy' as const,
                }
              : {
                  code: `github-${inspection.category}-keys-drift`,
                  message: `GitHub ${categoryLabel(inspection.category)} keys are missing: ${inspection.missingFingerprints.join(', ')}.`,
                  remediation: 'Run openclaw agent-system install from this workspace.',
                  status: 'drift' as const,
                },
          ),
        );
      } catch (error) {
        findings.push({
          code:
            error instanceof GitHubAccountKeyError
              ? error.code
              : 'github-account-key-inspection-failed',
          message:
            error instanceof Error ? error.message : 'GitHub account keys could not be inspected.',
          remediation: 'Correct the GitHub key declaration or account access, then run install.',
          status: 'blocked' as const,
        });
      }
      return findings;
    },
    async reconcile(context) {
      const { manifest } = context;
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
        const outcomes: Array<Omit<AgentSystemLifecycleOutcome, 'component'>> =
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
                ];

        if (hasAccountKeys(manifest)) {
          const accountKeyService = dependencies.accountKeyService;
          if (!accountKeyService) {
            throw new GitHubAccountKeyError(
              'github-account-key-service-unavailable',
              'GitHub account key installation is unavailable in this runtime.',
            );
          }
          const reconciliations = await accountKeyService.reconcile(context);
          outcomes.push(
            ...reconciliations.map((reconciliation) => ({
              code:
                reconciliation.created > 0
                  ? `add-github-${reconciliation.category}-keys`
                  : `github-${reconciliation.category}-keys-unchanged`,
              message: `${reconciliation.declared} GitHub ${categoryLabel(reconciliation.category)} ${reconciliation.declared === 1 ? 'key' : 'keys'}`,
              status: reconciliation.created > 0 ? ('created' as const) : ('unchanged' as const),
            })),
          );
        }
        return { outcomes };
      } catch (error) {
        if (error instanceof AgentSystemLifecycleError) throw error;
        if (error instanceof GitHubAccountKeyError) {
          throw new AgentSystemLifecycleError('github', error.code, error.message, {
            cause: error,
          });
        }
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
