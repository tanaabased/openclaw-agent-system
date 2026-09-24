import { access, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveToolExecutable } from '../api/cli-runner.ts';
import type { AgentSetupCommand, AgentSetupShell } from '../manifest/setup-schema.ts';
import isPathContained from '../utils/is-path-contained.ts';

const maximumOutputBytes = 65_536;
const inheritedEnvironmentNames = ['HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'] as const;
const inheritedOpenClawEnvironmentNames = [
  // Managed launchers must load the same OpenClaw profile as the installing operator.
  'OPENCLAW_PROFILE',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH',
] as const;
const shellArguments: Record<AgentSetupShell, readonly string[]> = {
  sh: ['-e'],
  bash: ['--noprofile', '--norc', '-e', '-o', 'pipefail'],
  zsh: ['-f', '-e', '-o', 'PIPE_FAIL'],
};

export interface SetupExecutionContext {
  workspaceDir: string;
  /** Trusted host search directories, never taken from the manifest or child environment. */
  executableDirectories: readonly string[];
  /** Supplied by the authority owner; this runner never selects or authenticates an agent. */
  commandBinding?: {
    launcherDirectory: string;
    authority: string;
    capability: string;
  };
}

export interface SetupCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface SetupProcessResult {
  code: number | null;
  killed: boolean;
  signal: NodeJS.Signals | null;
  stderr: string;
  stderrTruncatedBytes?: number;
  stdout: string;
  stdoutTruncatedBytes?: number;
  termination: 'exit' | 'signal' | 'timeout' | 'no-output-timeout';
}

export interface SetupProcessOptions {
  baseEnv: Readonly<NodeJS.ProcessEnv>;
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  input: string;
  killGraceMs: number;
  killProcessTree: boolean;
  maxCombinedOutputBytes: number;
  maxOutputBytes: number;
  outputCapture: 'head';
  signal?: AbortSignal;
  timeoutMs: number;
}

export type SetupProcessRunner = (
  argv: string[],
  options: SetupProcessOptions,
) => Promise<SetupProcessResult>;

export class SetupCommandError extends Error {
  override name = 'SetupCommandError';

  constructor(readonly code: string) {
    super(`Setup command failed (${code}).`);
  }
}

async function workspaceExecutable(workspaceDir: string, executable: string): Promise<string> {
  const path = resolve(workspaceDir, executable);
  if (!isPathContained(workspaceDir, path) || executable.split('/').includes('..')) {
    throw new SetupCommandError('setup-unsafe-executable');
  }
  let current = workspaceDir;
  for (const segment of relative(workspaceDir, path).split(sep)) {
    current = join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || (stats.mode & 0o022) !== 0) {
      throw new SetupCommandError('setup-unsafe-executable');
    }
  }
  if (!(await lstat(path)).isFile() || (await realpath(path)) !== path) {
    throw new SetupCommandError('setup-unsafe-executable');
  }
  await access(path, 1);
  return path;
}

async function hostDirectories(context: SetupExecutionContext, workspaceDir: string) {
  const directories: string[] = [];
  for (const directory of context.executableDirectories) {
    // Empty and relative PATH entries would allow the workspace to choose a command.
    if (!isAbsolute(directory) || isPathContained(workspaceDir, resolve(directory))) continue;
    try {
      const canonical = await realpath(directory);
      if (isPathContained(workspaceDir, canonical) || !(await lstat(canonical)).isDirectory()) {
        continue;
      }
      directories.push(canonical);
    } catch {
      // Missing host PATH entries are ordinary; lookup still fails if no executable exists.
    }
  }
  return directories;
}

async function resolveShell(
  shell: AgentSetupShell,
  directories: readonly string[],
  workspaceDir: string,
) {
  for (const directory of directories) {
    const candidate = join(directory, shell);
    try {
      await resolveToolExecutable(candidate, '', [workspaceDir]);
      // Preserve the invocation name: sh may be a symlink to bash, which selects its mode by argv[0].
      return candidate;
    } catch {
      // Continue the trusted host search without trying a different shell.
    }
  }
  throw new SetupCommandError('setup-shell-unavailable');
}

