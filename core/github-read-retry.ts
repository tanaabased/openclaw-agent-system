import { setTimeout } from 'node:timers/promises';

import cliOutputComplete from '../api/cli-output-complete.ts';
import type { AgentSystemCliResult } from '../api/types.ts';
import { githubCliDiagnostic } from '../credentials/github-diagnostic.ts';

interface ReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Call only for a known read. Writes with uncertain outcomes require reconciliation. */
export default async function retryGitHubRead(
  read: (timeoutMs: number) => Promise<AgentSystemCliResult>,
  options: ReadOptions = {},
): Promise<AgentSystemCliResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms, signal) => setTimeout(ms, undefined, { signal }));
  const deadline = now() + (options.timeoutMs ?? 30_000);
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const result = await read(Math.max(1, deadline - now()));
    if (!cliOutputComplete(result)) return result;
    const diagnostic = githubCliDiagnostic(result);
    const transient =
      result.exitCode !== 0 &&
      ([502, 503, 504].includes(diagnostic.httpStatus ?? 0) ||
        (diagnostic.httpStatus === null &&
          /(?:unexpected end of JSON input|\bECONNRESET\b|\bconnection reset by peer\b|GraphQL: Something went wrong while executing your query)/iu.test(
            result.stderr,
          )));
    const backoff = [250, 1000][attempt];
    const delay = Math.max(backoff ?? 0, diagnostic.retryAfterMs ?? 0);
    if (!transient || backoff === undefined || now() + delay >= deadline) {
      if (attempt === 0 || result.exitCode === 0) return result;
      return {
        ...result,
        stderr: `${result.stderr}\ngithub-read-retry-exhausted attempts=${attempt + 1} httpStatus=${diagnostic.httpStatus ?? 'unobserved'}\n`,
      };
    }
    await sleep(delay, options.signal);
    options.signal?.throwIfAborted();
    if (now() >= deadline) return result;
  }
}
