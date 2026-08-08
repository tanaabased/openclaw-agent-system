import defineAgentSystemCliTool from '../../lib/define-agent-system-cli-tool.ts';
import { AgentSystemToolError, type AgentSystemToolErrorCode } from '../../lib/tool-runtime.ts';
import type { AgentSystemCliResult } from '../../lib/tool-types.ts';
import type { AgentManifest } from '../../utils/manifest-types.ts';
import type { GitHubManifestConfiguration } from './config-schema.ts';
import { githubToolSchema, type GitHubToolInput } from './tool-schema.ts';

interface ResolvedGitHubConfiguration {
  host: 'github.com';
  tokenBinding: string;
  username?: string;
}

export interface GitHubUserResult {
  host: 'github.com';
  id: number;
  login: string;
}

function toolError(code: AgentSystemToolErrorCode, message: string): never {
  throw new AgentSystemToolError(code, message);
}

function normalizeUser(
  result: AgentSystemCliResult,
  configuration: ResolvedGitHubConfiguration,
): GitHubUserResult {
  if (result.exitCode !== 0) {
    toolError('execution_failed', 'GitHub rejected the authenticated user request.');
  }
  if (result.truncated) {
    toolError('execution_failed', 'GitHub returned more data than Agent System permits.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    toolError('execution_failed', 'GitHub returned an invalid user response.');
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof (payload as { id?: unknown }).id !== 'number' ||
    typeof (payload as { login?: unknown }).login !== 'string'
  ) {
    toolError('execution_failed', 'GitHub returned an incomplete user response.');
  }
  const { id, login } = payload as { id: number; login: string };
  if (configuration.username && login.toLowerCase() !== configuration.username.toLowerCase()) {
    toolError(
      'tool_identity_mismatch',
      `GitHub returned ${login}, not the configured username ${configuration.username}.`,
    );
  }

  return {
    host: configuration.host,
    id,
    login,
  };
}

function readConfiguration(manifest: AgentManifest): GitHubManifestConfiguration | undefined {
  return manifest.github;
}

const githubTool = defineAgentSystemCliTool({
  apiVersion: 1,
  id: 'github',
  configuration: {
    read: readConfiguration,
    resolve(configuration, resolver): ResolvedGitHubConfiguration {
      return {
        host: configuration.host ?? 'github.com',
        tokenBinding: configuration.token,
        ...(configuration.username
          ? { username: resolver.resolve(configuration.username, '/github/username') }
          : {}),
      };
    },
  },
  guidance: {
    prompt:
      'For GitHub operations, prefer the agent_system_github tool over ordinary exec, direct gh commands, HTTP, SDKs, or unrelated GitHub integrations. The initial tool supports only argv ["api", "user"] to identify the configured account.',
  },
  runner: {
    argv(input) {
      return [...input.argv, '--jq', '{id: .id, login: .login}'];
    },
    credentialBindings(configuration) {
      return { GH_TOKEN: configuration.tokenBinding };
    },
    environment(configuration) {
      return {
        GH_HOST: configuration.host,
        GH_PAGER: 'cat',
        GH_PROMPT_DISABLED: '1',
        NO_COLOR: '1',
        PAGER: 'cat',
      };
    },
    executable: 'gh',
    maxOutputBytes: 32_768,
    timeoutMs: 30_000,
  },
  commands: [{ command: 'gh' }],
  tool: {
    classify() {
      return {
        action: 'github.viewer.get',
        risk: 'read',
        summary: 'Read the authenticated GitHub account',
        resources: [{ type: 'host', id: 'github.com' }],
      };
    },
    description:
      'Use GitHub with the current Agent System configuration. The initial read-only surface accepts argv ["api", "user"] to identify the configured account.',
    inputFromCommand(argv): GitHubToolInput {
      const isUserRequest = argv[0] === 'api' && argv[1] === 'user';
      const hasNoFormatting = argv.length === 2;
      const hasLoginProjection = argv.length === 4 && argv[2] === '--jq' && argv[3] === '.login';
      if (!isUserRequest || (!hasNoFormatting && !hasLoginProjection)) {
        toolError(
          'invalid_arguments',
          'The initial Agent System GitHub tool supports only: gh api user [--jq .login]',
        );
      }
      return { argv: ['api', 'user'] };
    },
    label: 'Agent System GitHub',
    name: 'agent_system_github',
    normalize: normalizeUser,
    parameters: githubToolSchema,
  },
});

export default githubTool;
