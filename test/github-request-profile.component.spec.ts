import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import createToolCliRunner, { resolveToolExecutable } from '../api/cli-runner.ts';

type HostRunner = Parameters<typeof createToolCliRunner>[0];
const success: Awaited<ReturnType<HostRunner>> = {
  code: 0,
  killed: false,
  signal: null,
  stdout: 'raw debug',
  stderr: 'raw debug',
  termination: 'exit',
};

describe('api/cli-runner github profiling', () => {
  let root = '';
  let executable = '';
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'github-profile-')));
    executable = join(root, 'gh');
    await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function request() {
    return {
      executable,
      argv: ['api', 'user'],
      cwd: root,
      environment: { PATH: root, AGENT_SYSTEM_GITHUB_PROFILE_DIR: join(root, 'untrusted') },
      maxOutputBytes: 64,
      timeoutMs: 1000,
      stdin: 'original input',
      githubProfileContext: { agentId: 'bot', account: 'test-bot', source: 'account' },
    };
  }

  async function saved(directory: string) {
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1);
    return JSON.parse(await readFile(join(directory, files[0]!), 'utf8'));
  }

  it('should remain inactive when only the child environment requests profiling', async () => {
    const run = createToolCliRunner(async (_argv, options) => {
      assert.equal(typeof options, 'object');
      assert.ok(options && typeof options === 'object');
      assert.equal(options.onOutputChunk, undefined);
      assert.equal(options.outputCapture, 'head');
      assert.equal(options.env?.GH_DEBUG, undefined);
      return success;
    }, '');
    assert.equal((await run(request())).stderr, 'raw debug');
    assert.deepEqual(await readdir(root), ['gh']);
  });

  it('should bypass the ci profiling shim to avoid double counting', async () => {
    const directory = join(root, 'profile');
    const shim = join(directory, 'bin');
    await mkdir(shim, { recursive: true });
    await writeFile(join(shim, 'gh'), '#!/bin/sh\n', { mode: 0o700 });
    const run = createToolCliRunner(async (argv) => {
      assert.equal(argv[0], executable);
      return success;
    }, directory);
    await run({ ...request(), executable: 'gh', environment: { PATH: `${shim}:${root}` } });
  });

  it('should select native gh for a forwarder running without the ci environment', async () => {
    const directory = join(root, 'profile');
    const shim = join(directory, 'bin');
    await mkdir(shim, { recursive: true });
    await writeFile(executable, '#!/bin/sh\nprintf "native github\\n"\n', { mode: 0o700 });
    await writeFile(
      join(shim, 'gh'),
      `#!/bin/sh\nexec "${process.execPath}" --import tsx scripts/github-profile-command.ts "${executable}" "$@"\n`,
      { mode: 0o700 },
    );
    const environment = { PATH: `${shim}:${root}:/usr/bin:/bin` };
    const invoke = (command: string) =>
      new Promise<{ code: number | string; stdout: string }>((resolve, reject) => {
        execFile(command, ['api', 'user'], { env: environment, timeout: 5000 }, (error, stdout) => {
          if (error && typeof error.code !== 'number') reject(error);
          else resolve({ code: error?.code ?? 0, stdout });
        });
      });
    assert.equal((await invoke(join(shim, 'gh'))).code, 1);
    const native = await resolveToolExecutable('gh', environment.PATH, [shim]);
    assert.deepEqual(await invoke(native), { code: 0, stdout: 'native github\n' });
  });

  it('should leave other executables untouched when profiling is enabled', async () => {
    const other = join(root, 'git');
    await writeFile(other, '#!/bin/sh\n', { mode: 0o700 });
    const run = createToolCliRunner(
      async (_argv, options) => {
        assert.ok(options && typeof options === 'object');
        assert.equal(options.onOutputChunk, undefined);
        assert.equal(options.env?.GH_DEBUG, undefined);
        return success;
      },
      join(root, 'profile'),
    );
    assert.equal((await run({ ...request(), executable: other })).stdout, success.stdout);
    assert.deepEqual((await readdir(root)).sort(), ['gh', 'git']);
  });

  it('should preserve execution inputs and ordinary output while storing only request metadata', async () => {
    const directory = join(root, 'profile');
    const controller = new AbortController();
    const run = createToolCliRunner(async (argv, options) => {
      assert.deepEqual(argv, [executable, 'api', 'user']);
      assert.ok(options && typeof options === 'object');
      assert.equal(options.env?.GH_DEBUG, '1');
      assert.equal(options.input, 'original input');
      assert.equal(options.timeoutMs, 1000);
      assert.equal(options.signal, controller.signal);
      options.onOutputChunk?.(
        Buffer.from('* Request to https://api.github.com/user?secret=hidden\n* Request took 2ms\n'),
        'stderr',
      );
      options.onOutputChunk?.(Buffer.from('test-bot\n'), 'stdout');
      options.onOutputChunk?.(Buffer.from('gh: denied\n'), 'stderr');
      return { ...success, code: 3, stdoutTruncatedBytes: 9999 };
    }, directory);
    const result = await run({
      ...request(),
      signal: controller.signal,
      environment: { PATH: root, GH_DEBUG: 'api' },
    });
    assert.equal(result.stdout, 'test-bot\n');
    assert.equal(result.stderr, 'gh: denied\n');
    assert.equal(result.exitCode, 3);
    assert.equal(result.truncated, false);
    const report = await saved(directory);
    assert.equal(report.account, 'test-bot');
    assert.equal(report.complete, true);
    assert.deepEqual(report.requests, [{ route: '/user', durationMs: 2 }]);
    assert.doesNotMatch(JSON.stringify(report), /hidden|secret|original input|raw debug|denied/);
  });

  it('should retain timeout status and mark the trace incomplete', async () => {
    const directory = join(root, 'profile');
    const run = createToolCliRunner(async (_argv, options) => {
      assert.ok(options && typeof options === 'object');
      options.onOutputChunk?.(Buffer.from('* Request to https://api.github.com/user\n'), 'stderr');
      return { ...success, termination: 'timeout' };
    }, directory);
    const result = await run(request());
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.equal((await saved(directory)).complete, false);
  });

  it('should retain operation labels and allowlisted response counters without storing headers or bodies', async () => {
    const directory = join(root, 'profile');
    const output =
      'HTTP/2 200 OK\nx-ratelimit-resource: core\nx-ratelimit-remaining: 4990\nx-ratelimit-used: 10\nx-ratelimit-reset: 1000\nx-private: header-secret\n\n{"private":"payload-secret"}';
    const run = createToolCliRunner(async (_argv, options) => {
      assert.ok(options && typeof options === 'object');
      options.onOutputChunk?.(Buffer.from(output), 'stdout');
      return success;
    }, directory);
    const result = await run({
      ...request(),
      maxOutputBytes: 1024,
      githubProfileContext: { account: 'bot', operation: 'configured-identity' },
    });
    assert.equal(result.stdout, output);
    const report = await saved(directory);
    assert.equal(report.operation, 'configured-identity');
    assert.deepEqual(report.response, {
      status: 200,
      resource: 'core',
      remaining: 4990,
      used: 10,
      resetAt: 1000000,
    });
    assert.doesNotMatch(JSON.stringify(report), /header-secret|payload-secret|x-private/);
  });

  it('should retain host cancellation errors and the partial trace', async () => {
    const directory = join(root, 'profile');
    const failure = new Error('cancelled');
    const run = createToolCliRunner(async (_argv, options) => {
      assert.ok(options && typeof options === 'object');
      options.onOutputChunk?.(Buffer.from('* Request to https://api.github.com/user\n'), 'stderr');
      throw failure;
    }, directory);
    await assert.rejects(run(request()), (error) => error === failure);
    assert.equal((await saved(directory)).complete, false);
  });

  it('should report an unusable output directory without failing the github command', async () => {
    const directory = join(root, 'public');
    await mkdir(directory);
    await chmod(directory, 0o755);
    let warnings = 0;
    const run = createToolCliRunner(
      async () => success,
      directory,
      () => {
        warnings++;
      },
    );
    assert.equal((await run(request())).exitCode, 0);
    assert.equal(warnings, 1);
    assert.deepEqual(await readdir(directory), []);
  });

  it('should profile a ci fixture command through the public sdk without changing stdin or exit status', async () => {
    const directory = join(root, 'profile');
    await writeFile(
      executable,
      '#!/bin/sh\nprintf "* Request to https://api.github.com/user\\n* Request took 2ms\\n" >&2\ncat\nexit 7\n',
      { mode: 0o700 },
    );
    const result = await new Promise<{ code: number | string; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = execFile(
          process.execPath,
          ['--import', 'tsx', 'scripts/github-profile-command.ts', executable, 'api', 'user'],
          {
            timeout: 5000,
            env: {
              PATH: '/usr/bin:/bin',
              GITHUB_ACTIONS: 'true',
              AGENT_SYSTEM_GITHUB_PROFILE_DIR: directory,
              GH_TOKEN: 'fixture-token',
              GH_TOKEN_TEST: 'fixture-token',
            },
          },
          (error, stdout, stderr) => {
            if (error && typeof error.code !== 'number') reject(error);
            else resolve({ code: error?.code ?? 0, stdout, stderr });
          },
        );
        child.stdin!.end('original fixture input');
      },
    );
    assert.deepEqual(result, { code: 7, stdout: 'original fixture input', stderr: '' });
    const report = await saved(directory);
    assert.equal(report.account, 'GH_TOKEN_TEST');
    assert.equal(report.source, 'fixture');
    assert.deepEqual(report.requests, [{ route: '/user', durationMs: 2 }]);
    assert.doesNotMatch(JSON.stringify(report), /fixture-token|original fixture input/);
  });
});
