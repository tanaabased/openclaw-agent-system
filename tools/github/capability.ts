import type AgentEnvironmentService from '../../lib/agent-environment-service.ts';
import type { AgentSystemCapability } from '../../lib/capability.ts';
import GitHubAccountClient from './account-client.ts';
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

/** Assemble the GitHub lifecycle and fixed-executable CLI tool. */
export default function createGitHubCapability(
  dependencies: GitHubCapabilityDependencies,
): AgentSystemCapability {
  const configStore = new GitHubConfigStore({
    ...(dependencies.currentUid === undefined ? {} : { currentUid: dependencies.currentUid }),
    ...(dependencies.privateStateRoot === undefined
      ? {}
      : { rootDir: dependencies.privateStateRoot }),
  });
  const accountKeyService = new GitHubAccountKeyService({
    client: new GitHubAccountClient({
      baseEnvironment: dependencies.baseEnvironment,
      configStore,
      environmentService: dependencies.environmentService,
      excludedExecutableDirectories: dependencies.excludedExecutableDirectories,
    }),
    ...(dependencies.homeDirectory === undefined
      ? {}
      : { homeDirectory: dependencies.homeDirectory }),
  });

  return {
    lifecycleContributions: [
      createGitHubLifecycleContribution({
        accountKeyService,
        configStore,
      }),
    ],
    tools: [createGitHubTool({ configStore })],
  };
}
