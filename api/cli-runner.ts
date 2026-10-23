import { access, lstat, realpath } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import {
  assertPrivateStateLocksHeld,
  privateStateLockSignal,
} from '../core/private-state-lock-context.ts';
import isPathContained from '../utils/is-path-contained.ts';
import type { AgentSystemCliRunner } from './types.ts';
import createGitHubRequestProfile, {
  saveGitHubRequestProfile,
} from '../core/github-request-profile.ts';

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
  githubProfileDirectory = process.env.AGENT_SYSTEM_GITHUB_PROFILE_DIR,
  profileUnavailable: () => void = () => undefined,
): AgentSystemCliRunner {
  return async (request) => {
    const executable = await resolveToolExecutable(
      request.executable,
      request.environment.PATH ?? '',
      [
        ...(request.excludedExecutableDirectories ?? []),
        ...(githubProfileDirectory ? [join(githubProfileDirectory, 'bin')] : []),
      ],
    );
    const signal = privateStateLockSignal(request.signal);
    const profile =
      githubProfileDirectory && isAbsolute(githubProfileDirectory) && basename(executable) === 'gh'
        ? createGitHubRequestProfile(request.maxOutputBytes)
        : undefined;
    const persist = async (
      captured: ReturnType<NonNullable<typeof profile>['finish']>,
      exitCode: number | null,
    ) => {
      await saveGitHubRequestProfile(
        githubProfileDirectory!,
        request.githubProfileContext,
        captured,
        exitCode,
      ).catch(profileUnavailable);
    };
    const result = await runCommandWithTimeout([executable, ...request.argv], {
      baseEnv: {},
      cwd: request.cwd,
      env: profile ? { ...request.environment, GH_DEBUG: '1' } : request.environment,
      input: request.stdin ?? '',
      killGraceMs: forcedTerminationGraceMs,
      killProcessTree: true,
      maxCombinedOutputBytes: request.maxOutputBytes,
      maxOutputBytes: request.maxOutputBytes,
      outputCapture: profile ? 'discard' : 'head',
      ...(profile ? { onOutputChunk: profile.observe } : {}),
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: request.timeoutMs,
    }).catch(async (error: unknown) => {
      const captured = profile?.finish();
      if (captured) await persist({ ...captured, complete: false }, null);
      throw error;
    });
    assertPrivateStateLocksHeld();
    const captured = profile?.finish();
    if (captured)
      await persist(
        { ...captured, complete: captured.complete && result.termination === 'exit' },
        result.code,
      );
    const timedOut = result.termination === 'timeout' || result.termination === 'no-output-timeout';
    return {
      exitCode: timedOut ? null : result.code,
      resolvedExecutable: executable,
      stderr: captured?.stderr ?? result.stderr,
      stdout: captured?.stdout ?? result.stdout,
      timedOut,
      truncated:
        captured?.truncated ??
        ((result.stdoutTruncatedBytes ?? 0) > 0 || (result.stderrTruncatedBytes ?? 0) > 0),
    };
  };
}
