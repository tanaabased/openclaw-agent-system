import assert from 'node:assert/strict';

import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';

import AgentSystemToolRegistry from '../lib/tool-registry.ts';
import AgentSystemToolRuntime, { AgentSystemToolError } from '../lib/tool-runtime.ts';
import type { AgentSystemCliResult, AgentSystemCliRunRequest } from '../lib/tool-types.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import githubTool from '../tools/github/tool.ts';

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

function loadedManifest() {
  return {
    status: 'loaded' as const,
    scope: { agentId: 'data', workspaceDir },
    path: `${workspaceDir}/agent.yaml`,
    digest: 'manifest-digest',
    manifest,
    diagnostics: [],
  };
}

function loadedEnvironment() {
  return {
    ...loadedManifest(),
    environment: {
      values: {
        GH_TOKEN_TANAABOT: 'private-token',
        GITHUB_USERNAME: 'tanaabot',
      },
      variables: [],
    },
  };
}

function createRuntime(
  options: {
    authorize?: () => Promise<{ status: 'allowed' } | { status: 'denied'; reason: string }>;
    environmentCalls?: string[];
    logs?: string[];
    manifestWorkspace?: string;
    excludedExecutableDirectories?: string[];
    runCli?: (request: AgentSystemCliRunRequest) => Promise<AgentSystemCliResult>;
  } = {},
) {
  const logs = options.logs ?? [];
  const environmentCalls = options.environmentCalls ?? [];
  return new AgentSystemToolRuntime({
    ...(options.authorize ? { authorize: options.authorize } : {}),
    baseEnvironment: {
      HOME: '/home/runner',
      PATH: '/usr/bin',
      SHOULD_NOT_INHERIT: 'private-host-value',
    },
    environmentService: {
      async loadForAgentId(agentId) {
        environmentCalls.push(agentId);
        return loadedEnvironment();
      },
    },
    excludedExecutableDirectories: options.excludedExecutableDirectories ?? ['/package/bin'],
    logger: {
      error: (message) => logs.push(message),
      info: (message) => logs.push(message),
    },
    manifestService: {
      async loadForAgentId() {
        const result = loadedManifest();
        return {
          ...result,
          scope: { ...result.scope, workspaceDir: options.manifestWorkspace ?? workspaceDir },
        };
      },
      async loadForWorkspace() {
        return loadedManifest();
      },
    },
    runCli:
      options.runCli ??
      (async () => ({
        exitCode: 0,
        stderr: '',
        stdout: '{"id":222685891,"login":"tanaabot"}',
        timedOut: false,
        truncated: false,
      })),
  });
}

