import { spawn } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';

import type { AgentSystemCliResult, AgentSystemCliRunRequest } from './tool-types.ts';

function isInside(path: string, directory: string): boolean {
  const difference = relative(resolve(directory), resolve(path));
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

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
      excludedDirectories.some((directory) => isInside(candidate, directory)) ||
      resolvedExcludedDirectories.some((directory) => isInside(resolvedCandidate, directory))
    ) {
      continue;
    }
    return resolvedCandidate;
  }

  throw new Error('tool executable is unavailable');
}

/** Run one fixed executable without a shell while bounding time and captured output. */
export default async function runToolCli(
  request: AgentSystemCliRunRequest,
): Promise<AgentSystemCliResult> {
  const executable = await resolveToolExecutable(
    request.executable,
    request.environment.PATH ?? '',
    request.excludedExecutableDirectories,
  );
  const child = spawn(executable, request.argv, {
    cwd: request.cwd,
    env: request.environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let capturedBytes = 0;
  let truncated = false;
  let timedOut = false;

  function append(
    current: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>,
  ): Buffer<ArrayBufferLike> {
    const remaining = Math.max(0, request.maxOutputBytes - capturedBytes);
    if (chunk.byteLength > remaining) truncated = true;
    const accepted = chunk.subarray(0, remaining);
    capturedBytes += accepted.byteLength;
    return remaining === 0 ? current : Buffer.concat([current, accepted]);
  }

  child.stdout.on('data', (chunk: Buffer<ArrayBufferLike>) => (stdout = append(stdout, chunk)));
  child.stderr.on('data', (chunk: Buffer<ArrayBufferLike>) => (stderr = append(stderr, chunk)));

  const terminate = () => child.kill('SIGTERM');
  const abort = () => terminate();
  request.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);

  try {
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolveExit(code));
    });
    return {
      exitCode,
      stderr: stderr.toString('utf8'),
      stdout: stdout.toString('utf8'),
      timedOut,
      truncated,
    };
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', abort);
  }
}
