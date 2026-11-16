/** intentional 11.3 compatibility for the two supported read-only session lookups. */
export function isSessionRead(method: string): boolean {
  return method === 'sessions.resolve' || method === 'sessions.list';
}

export function staleSessionRead(method: string, code: string, message: string): boolean {
  return (
    isSessionRead(method) &&
    code === 'UNAVAILABLE' &&
    /^PluginInstanceUnavailableError: Plugin [\w-]+ was reloaded or disabled; use its current tools\.$/.test(
      message,
    )
  );
}

/** read-only recovery: one elapsed budget includes backoff and subsequent rpcs. */
export default async function retrySessionRead<T>(
  firstError: unknown,
  invoke: (timeoutMs: number, signal?: AbortSignal) => Promise<T>,
  dependencies: {
    sleep(ms: number, signal?: AbortSignal): Promise<unknown>;
    now(): number;
    deadline: number;
    signal?: AbortSignal;
    isStale(error: unknown): boolean;
    assertCurrent(): void | Promise<void>;
    onRecovery?(evidence: {
      attempts: number;
      recoveryElapsedMs: number;
      remainingMs: number;
      outcome: string;
    }): void;
  },
): Promise<T> {
  const deadline = dependencies.deadline;
  const started = dependencies.now();
  let attempts = 1;
  let outcome = 'different-error';
  try {
    let error = firstError;
    let delay = 250;
    while (dependencies.isStale(error)) {
      await dependencies.assertCurrent();
      dependencies.signal?.throwIfAborted();
      const remaining = deadline - dependencies.now();
      if (remaining <= 0) {
        outcome = 'deadline';
        throw error;
      }
      await dependencies.sleep(Math.min(delay, remaining), dependencies.signal);
      await dependencies.assertCurrent();
      dependencies.signal?.throwIfAborted();
      const timeoutMs = Math.floor(deadline - dependencies.now());
      if (timeoutMs <= 0) {
        outcome = 'deadline';
        throw error;
      }
      try {
        attempts += 1;
        const result = await invoke(timeoutMs, dependencies.signal);
        await dependencies.assertCurrent();
        dependencies.signal?.throwIfAborted();
        outcome = 'success';
        return result;
      } catch (next) {
        error = next;
      }
      delay = Math.min(delay * 2, 5_000);
    }
    throw error;
  } finally {
    dependencies.onRecovery?.({
      attempts,
      recoveryElapsedMs: Math.round(dependencies.now() - started),
      remainingMs: Math.max(0, Math.round(deadline - dependencies.now())),
      outcome: dependencies.signal?.aborted ? 'cancelled' : outcome,
    });
  }
}
