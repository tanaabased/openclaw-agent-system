import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
} from '../../core/lifecycle-registry.ts';
import resolveGitAllowedSignersFile from './allowed-signers-file.ts';
import type GitSshResourceService from './ssh-resource-service.ts';
import type GitWorktreeLayoutService from './worktree-layout-service.ts';

export interface GitLifecycleDependencies {
  sshResourceService?: Pick<GitSshResourceService, 'inspectDependencies'>;
  worktreeLayoutService?: Pick<GitWorktreeLayoutService, 'inspect' | 'reconcile'>;
}

/** Validate and reconcile the declared Git identity, SSH, and worktree contract. */
export default function createGitLifecycleContribution(
  dependencies: GitLifecycleDependencies = {},
): AgentSystemLifecycleContribution {
  return {
    id: 'git',
    isConfigured: (manifest) => manifest.git !== undefined,
    async inspect({ manifest, workspaceDir }) {
      const diagnostics = [];
      if (manifest.git?.worktrees) {
        if (!dependencies.worktreeLayoutService) {
          diagnostics.push({
            code: 'git-worktrees-runtime-unavailable',
            message: 'Git worktree lifecycle management is unavailable in this runtime.',
            remediation: 'Reload Agent System with its Git worktree runtime enabled.',
            status: 'blocked' as const,
          });
        } else {
          const inspection = await dependencies.worktreeLayoutService.inspect(
            workspaceDir,
            manifest.git.worktrees,
          );
          for (const [kind, status] of [
            ['repositories', inspection.repositoryRoot],
            ['worktrees', inspection.worktreeRoot],
          ] as const) {
            diagnostics.push(
              status === 'ready'
                ? {
                    code: `git-${kind}-root-ready`,
                    message: `Git managed ${kind} root is ready.`,
                    status: 'healthy' as const,
                  }
                : {
                    code: `git-${kind}-root-${status}`,
                    message: `Git managed ${kind} root is ${status}.`,
                    remediation: 'Run openclaw agent-system install from this workspace.',
                    status: status === 'unsafe' ? ('blocked' as const) : ('drift' as const),
                  },
            );
          }
          diagnostics.push(
            inspection.gitignored
              ? {
                  code: 'git-worktree-roots-gitignored',
                  message: 'Git managed repository and worktree roots are ignored.',
                  status: 'healthy' as const,
                }
              : {
                  code: 'git-worktree-roots-not-gitignored',
                  message: 'Git managed repository or worktree roots are not ignored.',
                  remediation: 'Run openclaw agent-system install from this workspace.',
                  status: 'drift' as const,
                },
          );
          if (inspection.tracked) {
            diagnostics.push({
              code: 'git-worktree-roots-tracked',
              message: 'Git managed repository or worktree roots contain tracked workspace paths.',
              remediation:
                'Remove managed repository and worktree paths from version control before installing.',
              status: 'blocked' as const,
            });
          }
          for (const [id, status] of Object.entries(inspection.localRepositories)) {
            diagnostics.push(
              status === 'ready'
                ? {
                    code: 'git-worktree-local-repository-ready',
                    message: `Git local repository override ${id} is ready.`,
                    status: 'healthy' as const,
                  }
                : {
                    code: `git-worktree-local-repository-${status}`,
                    message: `Git local repository override ${id} is ${status}.`,
                    remediation: 'Correct the local repository path, then run install.',
                    status: status === 'unsafe' ? ('blocked' as const) : ('drift' as const),
                  },
            );
          }
        }
      }

      const authentication = Boolean(manifest.git?.ssh?.privateKeys.length);
      const signing = Boolean(manifest.git?.signing);
      if (!authentication && !signing) return diagnostics;
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
    async reconcile({ manifest, workspaceDir }) {
      if (!manifest.git?.worktrees) return { outcomes: [] };
      if (!dependencies.worktreeLayoutService) {
        throw new AgentSystemLifecycleError(
          'git',
          'git-worktrees-runtime-unavailable',
          'Git worktree lifecycle management is unavailable in this runtime.',
        );
      }
      try {
        const result = await dependencies.worktreeLayoutService.reconcile(
          workspaceDir,
          manifest.git.worktrees,
        );
        return {
          outcomes:
            result.actions.length === 0
              ? [
                  {
                    code: 'git-worktrees-unchanged',
                    message: 'Git worktree managed roots',
                    status: 'unchanged' as const,
                  },
                ]
              : result.actions.map((action) => ({
                  code: `git-worktrees-${action}`,
                  message:
                    action === 'create-repository-root'
                      ? 'Git managed repository root'
                      : action === 'create-worktree-root'
                        ? 'Git managed worktree root'
                        : 'workspace .gitignore',
                  status:
                    action === 'update-gitignore' ? ('updated' as const) : ('created' as const),
                })),
        };
      } catch (error) {
        if (error instanceof AgentSystemLifecycleError) throw error;
        throw new AgentSystemLifecycleError(
          'git',
          'git-worktrees-reconcile-failed',
          error instanceof Error ? error.message : 'Git worktree layout reconciliation failed.',
          { cause: error },
        );
      }
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
      return {
        code: 'git-config-valid',
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
        summary: 'Git tool identity and policy configuration',
      };
    },
  };
}
