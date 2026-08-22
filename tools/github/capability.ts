import type AgentEnvironmentService from '../../environment/service.ts';
import type { AgentSystemCapability } from '../../api/capability.ts';
import GitHubAccountClient from '../../core/github-account-client.ts';
import GitHubAccountKeyService from './account-key-service.ts';
import GitHubConfigStore from './config-store.ts';
import createGitHubLifecycleContribution from './lifecycle.ts';
import { createGitHubTool } from './tool.ts';

export interface GitHubCapabilityDependencies {
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  currentUid?: number;
  environmentService: Pick<AgentEnvironmentService, 'loadForWorkspace'>;
  excludedExecutableDirectories?: readonly string[];
  homeDirectory?: string;
  privateStateRoot?: string;
}

export interface GitHubCapability extends AgentSystemCapability {
  accountClient: GitHubAccountClient;
}

/** Assemble the GitHub lifecycle and fixed-executable CLI tool. */
export default function createGitHubCapability(
  dependencies: GitHubCapabilityDependencies,
): GitHubCapability {
  const configStore = new GitHubConfigStore({
    ...(dependencies.currentUid === undefined ? {} : { currentUid: dependencies.currentUid }),
    ...(dependencies.privateStateRoot === undefined
      ? {}
      : { rootDir: dependencies.privateStateRoot }),
  });
  const accountClient = new GitHubAccountClient({
    baseEnvironment: dependencies.baseEnvironment,
    configStore,
    environmentService: dependencies.environmentService,
    excludedExecutableDirectories: dependencies.excludedExecutableDirectories,
  });
  const accountKeyService = new GitHubAccountKeyService({
    client: accountClient,
    ...(dependencies.homeDirectory === undefined
      ? {}
      : { homeDirectory: dependencies.homeDirectory }),
  });

  return {
    accountClient,
    lifecycleContributions: [
      createGitHubLifecycleContribution({
        accountKeyService,
        configStore,
      }),
    ],
    tools: [createGitHubTool({ configStore })],
  };
}
