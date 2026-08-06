import { spawn } from 'node:child_process';

export type CredentialCommandStatus =
  'completed' | 'failed-to-start' | 'output-too-large' | 'timed-out';

export interface CredentialCommandResult {
  exitCode?: number;
  status: CredentialCommandStatus;
  stderr: Buffer;
  stdout: Buffer;
}

export interface CredentialCommandOptions {
  args: string[];
  command: string;
  environment?: NodeJS.ProcessEnv;
  input?: string;
  maximumOutputBytes: number;
  timeoutMs: number;
}

/** Run one credential helper without a shell, bounding its runtime and captured output. */
export default function runCredentialCommand(
  options: CredentialCommandOptions,
): Promise<CredentialCommandResult> {
  return new Promise((resolveResult) => {
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const state: { timer?: NodeJS.Timeout } = {};
    let termination: CredentialCommandStatus | undefined;

    const finish = (status: CredentialCommandStatus, exitCode?: number) => {
      if (settled) return;
      settled = true;
      if (state.timer) clearTimeout(state.timer);
      resolveResult({
        ...(exitCode === undefined ? {} : { exitCode }),
        status,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    };

    let child;
    try {
      child = spawn(options.command, options.args, {
        env: options.environment ?? process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish('failed-to-start');
      return;
    }
    const capture = (destination: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maximumOutputBytes) {
        termination = 'output-too-large';
        child.kill('SIGKILL');
        return;
      }
      destination.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.stdin.on('error', () => undefined);
    child.once('error', () => finish('failed-to-start'));
    child.once('close', (code) => finish(termination ?? 'completed', code ?? 1));

    state.timer = setTimeout(() => {
      termination = 'timed-out';
      child.kill('SIGKILL');
    }, options.timeoutMs);
    state.timer.unref();

    child.stdin.end(options.input);
  });
}