describe('tools/github/tool', () => {
  it('should expose guidance only when github is configured', () => {
    const registry = new AgentSystemToolRegistry([githubTool]);

    assert.equal(registry.guidance(manifest)[0]?.includes('agent_system_github'), true);
    assert.deepEqual(registry.guidance({ schemaVersion: 1, agent: { id: 'data' } }), []);
  });

  it('should read the configured user through a sanitized child environment', async () => {
    const registry = new AgentSystemToolRegistry([githubTool]);
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
          stdout: '{"id":222685891,"login":"tanaabot"}',
          timedOut: false,
          truncated: false,
        };
      },
    });

    const result = await registry.invoke('gh', runtime, ['api', 'user', '--jq', '.login'], {
      source: 'command',
      workspaceDir,
    });

    assert.deepEqual(result.output, {
      host: 'github.com',
      id: 222685891,
      login: 'tanaabot',
    });
    assert.deepEqual(requests[0]?.argv, ['api', 'user', '--jq', '{id: .id, login: .login}']);
    assert.equal(requests[0]?.executable, 'gh');
    assert.equal(requests[0]?.environment.GH_TOKEN, 'private-token');
    assert.equal(requests[0]?.environment.SHOULD_NOT_INHERIT, undefined);
    assert.deepEqual(requests[0]?.excludedExecutableDirectories, [
      `${workspaceDir}/bin`,
      `${workspaceDir}/commands`,
      '/package/bin',
      '/source/bin',
    ]);
    assert.equal(logs.join('\n').includes('private-token'), false);
    assert.equal(
      logs.some((line) => line.includes('source="command"')),
      true,
    );
  });

  it('should deny unapproved operations before resolving any environment', async () => {
    const registry = new AgentSystemToolRegistry([githubTool]);
    const environmentCalls: string[] = [];
    const runtime = createRuntime({
      authorize: async () => ({ status: 'denied', reason: 'policy denied' }),
      environmentCalls,
    });

    await assert.rejects(
      registry.invoke('gh', runtime, ['api', 'user'], { source: 'command', workspaceDir }),
      (error: unknown) => error instanceof AgentSystemToolError && error.code === 'approval_denied',
    );
    assert.deepEqual(environmentCalls, []);
  });

  it('should bind a native tool call to its declared agent workspace', async () => {
    const registry = new AgentSystemToolRegistry([githubTool]);
    let factory: OpenClawPluginToolFactory | undefined;
    registry.registerTools(
      {
        registerTool(tool: unknown) {
          factory = tool as OpenClawPluginToolFactory;
        },
      } as never,
      createRuntime({ manifestWorkspace: '/workspace/other' }),
    );
    const produced = factory?.({ agentId: 'data', workspaceDir } as never);
    const tool = Array.isArray(produced) ? produced[0] : produced;
    assert.ok(tool);

    await assert.rejects(
      tool.execute('call-id', { argv: ['api', 'user'] }, undefined, undefined),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'agent_not_resolved',
    );
  });

  it('should reject unsupported gh arguments before loading tool credentials', async () => {
    const registry = new AgentSystemToolRegistry([githubTool]);
    const environmentCalls: string[] = [];

    await assert.rejects(
      registry.invoke('gh', createRuntime({ environmentCalls }), ['api', 'repos'], {
        source: 'command',
        workspaceDir,
      }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'invalid_arguments',
    );
    assert.deepEqual(environmentCalls, []);
  });

  it('should reject commands outside the registered tool surface', () => {
    const registry = new AgentSystemToolRegistry([githubTool]);

    assert.throws(
      () =>
        registry.invoke('git', createRuntime(), ['status'], {
          source: 'command',
          workspaceDir,
        }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'tool_unavailable',
    );
  });

  it('should reject duplicate tool and command ownership', () => {
    assert.throws(
      () => new AgentSystemToolRegistry([githubTool, githubTool]),
      /Duplicate Agent System tool id/,
    );
    assert.throws(
      () => new AgentSystemToolRegistry([githubTool, { ...githubTool, id: 'other' }]),
      /Duplicate Agent System tool command/,
    );
  });

  it('should reject an authenticated user that does not match the configured username', async () => {
    const registry = new AgentSystemToolRegistry([githubTool]);
    const runtime = createRuntime({
      runCli: async () => ({
        exitCode: 0,
        stderr: '',
        stdout: '{"id":1,"login":"someone-else"}',
        timedOut: false,
        truncated: false,
      }),
    });

    await assert.rejects(
      registry.invoke('gh', runtime, ['api', 'user'], { source: 'command', workspaceDir }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'tool_identity_mismatch',
    );
  });

  it('should keep child failure output out of lifecycle logs', async () => {
    const registry = new AgentSystemToolRegistry([githubTool]);
    const logs: string[] = [];
    const runtime = createRuntime({
      logs,
      runCli: async () => ({
        exitCode: 1,
        resolvedExecutable: '/workspace/source/bin/gh',
        stderr: 'request failed for private-token',
        stdout: '',
        timedOut: false,
        truncated: false,
      }),
    });

    await assert.rejects(
      registry.invoke('gh', runtime, ['api', 'user'], { source: 'command', workspaceDir }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'execution_failed',
    );
    assert.equal(
      logs.some((line) => line.startsWith('tool_call_failed') && line.includes('execution_failed')),
      true,
    );
    assert.equal(logs.join('\n').includes('private-token'), false);
    assert.equal(logs.join('\n').includes('request failed'), false);
  });
});
