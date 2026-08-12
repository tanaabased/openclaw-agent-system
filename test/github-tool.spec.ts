import assert from 'node:assert/strict';

import type {
  OpenClawPluginToolFactory,
  PluginTrustedToolPolicyRegistration,
} from 'openclaw/plugin-sdk/plugin-entry';

import AgentSystemToolRegistry from '../lib/tool-registry.ts';
import AgentSystemToolError from '../lib/tool-error.ts';
import AgentSystemToolRuntime from '../lib/tool-runtime.ts';
import type { AgentSystemCliResult, AgentSystemCliRunRequest } from '../lib/tool-types.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import { createGitHubTool } from '../tools/github/tool.ts';

const workspaceDir = '/workspace/data';
const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data' },
  environment: {
    pathPrepend: ['commands'],
    set: {
      GH_TOKEN_TANAABOT: 'private-token',
      GITHUB_USERNAME: 'tanaabot',
    },
  },
  github: {
    username: { fromEnvironment: 'GITHUB_USERNAME' },
    token: 'GH_TOKEN_TANAABOT',
  },
};

function loadedManifest(inputManifest = manifest) {
  return {
    status: 'loaded' as const,
    scope: { agentId: inputManifest.agent.id, workspaceDir },
    path: `${workspaceDir}/agent.yaml`,
    digest: 'manifest-digest',
    manifest: inputManifest,
    diagnostics: [],
    validationChecks: [],
  };
}

function loadedEnvironment(
  inputManifest = manifest,
  values: Record<string, string> = {
    GH_TOKEN_TANAABOT: 'private-token',
    GITHUB_USERNAME: 'tanaabot',
  },
) {
  return {
    ...loadedManifest(inputManifest),
    environment: { values, variables: [] },
  };
}

function createTool(reconciliations: string[] = []) {
  return createGitHubTool({
    configStore: {
      configDirectory: (agentId) => `/private/${agentId}/tools/gh`,
      async reconcile(agentId) {
        reconciliations.push(agentId);
        return { configDir: `/private/${agentId}/tools/gh`, status: 'unchanged' };
      },
    },
  });
}

function createRuntime(
  options: {
    environmentCalls?: string[];
    environmentValues?: Record<string, string>;
    inputManifest?: AgentManifest;
    logs?: string[];
    excludedExecutableDirectories?: string[];
    runCli?: (request: AgentSystemCliRunRequest) => Promise<AgentSystemCliResult>;
  } = {},
) {
  const inputManifest = options.inputManifest ?? manifest;
  const logs = options.logs ?? [];
  const environmentCalls = options.environmentCalls ?? [];
  return new AgentSystemToolRuntime({
    baseEnvironment: {
      HOME: '/home/runner',
      NO_COLOR: '1',
      PATH: '/usr/bin',
      SHOULD_NOT_INHERIT: 'private-host-value',
    },
    environmentService: {
      async loadForAgentId(agentId) {
        environmentCalls.push(agentId);
        return loadedEnvironment(inputManifest, options.environmentValues);
      },
    },
    excludedExecutableDirectories: options.excludedExecutableDirectories ?? ['/package/bin'],
    logger: {
      error: (message) => logs.push(message),
      info: (message) => logs.push(message),
    },
    manifestService: {
      async loadForAgentId() {
        return loadedManifest(inputManifest);
      },
      async loadForCommandDirectory() {
        return loadedManifest(inputManifest);
      },
    },
    runCli:
      options.runCli ??
      (async (request) => ({
        exitCode: 0,
        stderr: '',
        stdout: request.argv[0] === 'api' ? 'tanaabot\n' : '{"name":"project"}\n',
        timedOut: false,
        truncated: false,
      })),
  });
}

