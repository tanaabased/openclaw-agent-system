import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import AgentInstallService, { AgentInstallError } from '../lib/agent-install-service.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data', name: 'Data', avatar: 'avatar.png' },
};

function successfulResult() {
  return { code: 0, stderr: '', stdout: '{}' };
}

describe('lib/agent-install-service', () => {
  it('should add an absent agent and set its manifest identity', async () => {
    let config: OpenClawConfig = {};
    let configReads = 0;
    const commands: string[][] = [];
    const service = new AgentInstallService({
      readConfig() {
        configReads += 1;
        return config;
      },
      async runOpenClawCommand(args) {
        commands.push(args);
        if (args[1] === 'add') {
          config = {
            agents: {
              list: [{ id: 'data', workspace: '/workspace/data' }],
            },
          };
        } else {
          config = {
            agents: {
              list: [
                {
                  id: 'data',
                  workspace: '/workspace/data',
                  identity: { name: 'Data', avatar: 'avatar.png' },
                },
              ],
            },
          };
        }
        return successfulResult();
      },
    });

    const result = await service.install({ manifest, workspaceDir: '/workspace/data' });

    assert.deepEqual(result.actions, ['add-agent', 'set-identity']);
    assert.equal(configReads, 2);
    assert.deepEqual(commands, [
      ['agents', 'add', 'data', '--workspace', '/workspace/data', '--non-interactive', '--json'],
      [
        'agents',
        'set-identity',
        '--agent',
        'data',
        '--workspace',
        '/workspace/data',
        '--name',
        'Data',
        '--avatar',
        'avatar.png',
        '--json',
      ],
    ]);
  });

  it('should leave an installed agent unchanged', async () => {
    const commands: string[][] = [];
    const service = new AgentInstallService({
      readConfig: () => ({
        agents: {
          list: [
            {
              id: 'data',
              workspace: '/workspace/data',
              identity: { name: 'Data', avatar: 'avatar.png' },
            },
          ],
        },
      }),
      async runOpenClawCommand(args) {
        commands.push(args);
        return successfulResult();
      },
    });

    const result = await service.install({ manifest, workspaceDir: '/workspace/data' });

    assert.deepEqual(result.actions, []);
    assert.deepEqual(commands, []);
  });

  it('should reconcile identity without re-adding the agent', async () => {
    let identity = { name: 'Other', avatar: 'other.png' };
    const commands: string[][] = [];
    const service = new AgentInstallService({
      readConfig: () => ({
        agents: { list: [{ id: 'data', workspace: '/workspace/data', identity }] },
      }),
      async runOpenClawCommand(args) {
        commands.push(args);
        identity = { name: 'Data', avatar: 'avatar.png' };
        return successfulResult();
      },
    });

    const result = await service.install({ manifest, workspaceDir: '/workspace/data' });

    assert.deepEqual(result.actions, ['set-identity']);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.[1], 'set-identity');
  });

  it('should identify the implicit main agent without adding it', async () => {
    let config: OpenClawConfig = {
      agents: { defaults: { workspace: '/workspace/main' } },
    };
    const commands: string[][] = [];
    const service = new AgentInstallService({
      readConfig: () => config,
      async runOpenClawCommand(args) {
        commands.push(args);
        config = {
          agents: {
            defaults: { workspace: '/workspace/main' },
            list: [
              {
                id: 'main',
                identity: { name: 'Main' },
              },
            ],
          },
        };
        return successfulResult();
      },
    });

    const result = await service.install({
      manifest: { schemaVersion: 1, agent: { id: 'main', name: 'Main' } },
      workspaceDir: '/workspace/main',
    });

    assert.deepEqual(result.actions, ['set-identity']);
    assert.equal(commands[0]?.[1], 'set-identity');
  });

  it('should reject an existing agent bound to another workspace', async () => {
    const service = new AgentInstallService({
      readConfig: () => ({
        agents: { list: [{ id: 'data', workspace: '/workspace/other' }] },
      }),
      async runOpenClawCommand() {
        throw new Error('command should not run');
      },
    });

    await assert.rejects(
      service.install({ manifest, workspaceDir: '/workspace/data' }),
      /refusing to replace it/,
    );
  });

  it('should require a manifest display name', async () => {
    const service = new AgentInstallService({
      readConfig: () => ({}),
      async runOpenClawCommand() {
        return successfulResult();
      },
    });

    await assert.rejects(
      service.install({
        manifest: { schemaVersion: 1, agent: { id: 'data' } },
        workspaceDir: '/workspace/data',
      }),
      AgentInstallError,
    );
  });

  it('should validate stored op access before reading or mutating openclaw state', async () => {
    let configReads = 0;
    let commands = 0;
    const service = new AgentInstallService({
      credentialManager: {
        async validateStoredForInstall(inputManifest) {
          assert.deepEqual(inputManifest.environment?.op, ['private-environment-id']);
          return {
            status: 'invalid',
            code: 'op-credential-not-stored',
            message: 'Set the credential first.',
          };
        },
      },
      readConfig: () => {
        configReads += 1;
        return {};
      },
      async runOpenClawCommand() {
        commands += 1;
        return successfulResult();
      },
    });

    await assert.rejects(
      service.install({
        manifest: { ...manifest, environment: { op: ['private-environment-id'] } },
        workspaceDir: '/workspace/data',
      }),
      (error: unknown) => {
        assert.equal(error instanceof AgentInstallError, true);
        if (error instanceof AgentInstallError) {
          assert.equal(error.code, 'op-credential-not-stored');
          assert.equal(error.message, 'Set the credential first.');
        }
        return true;
      },
    );
    assert.equal(configReads, 0);
    assert.equal(commands, 0);
  });

  it('should surface openclaw command failures', async () => {
    const service = new AgentInstallService({
      readConfig: () => ({}),
      async runOpenClawCommand() {
        return { code: 1, stdout: '', stderr: 'agent add failed' };
      },
    });

    await assert.rejects(
      service.install({ manifest, workspaceDir: '/workspace/data' }),
      /agent add failed/,
    );
  });

  it('should reject a successful command that does not reconcile openclaw state', async () => {
    const service = new AgentInstallService({
      readConfig: () => ({}),
      async runOpenClawCommand() {
        return successfulResult();
      },
    });

    await assert.rejects(
      service.install({ manifest, workspaceDir: '/workspace/data' }),
      /did not match its manifest after installation/,
    );
  });
});
