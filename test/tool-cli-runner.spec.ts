import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import createToolCliRunner, { resolveToolExecutable } from '../api/cli-runner.ts';

type HostRunner = Parameters<typeof createToolCliRunner>[0];
type HostResult = Awaited<ReturnType<HostRunner>>;

const successfulResult: HostResult = {
  code: 0,
  killed: false,
  signal: null,
  stderr: '',
  stdout: '',
  termination: 'exit',
};

describe('api/cli-runner', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-runner-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true });
  });

  it('should skip workspace command overrides and resolve the next real executable', async () => {
    const workspaceBin = join(root, 'workspace-bin');
    const systemBin = join(root, 'system-bin');
    await mkdir(workspaceBin);
    await mkdir(systemBin);
    await writeFile(join(workspaceBin, 'gh'), '#!/bin/sh\n');
    await writeFile(join(systemBin, 'gh'), '#!/bin/sh\n');
    await chmod(join(workspaceBin, 'gh'), 0o755);
    await chmod(join(systemBin, 'gh'), 0o755);

    const executable = await resolveToolExecutable(
      'gh',
      [workspaceBin, systemBin].join(delimiter),
      [workspaceBin],
    );

    assert.equal(executable, await realpath(join(systemBin, 'gh')));
  });

  it('should follow external executable symlinks without permitting a workspace command bypass', async () => {
    const bin = join(root, 'bin');
    const workspaceBin = join(root, 'workspace-bin');
    await mkdir(bin);
    await mkdir(workspaceBin);
    await symlink('/usr/bin/true', join(bin, 'gh'));
    await symlink('/usr/bin/false', join(workspaceBin, 'gh'));

    assert.equal(await resolveToolExecutable('gh', bin), await realpath('/usr/bin/true'));
    assert.equal(
      await resolveToolExecutable('gh', [workspaceBin, bin].join(delimiter), [workspaceBin]),
      await realpath('/usr/bin/true'),
    );
  });

  function request() {
    return {
      argv: ['--version'],
      cwd: root,
      environment: { PATH: '/usr/bin', DECLARED_VALUE: 'selected' },
      executable: '/usr/bin/true',
      maxOutputBytes: 1024,
      timeoutMs: 1000,
    };
  }

  it('should delegate the selected executable with an isolated environment and bounded lifecycle', async () => {
    const controller = new AbortController();
    const executable = await realpath('/usr/bin/true');
    const input = { ...request(), signal: controller.signal, stdin: 'request-body' };
    const runCli = createToolCliRunner(async (argv, options) => {
      assert.deepEqual(argv, [executable, '--version']);
      assert.deepEqual(options, {
        baseEnv: {},
        cwd: root,
        env: { PATH: '/usr/bin', DECLARED_VALUE: 'selected' },
        input: 'request-body',
        killGraceMs: 100,
        killProcessTree: true,
        maxCombinedOutputBytes: 1024,
        maxOutputBytes: 1024,
        outputCapture: 'head',
        signal: controller.signal,
        timeoutMs: 1000,
      });
      return { ...successfulResult, stdout: 'selected' };
    });

    assert.deepEqual(await runCli(input), {
      exitCode: 0,
      resolvedExecutable: executable,
      stderr: '',
      stdout: 'selected',
      timedOut: false,
      truncated: false,
    });
  });

  it('should close stdin when no command input is supplied', async () => {
    const runCli = createToolCliRunner(async (_argv, options) => {
      assert.ok(typeof options === 'object');
      assert.equal(options.input, '');
      return successfulResult;
    });

    await runCli(request());
  });

  it('should retain output and report truncation from either stream', async () => {
    for (const truncation of [{ stdoutTruncatedBytes: 1 }, { stderrTruncatedBytes: 2 }]) {
      const runCli = createToolCliRunner(async () => ({
        ...successfulResult,
        ...truncation,
        code: 3,
        stdout: 'abc',
        stderr: 'd',
      }));
      const result = await runCli(request());

      assert.equal(result.exitCode, 3);
      assert.equal(result.stdout, 'abc');
      assert.equal(result.stderr, 'd');
      assert.equal(result.truncated, true);
      assert.equal(result.timedOut, false);
    }
  });

  it('should preserve the timeout result contract without exposing the host timeout exit code', async () => {
    for (const termination of ['timeout', 'no-output-timeout'] as const) {
      const runCli = createToolCliRunner(async () => ({
        ...successfulResult,
        code: 124,
        termination,
      }));
      const result = await runCli(request());

      assert.equal(result.exitCode, null);
      assert.equal(result.timedOut, true);
    }
  });

  it('should pass cancellation to the host without classifying it as a timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const runCli = createToolCliRunner(async (_argv, options) => {
      assert.ok(typeof options === 'object');
      assert.equal(options.signal, controller.signal);
      return { ...successfulResult, code: null, termination: 'signal' };
    });
    const result = await runCli({ ...request(), signal: controller.signal });

    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
  });

  it('should wait for host settlement before returning control to resource owners', async () => {
    const started = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<HostResult>();
    const runCli = createToolCliRunner(async () => {
      started.resolve();
      return settled.promise;
    });
    let returned = false;
    const execution = runCli(request()).then((result) => {
      returned = true;
      return result;
    });
    await started.promise;
    assert.equal(returned, false);

    settled.resolve(successfulResult);
    assert.equal((await execution).exitCode, 0);
  });

  it('should propagate host launch failures to the owning error boundary', async () => {
    const failure = new Error('launch failed');
    const runCli = createToolCliRunner(async () => {
      throw failure;
    });

    await assert.rejects(runCli(request()), (error) => error === failure);
  });
});