describe('tools/github/tool', () => {
  it('should expose skill guidance only when github is configured', () => {
    const registry = new AgentSystemToolRegistry([createTool()]);

    assert.equal(registry.guidance(manifest)[0]?.includes('$agent-system-github-cli'), true);
    assert.deepEqual(registry.guidance({ schemaVersion: 1, agent: { id: 'data' } }), []);
  });

  it('should run generic gh arguments through a sanitized agent environment', async () => {
    const reconciliations: string[] = [];
    const registry = new AgentSystemToolRegistry([createTool(reconciliations)]);
    const logs: string[] = [];
    const requests: AgentSystemCliRunRequest[] = [];
    const runtime = createRuntime({
      excludedExecutableDirectories: ['/package/bin', '/source/bin'],
      logs,
      runCli: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stderr: '',
          stdout: request.argv[0] === 'api' ? 'tanaabot\n' : '{"name":"project"}\n',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const result = await registry.invoke(
      'gh',
      runtime,
      ['repo', 'view', 'tanaabased/openclaw-agent-system', '--json', 'name'],
      { source: 'command', terminalColumns: 120, workspaceDir },
    );

    assert.deepEqual(result.output, {
      exitCode: 0,
      stderr: '',
      stdout: '{"name":"project"}\n',
      truncated: false,
    });
    assert.deepEqual(
      requests.map(({ argv }) => argv),
      [
        ['api', 'user', '--jq', '.login'],
        ['repo', 'view', 'tanaabased/openclaw-agent-system', '--json', 'name'],
      ],
    );
    assert.equal(requests[1]?.environment.GH_TOKEN, 'private-token');
    assert.equal(requests[1]?.environment.GH_CONFIG_DIR, '/private/data/tools/gh');
    assert.equal(requests[1]?.environment.GH_FORCE_TTY, '120');
    assert.equal(requests[1]?.environment.NO_COLOR, '1');
    assert.equal(requests[1]?.environment.SHOULD_NOT_INHERIT, undefined);
    assert.deepEqual(requests[1]?.excludedExecutableDirectories, [
      `${workspaceDir}/bin`,
      `${workspaceDir}/commands`,
      '/package/bin',
      '/source/bin',
    ]);
    assert.deepEqual(reconciliations, ['data']);
    assert.equal(logs.join('\n').includes('private-token'), false);
  });

  it('should fall back from GH_TOKEN to GITHUB_TOKEN inside the completed agent environment', async () => {
    const fallbackManifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'data' },
      github: {},
    };
    const captured: string[] = [];
    const runtime = createRuntime({
      inputManifest: fallbackManifest,
      environmentValues: { GITHUB_TOKEN: 'fallback-token' },
      runCli: async (request) => {
        captured.push(request.environment.GH_TOKEN ?? '');
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'project\n',
          timedOut: false,
          truncated: false,
        };
      },
    });

    await new AgentSystemToolRegistry([createTool()]).invoke(
      'gh',
      runtime,
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      { source: 'command', workspaceDir },
    );

    assert.deepEqual(captured, ['fallback-token']);
  });

  it('should prefer GH_TOKEN over GITHUB_TOKEN when no explicit binding is declared', async () => {
    const fallbackManifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'data' },
      github: {},
    };
    const captured: string[] = [];
    await new AgentSystemToolRegistry([createTool()]).invoke(
      'gh',
      createRuntime({
        inputManifest: fallbackManifest,
        environmentValues: { GH_TOKEN: 'preferred-token', GITHUB_TOKEN: 'fallback-token' },
        runCli: async (request) => {
          captured.push(request.environment.GH_TOKEN ?? '');
          return {
            exitCode: 0,
            stderr: '',
            stdout: 'project\n',
            timedOut: false,
            truncated: false,
          };
        },
      }),
      ['repo', 'view'],
      { source: 'command', workspaceDir },
    );

    assert.deepEqual(captured, ['preferred-token']);
  });

  it('should fail when neither the explicit nor fallback credential is available', async () => {
    const fallbackManifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'data' },
      github: {},
    };

    await assert.rejects(
      new AgentSystemToolRegistry([createTool()]).invoke(
        'gh',
        createRuntime({ inputManifest: fallbackManifest, environmentValues: {} }),
        ['repo', 'view'],
        { source: 'command', workspaceDir },
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'credential_unavailable',
    );
  });

  it('should keep generic stdin bounded and forward it without a shell', async () => {
    const requests: AgentSystemCliRunRequest[] = [];
    const registry = new AgentSystemToolRegistry([createTool()]);
    const runtime = createRuntime({
      runCli: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stderr: '',
          stdout: request.argv[0] === 'api' ? 'tanaabot\n' : '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    let factory: OpenClawPluginToolFactory | undefined;
    registry.registerTools(
      {
        registerTool(tool: unknown) {
          factory = tool as OpenClawPluginToolFactory;
        },
      } as never,
      runtime,
    );
    const produced = factory?.({ agentId: 'data', workspaceDir } as never);
    const tool = Array.isArray(produced) ? produced[0] : produced;
    assert.ok(tool);

    await tool.execute(
      'call-id',
      {
        argv: ['api', 'graphql', '--input', '-'],
        stdin: '{"query":"query Viewer { viewer { login } }"}',
      },
      undefined,
      undefined,
    );

    assert.equal(requests[1]?.stdin, '{"query":"query Viewer { viewer { login } }"}');
  });

  it('should reject credential, config, extension, and interactive escape paths before credentials load', async () => {
    const environmentCalls: string[] = [];
    const registry = new AgentSystemToolRegistry([createTool()]);

    for (const argv of [
      ['auth', 'token'],
      ['auth', 'login'],
      ['config', 'set', 'git_protocol', 'ssh'],
      ['alias', 'set', 'mine', '!sh'],
      ['extension', 'exec', 'mine'],
      ['auth', 'status', '--show-token'],
      ['api', 'user', '--hostname=example.com'],
      ['repo', 'view', '--web'],
    ]) {
      await assert.rejects(
        registry.invoke('gh', createRuntime({ environmentCalls }), argv, {
          source: 'command',
          workspaceDir,
        }),
        (error: unknown) =>
          error instanceof AgentSystemToolError && error.code === 'invalid_arguments',
      );
    }
    assert.deepEqual(environmentCalls, []);
  });

  it('should deny github release mutations before credentials load', async () => {
    const environmentCalls: string[] = [];

    await assert.rejects(
      new AgentSystemToolRegistry([createTool()]).invoke(
        'gh',
        createRuntime({ environmentCalls }),
        ['release', 'create', 'v1.0.0'],
        { source: 'command', workspaceDir },
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError &&
        error.code === 'approval_denied' &&
        error.message.includes('denied by github.policy.releases') &&
        error.message.includes('operator must set github.policy.releases to allow'),
    );
    assert.deepEqual(environmentCalls, []);
  });

  it('should allow non-release github operations through the shared runtime', async () => {
    const requests: AgentSystemCliRunRequest[] = [];

    await new AgentSystemToolRegistry([createTool()]).invoke(
      'gh',
      createRuntime({
        runCli: async (request) => {
          requests.push(request);
          return {
            exitCode: 0,
            stderr: '',
            stdout: request.argv[0] === 'api' ? 'tanaabot\n' : '',
            timedOut: false,
            truncated: false,
          };
        },
      }),
      ['repo', 'vaporize', 'owner/repository'],
      { source: 'command', workspaceDir },
    );

    assert.deepEqual(
      requests.map(({ argv }) => argv),
      [
        ['api', 'user', '--jq', '.login'],
        ['repo', 'vaporize', 'owner/repository'],
      ],
    );
  });

  it('should return actionable hard denial through trusted native policy', async () => {
    const registry = new AgentSystemToolRegistry([createTool()]);
    let policy: PluginTrustedToolPolicyRegistration | undefined;
    registry.registerTrustedPolicies(
      {
        registerTrustedToolPolicy(registration) {
          policy = registration;
        },
      },
      {
        async loadForAgentId() {
          return loadedManifest();
        },
      },
    );
    assert.ok(policy);
    const input = { argv: ['release', 'delete', 'v1.0.0', '--yes'] };
    const decision = await policy.evaluate(
      { params: input, toolName: 'agent_system_github', toolCallId: 'approved-call' },
      {
        agentId: 'data',
        toolCallId: 'approved-call',
        toolName: 'agent_system_github',
      },
    );
    assert.ok(decision && 'allow' in decision && decision.allow === false && decision.reason);
    assert.match(decision.reason, /denied by github\.policy\.releases/u);
    assert.match(decision.reason, /operator must set github\.policy\.releases to allow/u);
  });

  it('should reject an authenticated user that does not match the configured username', async () => {
    const runtime = createRuntime({
      runCli: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: 'someone-else\n',
        timedOut: false,
        truncated: false,
      }),
    });

    await assert.rejects(
      new AgentSystemToolRegistry([createTool()]).invoke('gh', runtime, ['repo', 'view'], {
        source: 'command',
        workspaceDir,
      }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'tool_identity_mismatch',
    );
  });

  it('should return a nonzero gh result without exposing credentials in output or logs', async () => {
    const logs: string[] = [];
    const result = await new AgentSystemToolRegistry([createTool()]).invoke(
      'gh',
      createRuntime({
        logs,
        runCli: async (request) =>
          request.argv[0] === 'api'
            ? {
                exitCode: 0,
                stderr: '',
                stdout: 'tanaabot\n',
                timedOut: false,
                truncated: false,
              }
            : {
                exitCode: 4,
                stderr: 'request failed for private-token',
                stdout: '',
                timedOut: false,
                truncated: false,
              },
      }),
      ['repo', 'view', 'missing/repo'],
      { source: 'command', workspaceDir },
    );

    assert.equal(result.kind, 'cli');
    if (result.kind !== 'cli') throw new Error('Expected CLI execution result.');
    assert.equal(result.commandResult.exitCode, 4);
    assert.equal(result.commandResult.stderr, 'request failed for [REDACTED]');
    assert.equal(logs.join('\n').includes('private-token'), false);
    assert.equal(logs.join('\n').includes('request failed'), false);
  });
});
