import { access, lstat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import isPathContained from '../utils/is-path-contained.ts';
import type { AgentSystemCliRunner } from './types.ts';

const forcedTerminationGraceMs = 100;

async function executableCandidate(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() && !stats.isSymbolicLink()) return undefined;
    await access(path, 1);
    const target = await realpath(path);
    if (!(await lstat(target)).isFile()) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

/** Resolve one executable without accepting higher-priority command overrides or shell lookup. */
export async function resolveToolExecutable(
  executable: string,
  pathValue: string,
  excludedDirectories: readonly string[] = [],
): Promise<string> {
  const resolvedExcludedDirectories = await Promise.all(
    excludedDirectories.map(async (directory) => {
      try {
        return await realpath(directory);
      } catch {
        return resolve(directory);
      }
    }),
  );
  const candidates = isAbsolute(executable)
    ? [executable]
    : pathValue
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, executable));

  for (const candidate of candidates) {
    const resolvedCandidate = await executableCandidate(candidate);
    if (!resolvedCandidate) continue;
    if (
      excludedDirectories.some((directory) =>
        isPathContained(resolve(directory), resolve(candidate)),
      ) ||
      resolvedExcludedDirectories.some((directory) => isPathContained(directory, resolvedCandidate))
    ) {
      continue;
    }
    return resolvedCandidate;
  }

  throw new Error('tool executable is unavailable');
}

/** Run a selected executable through the host's bounded command lifecycle. */
export default function createToolCliRunner(
  runCommandWithTimeout: OpenClawPluginApi['runtime']['system']['runCommandWithTimeout'],
): AgentSystemCliRunner {
  return async (request) => {
    const executable = await resolveToolExecutable(
      request.executable,
      request.environment.PATH ?? '',
      request.excludedExecutableDirectories,
    );
    const result = await runCommandWithTimeout([executable, ...request.argv], {
      baseEnv: {},
      cwd: request.cwd,
      env: request.environment,
      input: request.stdin ?? '',
      killGraceMs: forcedTerminationGraceMs,
      killProcessTree: true,
      maxCombinedOutputBytes: request.maxOutputBytes,
      maxOutputBytes: request.maxOutputBytes,
      outputCapture: 'head',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      timeoutMs: request.timeoutMs,
    });
    const timedOut = result.termination === 'timeout' || result.termination === 'no-output-timeout';
    return {
      exitCode: timedOut ? null : result.code,
      resolvedExecutable: executable,
      stderr: result.stderr,
      stdout: result.stdout,
      timedOut,
      truncated: (result.stdoutTruncatedBytes ?? 0) > 0 || (result.stderrTruncatedBytes ?? 0) > 0,
    };
  };
}