async function removeScript(directory: string) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    throw new SetupCommandError('setup-cleanup-failed');
  }
}

/** Run one normalized setup command without publishing its declaration, output, or host errors. */
export default function createSetupCommandRunner(dependencies: {
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  inheritOpenClawEnvironment?: boolean;
  runCommandWithTimeout: SetupProcessRunner;
  temporaryDirectory?: string;
}) {
  return async (
    command: AgentSetupCommand,
    context: SetupExecutionContext,
    signal?: AbortSignal,
  ): Promise<SetupCommandResult> => {
    let scriptDirectory: string | undefined;
    try {
      const workspaceDir = await realpath(context.workspaceDir);
      if (!(await lstat(workspaceDir)).isDirectory()) {
        throw new SetupCommandError('setup-invalid-workspace');
      }
      const directories = await hostDirectories(context, workspaceDir);
      const hostSearchDirectories = [...directories];
      const binding = context.commandBinding;
      if (binding) {
        if (!isAbsolute(binding.launcherDirectory)) {
          throw new SetupCommandError('setup-invalid-command-context');
        }
        const launchers = await realpath(binding.launcherDirectory);
        if (!(await lstat(launchers)).isDirectory()) {
          throw new SetupCommandError('setup-invalid-command-context');
        }
        directories.unshift(launchers);
      }
      const environment: NodeJS.ProcessEnv = { PATH: directories.join(delimiter) };
      for (const name of inheritedEnvironmentNames) {
        const value = dependencies.baseEnvironment[name];
        if (value !== undefined) environment[name] = value;
      }
      if (dependencies.inheritOpenClawEnvironment !== false) {
        for (const name of inheritedOpenClawEnvironmentNames) {
          const value = dependencies.baseEnvironment[name];
          if (value !== undefined) environment[name] = value;
        }
      }
      if (binding) {
        environment.AGENT_SYSTEM_EXEC_AUTHORITY = binding.authority;
        environment.AGENT_SYSTEM_EXEC_CAPABILITY = binding.capability;
      }

      let executable: string;
      let argv: string[];
      if (command.kind === 'shell') {
        executable = await resolveShell(command.shell, hostSearchDirectories, workspaceDir);
        scriptDirectory = await mkdtemp(
          join(dependencies.temporaryDirectory ?? tmpdir(), 'agent-system-setup-'),
        );
        const script = join(scriptDirectory, 'script');
        await writeFile(script, command.script, { flag: 'wx', mode: 0o600 });
        argv = [...shellArguments[command.shell], script];
      } else {
        try {
          const candidate = resolve(workspaceDir, command.executable);
          executable =
            command.executable.includes('/') &&
            (!isAbsolute(command.executable) || isPathContained(workspaceDir, candidate))
              ? await workspaceExecutable(workspaceDir, command.executable)
              : await resolveToolExecutable(command.executable, environment.PATH ?? '', [
                  workspaceDir,
                ]);
        } catch (error) {
          if (error instanceof SetupCommandError) throw error;
          throw new SetupCommandError('setup-executable-unavailable');
        }
        argv = [...command.args];
      }
      const result = await dependencies.runCommandWithTimeout([executable, ...argv], {
        baseEnv: {},
        cwd: workspaceDir,
        env: environment,
        input: '',
        timeoutMs: command.timeoutSeconds * 1_000,
        maxOutputBytes: maximumOutputBytes,
        maxCombinedOutputBytes: maximumOutputBytes,
        outputCapture: 'head',
        killGraceMs: 100,
        killProcessTree: true,
        ...(signal === undefined ? {} : { signal }),
      });
      const timedOut =
        result.termination === 'timeout' || result.termination === 'no-output-timeout';
      return {
        exitCode: timedOut ? null : result.code,
        timedOut,
        truncated: (result.stdoutTruncatedBytes ?? 0) > 0 || (result.stderrTruncatedBytes ?? 0) > 0,
      };
    } catch (error) {
      if (error instanceof SetupCommandError) throw error;
      throw new SetupCommandError('setup-execution-failed');
    } finally {
      if (scriptDirectory) await removeScript(scriptDirectory);
    }
  };
}
