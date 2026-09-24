import { spawn } from 'node:child_process';

import type {
  SetupProcessOptions,
  SetupProcessResult,
  SetupProcessRunner,
} from './setup-runner.ts';

interface CaptureState {
  chunks: Buffer[];
  kept: number;
  truncated: number;
}

function capture(
  state: CaptureState,
  chunk: Buffer,
  options: SetupProcessOptions,
  combined: { kept: number },
): void {
  const available = Math.max(
    0,
    Math.min(options.maxOutputBytes - state.kept, options.maxCombinedOutputBytes - combined.kept),
  );
  const kept = Math.min(available, chunk.byteLength);
  if (kept > 0) state.chunks.push(chunk.subarray(0, kept));
  state.kept += kept;
  combined.kept += kept;
  state.truncated += chunk.byteLength - kept;
}

function signalProcess(
  child: { kill(signal?: NodeJS.Signals): boolean; pid?: number },
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // Fall back to the direct child if process-group signaling is unavailable.
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited between the lifecycle event and the signal.
  }
}

/** Provide the standalone Codex adapter with the bounded process contract used by setup. */
const runCodexSetupProcess: SetupProcessRunner = async (argv, options) =>
  new Promise<SetupProcessResult>((resolve, reject) => {
    const stdout: CaptureState = { chunks: [], kept: 0, truncated: 0 };
    const stderr: CaptureState = { chunks: [], kept: 0, truncated: 0 };
    const combined = { kept: 0 };
    let termination: SetupProcessResult['termination'] = 'exit';
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      detached: options.killProcessTree,
      env: { ...options.baseEnv, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stop = (reason: 'signal' | 'timeout') => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return;
      termination = reason;
      signalProcess(child, 'SIGTERM');
      forceTimer = setTimeout(() => signalProcess(child, 'SIGKILL'), options.killGraceMs);
      forceTimer.unref();
    };
    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();
    const abort = () => stop('signal');
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk, options, combined));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk, options, combined));
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        code,
        killed: termination !== 'exit',
        signal,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        termination: termination === 'exit' && signal !== null ? 'signal' : termination,
        ...(stdout.truncated === 0 ? {} : { stdoutTruncatedBytes: stdout.truncated }),
        ...(stderr.truncated === 0 ? {} : { stderrTruncatedBytes: stderr.truncated }),
      });
    });

    child.stdin.end(options.input);
    if (options.signal?.aborted) abort();
  });

export default runCodexSetupProcess;
