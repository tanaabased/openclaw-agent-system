import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import createSetupCommandRunner, {
  SetupCommandError,
  type SetupExecutionContext,
} from '../agent/setup-runner.ts';
import type { AgentSetupCommand, AgentSetupShell } from '../manifest/setup-schema.ts';

type HostRunner = Parameters<typeof createSetupCommandRunner>[0]['runCommandWithTimeout'];
type HostResult = Awaited<ReturnType<HostRunner>>;
const success: HostResult = {
  code: 0,
  killed: false,
  signal: null,
  stdout: '',
  stderr: '',
  termination: 'exit',
};

describe('agent/setup-runner', () => {
  let root: string;
  let workspace: string;
  let temporaryDirectory: string;
  let hostBin: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'setup-runner-test-')));
    workspace = join(root, 'workspace');
    temporaryDirectory = join(root, 'temporary');
    hostBin = join(root, 'host-bin');
    await Promise.all([workspace, temporaryDirectory, hostBin].map((path) => mkdir(path)));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  function context(): SetupExecutionContext {
    return { workspaceDir: workspace, executableDirectories: [hostBin, '/bin', '/usr/bin'] };
  }

  function shell(script = 'exit 0', selected: AgentSetupShell = 'sh'): AgentSetupCommand {
    return { kind: 'shell', shell: selected, script, timeoutSeconds: 7 };
  }

  function runner(runCommandWithTimeout: HostRunner, baseEnvironment: NodeJS.ProcessEnv = {}) {
    return createSetupCommandRunner({ runCommandWithTimeout, baseEnvironment, temporaryDirectory });
  }

  async function executable(path: string, contents = '#!/bin/sh\nexit 0\n') {
    await writeFile(path, contents, { mode: 0o700 });
  }

  const runProcess: HostRunner = async (argv, options) => {
    assert.ok(typeof options === 'object');
    const result = spawnSync(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: typeof options.maxOutputBytes === 'number' ? options.maxOutputBytes : undefined,
    });
    if (result.error) throw result.error;
    return {
      ...success,
      code: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };

  it('should keep scripts private and exact, close stdin, and bound host execution', async () => {
    const script = 'printf "%s" "$HOME"\nexit 1\n';
    const controller = new AbortController();
    const run = runner(async (argv, options) => {
      assert.ok(typeof options === 'object');
      const path = argv.at(-1)!;
      assert.equal(await readFile(path, 'utf8'), script);
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      assert.equal((await lstat(dirname(path))).mode & 0o777, 0o700);
      assert.equal(options.cwd, workspace);
      assert.equal(options.input, '');
      assert.deepEqual(options.baseEnv, {});
      assert.equal(options.timeoutMs, 7_000);
      assert.equal(options.maxOutputBytes, 65_536);
      assert.equal(options.maxCombinedOutputBytes, 65_536);
      assert.equal(options.killProcessTree, true);
      assert.equal(options.killGraceMs, 100);
      assert.equal(options.outputCapture, 'head');
      assert.equal(options.signal, controller.signal);
      return { ...success, code: 1, stdout: 'private output', stderr: 'private error' };
    });
    assert.deepEqual(await run(shell(script), context(), controller.signal), {
      exitCode: 1,
      timedOut: false,
      truncated: false,
    });
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });

  it('should select fixed wrappers without using managed launcher overrides', async () => {
    const expected = {
      sh: ['-e'],
      bash: ['--noprofile', '--norc', '-e', '-o', 'pipefail'],
      zsh: ['-f', '-e', '-o', 'PIPE_FAIL'],
    };
    const launchers = join(root, 'launchers');
    await mkdir(launchers);
    for (const selected of ['sh', 'bash', 'zsh'] as const) {
      await executable(join(hostBin, selected));
      await executable(join(launchers, selected));
      const run = runner(async (argv) => {
        assert.equal(argv[0], join(hostBin, selected));
        assert.deepEqual(argv.slice(1, -1), expected[selected]);
        return success;
      });
      await run(shell('exit 0', selected), {
        ...context(),
        commandBinding: {
          launcherDirectory: launchers,
          launcherBindings: {},
          authority: 'authority',
          capability: 'capability',
        },
      });
    }
  });

  for (const selected of ['sh', 'bash', 'zsh'] as const) {
    it(`should stop on failed commands and ignore user startup files in ${selected}`, async function () {
      try {
        await access(`/bin/${selected}`, 1);
      } catch {
        this.skip();
      }
      const home = join(root, 'home');
      await mkdir(home);
      for (const name of ['.profile', '.bashrc', '.bash_profile', '.zshenv', '.zshrc']) {
        await writeFile(join(home, name), 'exit 99\n');
      }
      const startup = join(root, 'startup');
      await writeFile(startup, 'exit 98\n');
      const run = runner(runProcess, {
        HOME: home,
        BASH_ENV: startup,
        ENV: startup,
        ZDOTDIR: home,
      });
      const result = await run(shell('false\nprintf reached > reached', selected), context());
      assert.equal(result.exitCode, 1);
      await assert.rejects(access(join(workspace, 'reached')));
      assert.equal(
        (await run(shell('if read value; then exit 97; fi\nexit 0', selected), context())).exitCode,
        0,
      );
      assert.deepEqual(await readdir(temporaryDirectory), []);
    });

    it(`should apply the declared pipeline failure behavior in ${selected}`, async function () {
      try {
        await access(`/bin/${selected}`, 1);
      } catch {
        this.skip();
      }
      const result = await runner(runProcess)(shell('false | true', selected), context());
      if (selected === 'sh') assert.equal(result.exitCode, 0);
      else assert.equal(result.exitCode, 1);
    });
  }

  it('should preserve direct argument boundaries without shell interpolation', async () => {
    const path = join(workspace, 'helper');
    await executable(path);
    const args = ['', 'two words', '$HOME', 'a|b', 'line\nbreak'];
    const command: AgentSetupCommand = {
      kind: 'exec',
      executable: './helper',
      args,
      timeoutSeconds: 12,
    };
    const run = runner(async (argv, options) => {
      assert.deepEqual(argv, [path, ...args]);
      assert.ok(typeof options === 'object');
      assert.equal(options.timeoutMs, 12_000);
      return success;
    });
    await run(command, context());
    assert.deepEqual(command.args, args);
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });

  it('should preserve the selected shell invocation name through host symlinks', async () => {
    await symlink('/bin/bash', join(hostBin, 'sh'));
    const run = runner(async (argv) => {
      assert.equal(argv[0], join(hostBin, 'sh'));
      return success;
    });
    await run(shell(), context());
  });

  it('should retain the private script until the host process lifecycle settles', async () => {
    const started = Promise.withResolvers<string>();
    const finished = Promise.withResolvers<HostResult>();
    const run = runner(async (argv) => {
      started.resolve(argv.at(-1)!);
      return finished.promise;
    });
    const execution = run(shell('exit 0'), context());
    const path = await started.promise;
    assert.equal(await readFile(path, 'utf8'), 'exit 0');
    finished.resolve(success);
    await execution;
    await assert.rejects(access(path));
  });

  it('should allow only baseline environment and explicitly supplied command binding', async () => {
    const launchers = join(root, 'launchers');
    await mkdir(launchers);
    await executable(join(launchers, 'gh'));
    await executable(join(hostBin, 'gh'));
    const base = {
      HOME: root,
      LANG: 'C',
      GH_TOKEN: 'secret',
      OP_SERVICE_ACCOUNT_TOKEN: 'secret',
      SSH_AUTH_SOCK: 'ambient',
      PATH: workspace,
      BASH_ENV: 'startup',
      NODE_OPTIONS: '--inspect',
      AGENT_SYSTEM_EXEC_CAPABILITY: 'ambient',
    };
    const run = runner(async (argv, options) => {
      assert.equal(argv[0], join(launchers, 'gh'));
      assert.ok(typeof options === 'object');
      assert.deepEqual(options.env, {
        HOME: root,
        LANG: 'C',
        PATH: [launchers, hostBin, await realpath('/bin'), await realpath('/usr/bin')].join(':'),
        AGENT_SYSTEM_EXEC_AUTHORITY: 'selected-authority',
        AGENT_SYSTEM_EXEC_CAPABILITY: 'selected-capability',
        AGENT_SYSTEM_GH: join(launchers, 'agent-system-gh'),
      });
      return success;
    }, base);
    await run(
      { kind: 'exec', executable: 'gh', args: [], timeoutSeconds: 1 },
      {
        ...context(),
        commandBinding: {
          launcherDirectory: launchers,
          launcherBindings: {
            AGENT_SYSTEM_GH: join(launchers, 'agent-system-gh'),
          },
          authority: 'selected-authority',
          capability: 'selected-capability',
        },
      },
    );
    assert.equal(base.GH_TOKEN, 'secret');
  });

  it('should omit openclaw process state from standalone adapters', async () => {
    await executable(join(hostBin, 'helper'));
    const run = createSetupCommandRunner({
      baseEnvironment: {
        HOME: root,
        OPENCLAW_PROFILE: 'operator',
        OPENCLAW_STATE_DIR: join(root, 'openclaw-state'),
        OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json'),
      },
      inheritOpenClawEnvironment: false,
      temporaryDirectory,
      runCommandWithTimeout: async (_argv, options) => {
        assert.deepEqual(options.env, { HOME: root, PATH: hostBin });
        return success;
      },
    });
    await run(
      { kind: 'exec', executable: 'helper', args: [], timeoutSeconds: 1 },
      { workspaceDir: workspace, executableDirectories: [hostBin] },
    );
  });

  it('should exclude relative, empty, and workspace search directories including symlink aliases', async () => {
    const alias = join(root, 'alias');
    await symlink(workspace, alias);
    await executable(join(workspace, 'helper'));
    await executable(join(hostBin, 'helper'));
    const run = runner(async (argv, options) => {
      assert.equal(argv[0], join(hostBin, 'helper'));
      assert.ok(typeof options === 'object');
      assert.equal(options.env?.PATH, hostBin);
      return success;
    });
    await run(
      { kind: 'exec', executable: 'helper', args: [], timeoutSeconds: 1 },
      {
        workspaceDir: workspace,
        executableDirectories: ['', '.', workspace, alias, hostBin],
      },
    );
  });

  it('should reject traversal, symlinks, nonexecutables, and writable workspace executables before launch', async () => {
    await executable(join(workspace, 'helper'));
    await symlink(join(workspace, 'helper'), join(workspace, 'linked'));
    await symlink(workspace, join(workspace, 'linked-directory'));
    await executable(join(workspace, 'writable'));
    await chmod(join(workspace, 'writable'), 0o777);
    await writeFile(join(workspace, 'not-executable'), 'exit 0', { mode: 0o600 });
    const run = runner(async () => {
      assert.fail('unsafe command launched');
    });
    for (const path of [
      '../host-bin/helper',
      './linked',
      './linked-directory/helper',
      './writable',
      './not-executable',
      './missing',
      './',
    ]) {
      await assert.rejects(
        run({ kind: 'exec', executable: path, args: [], timeoutSeconds: 1 }, context()),
        SetupCommandError,
      );
    }
  });

  it('should fail when the selected shell is missing without falling back', async () => {
    const run = runner(async () => {
      assert.fail('missing shell launched');
    });
    await assert.rejects(run(shell(), { ...context(), executableDirectories: [] }), {
      code: 'setup-shell-unavailable',
    });
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });

  it('should sanitize launch errors and clean scripts after failure, timeout, and cancellation', async () => {
    const results: HostResult[] = [
      { ...success, code: 124, termination: 'timeout' },
      { ...success, code: null, termination: 'signal' },
      { ...success, stdoutTruncatedBytes: 50 },
    ];
    for (const result of results) {
      const output = await runner(async () => result)(shell(), context());
      assert.deepEqual(output, {
        exitCode: result.termination === 'timeout' ? null : result.code,
        timedOut: result.termination === 'timeout',
        truncated: Boolean(result.stdoutTruncatedBytes),
      });
      assert.deepEqual(await readdir(temporaryDirectory), []);
    }
    await assert.rejects(
      runner(async () => {
        throw new Error('secret command and output');
      })(shell(), context()),
      (error: unknown) => {
        assert.ok(error instanceof SetupCommandError);
        assert.equal(error.code, 'setup-execution-failed');
        assert.equal(JSON.stringify(error).includes('secret'), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.deepEqual(await readdir(temporaryDirectory), []);
  });
});
