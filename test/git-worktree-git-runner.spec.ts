import assert from 'node:assert/strict';

import GitWorktreeGitRunnerFactory from '../tools/git/worktree-git-runner.ts';

describe('tools/git/worktree-git-runner', () => {
  it('should acquire ssh only for remote preparation and redact resource secrets', async () => {
    const events: string[] = [];
    const requests: Array<{ argv: string[]; environment: NodeJS.ProcessEnv }> = [];
    const factory = new GitWorktreeGitRunnerFactory({
      baseEnvironment: { PATH: '/usr/bin', SHOULD_NOT_INHERIT: 'private' },
      async runCli(request) {
        requests.push({ argv: request.argv, environment: request.environment });
        return {
          exitCode: 0,
          resolvedExecutable: '/usr/bin/git',
          stderr: 'private-key-material stderr',
          stdout: 'private-key-material stdout',
          timedOut: false,
          truncated: false,
        };
      },
      sshResourceService: {
        async acquire() {
          events.push('acquire');
          return {
            async dispose() {
              events.push('dispose');
            },
            environment: { GIT_SSH: '/package/bin/agent-system-ssh' },
            sensitiveValues: ['private-key-material'],
          };
        },
      },
    });
    const configuration = {
      externalExtensions: [],
      identity: { email: 'data@example.com', name: 'Data' },
      ssh: { privateKeys: [{ fromEnvironment: 'SSH_KEY' }] },
    };

    const local = await factory.acquire(
      configuration,
      { resolveEnvironment: () => undefined, workspaceDir: '/workspace' },
      { authentication: false },
    );
    await local.git.run({ argv: ['status'], cwd: '/workspace' });
    await local.dispose();
    assert.deepEqual(events, []);

    const remote = await factory.acquire(
      configuration,
      { resolveEnvironment: () => 'private-key-material', workspaceDir: '/workspace' },
      { authentication: true },
    );
    const result = await remote.git.run({ argv: ['fetch', 'origin'], cwd: '/workspace' });
    await remote.dispose();

    assert.deepEqual(events, ['acquire', 'dispose']);
    assert.equal(result.stdout, '[REDACTED] stdout');
    assert.equal(result.stderr, '[REDACTED] stderr');
    assert.equal(requests[1]?.environment.GIT_SSH, '/package/bin/agent-system-ssh');
    assert.equal(requests[1]?.environment.GIT_AUTHOR_EMAIL, 'data@example.com');
    assert.equal(requests[1]?.environment.SHOULD_NOT_INHERIT, undefined);
  });
});

describe('git transfer execution budget', () => {
  it('should allow slow fetch work while keeping metadata probes bounded separately', async () => {
    const durations: number[] = [];
    const factory = new GitWorktreeGitRunnerFactory({
      baseEnvironment: { PATH: '/usr/bin' },
      async runCli(request) {
        durations.push(request.timeoutMs);
        const elapsed = request.argv[0] === 'fetch' ? 75_000 : 10;
        return {
          exitCode: 0,
          stderr: '',
          stdout: '',
          timedOut: request.timeoutMs < elapsed,
          truncated: false,
        };
      },
    });
    const lease = await factory.acquire(
      { externalExtensions: [], identity: { email: 'data@example.com', name: 'Data' } },
      { resolveEnvironment: () => undefined, workspaceDir: '/workspace' },
    );
    await lease.git.run({ argv: ['rev-parse', 'HEAD'], cwd: '/workspace' });
    await lease.git.run({ argv: ['fetch', 'origin'], cwd: '/workspace' });
    await lease.dispose();
    assert.ok(durations[0]! < durations[1]!);
  });
});

describe('git worktree caller execution deadline', () => {
  it('should share the caller budget across preparation and transfer instead of renewing it', async () => {
    let now = 0;
    const budgets: number[] = [];
    const controller = new AbortController();
    const factory = new GitWorktreeGitRunnerFactory({
      baseEnvironment: { PATH: '/usr/bin' },
      now: () => now,
      async runCli(request) {
        assert.equal(request.signal, controller.signal);
        budgets.push(request.timeoutMs);
        now += 10_000;
        return { exitCode: 0, stderr: '', stdout: '', timedOut: false, truncated: false };
      },
    });
    const lease = await factory.acquire(
      { externalExtensions: [], identity: { email: 'data@example.com', name: 'Data' } },
      {
        resolveEnvironment: () => undefined,
        workspaceDir: '/workspace',
        executionDeadline: 900_000,
        signal: controller.signal,
      },
    );
    await lease.git.run({ argv: ['rev-parse', 'HEAD'], cwd: '/workspace' });
    await lease.git.run({ argv: ['fetch', 'origin'], cwd: '/workspace' });
    assert.deepEqual(budgets, [900_000, 890_000]);
    controller.abort();
    await assert.rejects(lease.git.run({ argv: ['fetch', 'origin'], cwd: '/workspace' }));
    assert.equal(budgets.length, 2);
    await lease.dispose();
  });
});
