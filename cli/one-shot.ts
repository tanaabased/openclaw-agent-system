import { defaultRuntime } from 'openclaw/plugin-sdk/runtime';

export interface CliFlushStream {
  write(value: string, callback: (error?: Error | null) => void): boolean;
}

export interface CompleteCliOneShotOptions {
  exit?: (code: number) => void;
  stderr?: CliFlushStream;
  stdout?: CliFlushStream;
}

async function flushStream(stream: CliFlushStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write('', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Flush machine output before ending an explicitly one-shot OpenClaw CLI process. */
export async function completeCliOneShot(
  code: number,
  options: CompleteCliOneShotOptions = {},
): Promise<void> {
  await flushStream(options.stdout ?? process.stdout);
  await flushStream(options.stderr ?? process.stderr);
  (options.exit ?? defaultRuntime.exit)(code);
}
