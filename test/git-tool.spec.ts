import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentSystemToolError from '../lib/tool-error.ts';
import AgentSystemToolRegistry from '../lib/tool-registry.ts';
import AgentSystemToolRuntime from '../lib/tool-runtime.ts';
import type { AgentSystemCliRunRequest } from '../lib/tool-types.ts';
import { createGitTool } from '../tools/git/tool.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

describe('tools/git/tool', () => {
  let root = '';
  let workspaceDir = '';
  let repositoryDir = '';
  let manifest: AgentManifest;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-git-tool-'));
    workspaceDir = join(root, 'workspace');
    repositoryDir = join(workspaceDir, 'project');
    await mkdir(repositoryDir, { recursive: true });
    manifest = {
      schemaVersion: 1,
      agent: {
        id: 'data',
        email: { fromEnvironment: 'AGENT_EMAIL' },
        name: 'Data',
      },
      environment: { set: { AGENT_EMAIL: 'data@example.com' } },
      git: {},
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true });
  });

  function loadedManifest() {
    return {
      status: 'loaded' as const,
      scope: { agentId: 'data', workspaceDir },
      path: join(workspaceDir, 'agent.yaml'),
      digest: 'manifest-digest',
      manifest,
      diagnostics: [],
      validationChecks: [],
    };
  }

  function createRuntime(
    requests: AgentSystemCliRunRequest[],
    environmentCalls: string[] = [],
  ): AgentSystemToolRuntime {
    return new AgentSystemToolRuntime({
      baseEnvironment: {
        HOME: '/home/runner',
        PATH: '/usr/bin',
        SHOULD_NOT_INHERIT: 'host-private',
      },
      environmentService: {
        async loadForAgentId(agentId) {
          environmentCalls.push(agentId);
          return {
            ...loadedManifest(),
            environment: {
              values: { AGENT_EMAIL: 'data@example.com' },
              variables: [],
            },
          };
        },
      },
      logger: { error() {}, info() {} },
      manifestService: {
        async loadForAgentId() {
          return loadedManifest();
        },
        async loadForCommandDirectory(path) {
          assert.equal(path, repositoryDir);
          return loadedManifest();
        },
      },
      async runCli(request) {
        requests.push(request);
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'Data <data@example.com>\n',
          timedOut: false,
          truncated: false,
        };
      },
    });
  }

  it('should preserve a nested command directory and project the agent git identity', async () => {
    const requests: AgentSystemCliRunRequest[] = [];
    const registry = new AgentSystemToolRegistry([createGitTool()]);

    const result = await registry.invoke(
      'git',
      createRuntime(requests),
      ['log', '-1', '--format=%an <%ae>'],
      { source: 'command', workspaceDir: repositoryDir },
    );

    assert.equal(
      result.output && (result.output as { stdout: string }).stdout,
      'Data <data@example.com>\n',
    );
    assert.equal(requests[0]?.cwd, await realpath(repositoryDir));
    assert.deepEqual(requests[0]?.argv, ['log', '-1', '--format=%an <%ae>']);
    assert.equal(requests[0]?.environment.GIT_AUTHOR_NAME, 'Data');
    assert.equal(requests[0]?.environment.GIT_COMMITTER_EMAIL, 'data@example.com');
    assert.equal(requests[0]?.environment.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(requests[0]?.environment.SHOULD_NOT_INHERIT, undefined);
  });

  it('should reject escape options and destructive defaults before loading environment', async () => {
    const environmentCalls: string[] = [];
    const registry = new AgentSystemToolRegistry([createGitTool()]);
    const runtime = createRuntime([], environmentCalls);

    await assert.rejects(
      registry.invoke('git', runtime, ['-C', '/tmp', 'status'], {
        source: 'command',
        workspaceDir: repositoryDir,
      }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'invalid_arguments',
    );
    await assert.rejects(
      registry.invoke('git', runtime, ['reset', '--hard', 'HEAD'], {
        source: 'command',
        workspaceDir: repositoryDir,
      }),
      (error: unknown) => error instanceof AgentSystemToolError && error.code === 'approval_denied',
    );
    assert.deepEqual(environmentCalls, []);
  });
});
