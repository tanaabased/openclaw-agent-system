import { join } from 'node:path';

import type { AgentSystemCapability } from '../../api/capability.ts';
import defineAgentSystemCliTool from '../../api/define-cli-tool.ts';
import defineAgentSystemSemanticTool from '../../api/define-semantic-tool.ts';
import type WorkspaceGitignoreService from '../../paths/workspace-gitignore-service.ts';
import createGitExtensionResolver from './extension.ts';
import createGitLifecycleContribution from './lifecycle.ts';
import GitSshResourceService from './ssh-resource-service.ts';
import { createGitToolDefinition, type GitToolDefinition } from './tool.ts';
import TrustedGitWorktreeService, {
  type TrustedGitWorktreeServiceDependencies,
} from './trusted-worktree-service.ts';
import GitWorktreeGitRunnerFactory from './worktree-git-runner.ts';
import GitWorktreeLayoutService from './worktree-layout-service.ts';
import GitWorktreeService from './worktree-service.ts';
import { createGitWorktreeToolDefinition } from './worktree-tool.ts';

export interface GitCapabilityDependencies {
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  currentUid?: number;
  excludedExecutableDirectories?: readonly string[];
  gitignoreService: Pick<WorkspaceGitignoreService, 'includes' | 'reconcile'>;
  homeDirectory?: string;
  environmentService: TrustedGitWorktreeServiceDependencies['environmentService'];
  manifestService: TrustedGitWorktreeServiceDependencies['manifestService'];
  packageDir: string;
}

export interface GitCapability extends AgentSystemCapability {
  definition: GitToolDefinition;
  trustedWorktreeService: TrustedGitWorktreeService;
}

/** Assemble the Git lifecycle, CLI tool, and semantic worktree tool. */
export default function createGitCapability(
  dependencies: GitCapabilityDependencies,
): GitCapability {
  const sshResourceService = new GitSshResourceService({
    authenticationLauncherPath: join(dependencies.packageDir, 'bin', 'agent-system-ssh'),
    baseEnvironment: dependencies.baseEnvironment,
    ...(dependencies.currentUid === undefined ? {} : { currentUid: dependencies.currentUid }),
    excludedExecutableDirectories: dependencies.excludedExecutableDirectories,
    ...(dependencies.homeDirectory === undefined
      ? {}
      : { homeDirectory: dependencies.homeDirectory }),
    signingKeyLauncherPath: join(dependencies.packageDir, 'bin', 'agent-system-ssh-signing-key'),
    signingProgramPath: join(dependencies.packageDir, 'bin', 'agent-system-ssh-keygen'),
  });
  const extensionAvailable = createGitExtensionResolver({
    excludedExecutableDirectories: dependencies.excludedExecutableDirectories,
    path: dependencies.baseEnvironment.PATH ?? '',
  });
  const worktreeLayoutService = new GitWorktreeLayoutService({
    baseEnvironment: dependencies.baseEnvironment,
    ...(dependencies.currentUid === undefined ? {} : { currentUid: dependencies.currentUid }),
    excludedExecutableDirectories: dependencies.excludedExecutableDirectories,
    gitignoreService: dependencies.gitignoreService,
    ...(dependencies.homeDirectory === undefined
      ? {}
      : { homeDirectory: dependencies.homeDirectory }),
  });
  const runnerFactory = new GitWorktreeGitRunnerFactory({
    baseEnvironment: dependencies.baseEnvironment,
    excludedExecutableDirectories: dependencies.excludedExecutableDirectories,
    sshResourceService,
  });
  const worktreeService = new GitWorktreeService({ layoutService: worktreeLayoutService });
  const worktreeDefinition = createGitWorktreeToolDefinition({
    runnerFactory,
    service: worktreeService,
  });
  const definition = createGitToolDefinition({
    extensionAvailable,
    sshResourceService,
  });

  return {
    definition,
    lifecycleContributions: [
      createGitLifecycleContribution({
        sshResourceService,
        worktreeLayoutService,
      }),
    ],
    trustedWorktreeService: new TrustedGitWorktreeService({
      definition: worktreeDefinition,
      environmentService: dependencies.environmentService,
      manifestService: dependencies.manifestService,
    }),
    tools: [
      defineAgentSystemCliTool(definition),
      defineAgentSystemSemanticTool(worktreeDefinition),
    ],
  };
}
