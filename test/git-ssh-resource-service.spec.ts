import assert from 'node:assert/strict';

import AgentSystemToolError from '../lib/tool-error.ts';
import GitSshResourceService from '../tools/git/ssh-resource-service.ts';
import type { CredentialCommandOptions } from '../utils/run-credential-command.ts';

const privateKey =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----';
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest agent-system';

describe('tools/git/ssh-resource-service', () => {
  it('should expose only an isolated socket, public selectors, and the managed ssh launcher', async () => {
    const events: string[] = [];
    const commands: CredentialCommandOptions[] = [];
    const writes = new Map<string, string>();
    const service = new GitSshResourceService({
      baseEnvironment: { HOME: '/home/data', PATH: '/system/bin', SHOULD_NOT_INHERIT: 'private' },
      createTemporaryDirectory: async () => {
        events.push('create');
        return '/tmp/as-ssh-test';
      },
      launcherPath: '/package/bin/agent-system-ssh',
      loadPrivateKeys: async (_sources, context) => {
        assert.equal(context.resolveEnvironment('GIT_SSH_PRIVATE_KEY'), privateKey);
        return [privateKey];
      },
      removeTemporaryDirectory: async (path) => {
        events.push(`remove:${path}`);
      },
      resolveExecutable: async (name) => `/system/bin/${name}`,
      async runCommand(options) {
        commands.push(options);
        return options.args[0] === '-L'
          ? {
              exitCode: 0,
              status: 'completed',
              stderr: Buffer.alloc(0),
              stdout: Buffer.from(`${publicKey}\n`),
            }
          : {
              exitCode: 0,
              status: 'completed',
              stderr: Buffer.alloc(0),
              stdout: Buffer.alloc(0),
            };
      },
      secureTemporaryDirectory: async (path) => {
        events.push(`secure:${path}`);
      },
      startAgent: async (options) => {
        events.push(`start:${options.executable}:${options.socketPath}`);
        assert.equal(options.environment.SHOULD_NOT_INHERIT, undefined);
        return {
          dispose: async () => {
            events.push('stop');
          },
          socketPath: options.socketPath,
        };
      },
      writePrivateFile: async (path, contents) => {
        writes.set(path, contents);
      },
    });

    const lease = await service.acquire(
      { privateKeys: [{ fromEnvironment: 'GIT_SSH_PRIVATE_KEY' }] },
      {
        resolveEnvironment: (name) => (name === 'GIT_SSH_PRIVATE_KEY' ? privateKey : undefined),
        workspaceDir: '/workspace',
      },
    );

    assert.deepEqual(lease.environment, {
      AGENT_SYSTEM_SSH_CONFIG: '/tmp/as-ssh-test/c',
      AGENT_SYSTEM_SSH_EXECUTABLE: '/system/bin/ssh',
      GIT_SSH: '/package/bin/agent-system-ssh',
      GIT_SSH_VARIANT: 'ssh',
      SSH_ASKPASS_REQUIRE: 'never',
      SSH_AUTH_SOCK: '/tmp/as-ssh-test/a',
    });
    assert.deepEqual(lease.sensitiveValues, [privateKey]);
    assert.deepEqual(
      commands.map(({ args, command }) => ({ args, command })),
      [
        { args: ['-'], command: '/system/bin/ssh-add' },
        { args: ['-L'], command: '/system/bin/ssh-add' },
      ],
    );
    assert.equal(commands[0]?.input, `${privateKey}\n`);
    assert.equal(commands[0]?.environment?.SSH_AUTH_SOCK, '/tmp/as-ssh-test/a');
    assert.equal(commands[0]?.environment?.SHOULD_NOT_INHERIT, undefined);
    assert.equal(writes.get('/tmp/as-ssh-test/k0.pub'), `${publicKey}\n`);
    const sshConfig = writes.get('/tmp/as-ssh-test/c') ?? '';
    assert.match(sshConfig, /IdentitiesOnly yes/u);
    assert.match(sshConfig, /IdentityAgent "\/tmp\/as-ssh-test\/a"/u);
    assert.match(sshConfig, /IdentityFile "\/tmp\/as-ssh-test\/k0\.pub"/u);
    assert.equal(
      [...writes.values()].some((value) => value.includes(privateKey)),
      false,
    );

    await lease.dispose();
    assert.deepEqual(events.slice(-2), ['stop', 'remove:/tmp/as-ssh-test']);
  });

  it('should clean partial resources and return a stable error for locked keys', async () => {
    const events: string[] = [];
    const service = new GitSshResourceService({
      baseEnvironment: { PATH: '/system/bin' },
      createTemporaryDirectory: async () => '/tmp/as-ssh-test',
      launcherPath: '/package/bin/agent-system-ssh',
      loadPrivateKeys: async () => [privateKey],
      removeTemporaryDirectory: async () => {
        events.push('remove');
      },
      resolveExecutable: async (name) => `/system/bin/${name}`,
      runCommand: async () => ({
        exitCode: 1,
        status: 'completed',
        stderr: Buffer.from('Enter passphrase for private key'),
        stdout: Buffer.alloc(0),
      }),
      secureTemporaryDirectory: async () => undefined,
      startAgent: async (options) => ({
        dispose: async () => {
          events.push('stop');
        },
        socketPath: options.socketPath,
      }),
      writePrivateFile: async () => undefined,
    });

    await assert.rejects(
      service.acquire(
        { privateKeys: [{ fromEnvironment: 'GIT_SSH_PRIVATE_KEY' }] },
        { resolveEnvironment: () => privateKey, workspaceDir: '/workspace' },
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'credential_unavailable',
    );
    assert.deepEqual(events, ['stop', 'remove']);
  });

  it('should report exactly which openssh executables are unavailable', async () => {
    const service = new GitSshResourceService({
      baseEnvironment: { PATH: '/system/bin' },
      launcherPath: '/package/bin/agent-system-ssh',
      resolveExecutable: async (name) => {
        if (name !== 'ssh') throw new Error('missing');
        return `/system/bin/${name}`;
      },
    });

    assert.deepEqual(await service.inspectDependencies(), { missing: ['ssh-agent', 'ssh-add'] });
  });
});
