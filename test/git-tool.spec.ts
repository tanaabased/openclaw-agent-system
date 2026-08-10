import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
              values: {
                AGENT_EMAIL: 'data@example.com',
                GIT_SIGNING_KEY: 'private-key-material',
              },
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

  it('should authorize only declared external extensions before loading environment', async () => {
    const environmentCalls: string[] = [];
    const requests: AgentSystemCliRunRequest[] = [];
    manifest.git = { extensions: { town: 'allow' } };
    const registry = new AgentSystemToolRegistry([
      createGitTool({ extensionAvailable: async (name) => name === 'town' }),
    ]);
    const runtime = createRuntime(requests, environmentCalls);

    await registry.invoke('git', runtime, ['town', 'status'], {
      source: 'command',
      workspaceDir: repositoryDir,
    });
    assert.deepEqual(environmentCalls, ['data']);
    assert.deepEqual(requests[0]?.argv, ['town', 'status']);
    assert.equal(requests[0]?.environment.GIT_CONFIG_KEY_5, 'alias.town');
    assert.equal(requests[0]?.environment.GIT_CONFIG_VALUE_5, '');

    environmentCalls.length = 0;
    manifest.git = { extensions: { missing: 'allow' } };
    await assert.rejects(
      registry.invoke('git', runtime, ['missing'], {
        source: 'command',
        workspaceDir: repositoryDir,
      }),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'operation_unclassified',
    );
    assert.deepEqual(environmentCalls, []);
  });

  it('should acquire managed ssh only for remote-capable commands', async () => {
    const events: string[] = [];
    const requests: AgentSystemCliRunRequest[] = [];
    manifest.git = {
      ssh: { privateKeys: [{ fromEnvironment: 'GIT_SSH_PRIVATE_KEY' }] },
    };
    const registry = new AgentSystemToolRegistry([
      createGitTool({
        sshResourceService: {
          async acquire(configuration, scope) {
            events.push(`acquire:${configuration.authentication?.privateKeys.length ?? 0}`);
            assert.equal(scope.resolveEnvironment('AGENT_EMAIL'), 'data@example.com');
            return {
              async dispose() {
                events.push('dispose');
              },
              environment: { GIT_SSH: '/package/bin/agent-system-ssh' },
            };
          },
          launcherEnvironment() {
            return {
              GIT_SSH: '/package/bin/agent-system-ssh',
              GIT_SSH_VARIANT: 'ssh',
            };
          },
        },
      }),
    ]);
    const runtime = createRuntime(requests);

    await registry.invoke('git', runtime, ['status', '--short'], {
      source: 'command',
      workspaceDir: repositoryDir,
    });
    assert.deepEqual(events, []);
    assert.equal(requests[0]?.environment.GIT_SSH, '/package/bin/agent-system-ssh');
    assert.equal(requests[0]?.environment.AGENT_SYSTEM_SSH_CONFIG, undefined);
    await registry.invoke(
      'git',
      runtime,
      ['ls-remote', 'git@github.com:tanaabased/openclaw-agent-system.git', 'HEAD'],
      { source: 'command', workspaceDir: repositoryDir },
    );

    assert.deepEqual(events, ['acquire:1', 'dispose']);
    assert.equal(requests[1]?.environment.GIT_SSH, '/package/bin/agent-system-ssh');
  });

  it('should materialize a signing key only for signed object creation', async () => {
    const events: string[] = [];
    const requests: AgentSystemCliRunRequest[] = [];
    const allowedSignersFile = join(workspaceDir, '.agent-system', 'allowed_signers');
    await mkdir(join(workspaceDir, '.agent-system'), { recursive: true });
    await writeFile(allowedSignersFile, 'data@example.com ssh-ed25519 AAAA\n');
    manifest.git = {
      signing: {
        allowedSignersFile: '.agent-system/allowed_signers',
        key: 'GIT_SIGNING_KEY',
      },
    };
    const registry = new AgentSystemToolRegistry([
      createGitTool({
        sshResourceService: {
          async acquire(configuration, scope) {
            assert.equal(configuration.authentication, undefined);
            assert.deepEqual(configuration.signing, {
              gitConfigurationOffset: 10,
              key: 'GIT_SIGNING_KEY',
            });
            assert.equal(scope.resolveEnvironment('GIT_SIGNING_KEY'), 'private-key-material');
            events.push('acquire');
            return {
              async dispose() {
                events.push('dispose');
              },
              environment: {
                GIT_CONFIG_COUNT: '11',
                GIT_CONFIG_KEY_10: 'user.signingKey',
                GIT_CONFIG_VALUE_10: 'key::ssh-ed25519 AAAATEST',
                SSH_AUTH_SOCK: '/tmp/signing-agent.sock',
              },
              sensitiveValues: ['private-key-material'],
            };
          },
        },
      }),
    ]);
    const runtime = createRuntime(requests);

    await registry.invoke('git', runtime, ['verify-commit', 'HEAD'], {
      source: 'command',
      workspaceDir: repositoryDir,
    });
    assert.deepEqual(events, []);
    assert.equal(requests[0]?.environment.GIT_CONFIG_COUNT, '10');
    assert.equal(requests[0]?.environment.GIT_CONFIG_KEY_5, 'gpg.format');
    assert.equal(requests[0]?.environment.GIT_CONFIG_KEY_6, 'commit.gpgSign');
    assert.equal(requests[0]?.environment.GIT_CONFIG_KEY_7, 'tag.gpgSign');
    assert.equal(requests[0]?.environment.GIT_CONFIG_KEY_8, 'gpg.ssh.allowedSignersFile');
    assert.equal(requests[0]?.environment.GIT_CONFIG_VALUE_8, await realpath(allowedSignersFile));
    assert.equal(requests[0]?.environment.GIT_CONFIG_KEY_9, 'gpg.minTrustLevel');
    assert.equal(requests[0]?.environment.GIT_CONFIG_VALUE_9, 'fully');
    assert.equal(requests[0]?.environment.GIT_CONFIG_KEY_10, undefined);

    await registry.invoke('git', runtime, ['commit', '--message', 'signed'], {
      source: 'command',
      workspaceDir: repositoryDir,
    });
    assert.deepEqual(events, ['acquire', 'dispose']);
    assert.equal(requests[1]?.environment.GIT_CONFIG_COUNT, '11');
    assert.equal(requests[1]?.environment.GIT_CONFIG_KEY_10, 'user.signingKey');
    assert.equal(requests[1]?.environment.GIT_CONFIG_VALUE_10, 'key::ssh-ed25519 AAAATEST');
    assert.equal(requests[1]?.environment.SSH_AUTH_SOCK, '/tmp/signing-agent.sock');
    assert.equal(
      Object.values(requests[1]?.environment ?? {}).includes('private-key-material'),
      false,
    );
  });

  it('should reject signing controls before loading the completed environment', async () => {
    const environmentCalls: string[] = [];
    manifest.git = { signing: { key: 'GIT_SIGNING_KEY' } };
    const registry = new AgentSystemToolRegistry([createGitTool()]);
    const runtime = createRuntime([], environmentCalls);

    for (const argv of [
      ['commit', '--no-gpg-sign', '--message', 'unsigned'],
      ['tag', '--no-sign', 'v1.0.0'],
    ]) {
      await assert.rejects(
        registry.invoke('git', runtime, argv, {
          source: 'command',
          workspaceDir: repositoryDir,
        }),
        (error: unknown) =>
          error instanceof AgentSystemToolError && error.code === 'invalid_arguments',
      );
    }
    assert.deepEqual(environmentCalls, []);
  });
});
