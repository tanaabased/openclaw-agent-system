import { spawn } from 'node:child_process';

import signalProcessTree from '../utils/signal-process-tree.ts';
import type {
  SetupProcessOptions,
  SetupProcessResult,
  SetupProcessRunner,
} from './setup-runner.ts';

// no host capture API exists here. reuse the prior Codex provider allowance per stream:
// at most 1 mib of retained raw output by default, without starving stderr behind stdout.
const defaultStreamBytes = 512 * 1024;

interface CaptureState {
  kept: number;
  truncated: number;
}
interface CapturedChunk {
  stream: CaptureState;
  data: Buffer;
}

function capture(
  state: CaptureState,
  chunk: Buffer,
  options: SetupProcessOptions,
  chunks: CapturedChunk[],
): void {
  const streamLimit = options.maxOutputBytes ?? defaultStreamBytes;
  const combinedLimit = options.maxCombinedOutputBytes ?? Infinity;
  const combinedBytes = chunks.reduce((total, entry) => total + entry.data.length, 0);
  if (options.outputCapture === 'head') {
    const kept = Math.max(
      0,
      Math.min(chunk.length, streamLimit - state.kept, combinedLimit - combinedBytes),
    );
    if (kept) chunks.push({ stream: state, data: Buffer.from(chunk.subarray(0, kept)) });
    state.kept += kept;
    state.truncated += chunk.length - kept;
    return;
  }
  chunks.push({ stream: state, data: chunk });
  state.kept += chunk.length;
  const discard = (count: number, stream?: CaptureState) => {
    for (let index = 0; count > 0 && index < chunks.length;) {
      const entry = chunks[index]!;
      if (stream && entry.stream !== stream) {
        index++;
        continue;
      }
      const removed = Math.min(count, entry.data.length);
      entry.stream.kept -= removed;
      entry.stream.truncated += removed;
      count -= removed;
      if (removed === entry.data.length) chunks.splice(index, 1);
      else {
        entry.data = Buffer.from(entry.data.subarray(removed));
        index++;
      }
    }
  };
  discard(state.kept - streamLimit, state);
  discard(chunks.reduce((total, entry) => total + entry.data.length, 0) - combinedLimit);
}

function decode(
  state: CaptureState,
  chunks: CapturedChunk[],
  mode: SetupProcessOptions['outputCapture'],
) {
  const bytes = Buffer.concat(
    chunks.filter((entry) => entry.stream === state).map((entry) => entry.data),
  );
  let start = 0;
  let end = bytes.length;
  if (state.truncated > 0 && mode !== 'head') {
    while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  } else if (state.truncated > 0 && end > 0) {
    let lead = end - 1;
    while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead--;
    const byte = bytes[lead]!;
    const length =
      byte >= 0xc2 && byte <= 0xdf
        ? 2
        : byte >= 0xe0 && byte <= 0xef
          ? 3
          : byte >= 0xf0 && byte <= 0xf4
            ? 4
            : 1;
    if (end - lead < length) end = lead;
  }
  state.truncated += start + bytes.length - end;
  return bytes.subarray(start, end).toString('utf8');
}

/** Provide the standalone Codex adapter with the bounded process contract used by setup. */
const runCodexSetupProcess: SetupProcessRunner = async (argv, options) =>
  new Promise<SetupProcessResult>((resolve, reject) => {
    for (const limit of [options.maxOutputBytes, options.maxCombinedOutputBytes]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        reject(new RangeError('command output limits must be positive safe integers'));
        return;
      }
    }
    const stdout: CaptureState = { kept: 0, truncated: 0 };
    const stderr: CaptureState = { kept: 0, truncated: 0 };
    const chunks: CapturedChunk[] = [];
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
      // Descendants can keep inherited pipes open after the direct child exits.
      if (settled || termination !== 'exit') return;
      termination = reason;
      signalProcessTree(child, 'SIGTERM');
      forceTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), options.killGraceMs);
      forceTimer.unref();
    };
    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();
    const abort = () => stop('signal');
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk, options, chunks));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk, options, chunks));
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
        code: termination === 'exit' ? code : null,
        killed: termination !== 'exit',
        signal,
        stdout: decode(stdout, chunks, options.outputCapture),
        stderr: decode(stderr, chunks, options.outputCapture),
        termination: termination === 'exit' && signal !== null ? 'signal' : termination,
        ...(stdout.truncated === 0 ? {} : { stdoutTruncatedBytes: stdout.truncated }),
        ...(stderr.truncated === 0 ? {} : { stderrTruncatedBytes: stderr.truncated }),
      });
    });

    child.stdin.end(options.input);
    if (options.signal?.aborted) abort();
  });

export default runCodexSetupProcess;
