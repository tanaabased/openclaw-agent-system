import { spawn, type ChildProcess } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export interface GitSshAgentProcess {
  dispose(): Promise<void>;
  socketPath: string;
}

export interface StartGitSshAgentOptions {
  environment: NodeJS.ProcessEnv;
  executable: string;
  signal?: AbortSignal;
  socketPath: string;
  timeoutMs?: number;
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function socketIsReady(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSocket();
  } catch {
    return false;
  }
}

/** Start one foreground ssh-agent and return only after its private socket is ready. */
export default async function startGitSshAgent(
  options: StartGitSshAgentOptions,
): Promise<GitSshAgentProcess> {
  const child = spawn(options.executable, ['-D', '-a', options.socketPath], {
    detached: true,
    env: options.environment,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  let exited = false;
  const completion = new Promise<{ error?: unknown; exitCode?: number | null }>((resolveExit) => {
    child.once('error', (error) => {
      exited = true;
      resolveExit({ error });
    });
    child.once('close', (exitCode) => {
      exited = true;
      resolveExit({ exitCode });
    });
  });
  const dispose = async () => {
    if (!exited) signalProcess(child, 'SIGTERM');
    await Promise.race([completion, delay(1_000)]);
    if (!exited) {
      signalProcess(child, 'SIGKILL');
      await completion;
    }
  };

  try {
    const deadline = Date.now() + (options.timeoutMs ?? 5_000);
    while (!(await socketIsReady(options.socketPath))) {
      if (options.signal?.aborted) throw new Error('ssh-agent startup was cancelled');
      if (exited) {
        const result = await completion;
        throw new Error('ssh-agent exited before its socket was ready', {
          cause: result.error,
        });
      }
      if (Date.now() >= deadline) throw new Error('ssh-agent socket was not ready');
      await delay(25);
    }
  } catch (error) {
    await dispose();
    throw error;
  }

  return { dispose, socketPath: options.socketPath };
}
