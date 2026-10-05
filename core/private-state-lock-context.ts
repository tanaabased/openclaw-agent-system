import { AsyncLocalStorage } from 'node:async_hooks';

export interface PrivateStateLockGuard {
  assertHeld(): void;
  readonly signal: AbortSignal;
}

const guards = new AsyncLocalStorage<readonly PrivateStateLockGuard[]>();

/** check every enclosing lease, including an outer lease during nested state updates. */
export function assertPrivateStateLocksHeld(): void {
  for (const guard of guards.getStore() ?? []) guard.assertHeld();
}

export function privateStateLockSignal(signal?: AbortSignal): AbortSignal | undefined {
  assertPrivateStateLocksHeld();
  const signals = [...(signal ? [signal] : []), ...(guards.getStore() ?? []).map((g) => g.signal)];
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

/** keep the guard attached to awaited and detached continuations; never race an uncancelled writer. */
export async function withPrivateStateLock<T>(
  guard: PrivateStateLockGuard,
  run: () => Promise<T>,
): Promise<T> {
  return guards.run([...(guards.getStore() ?? []), guard], async () => {
    assertPrivateStateLocksHeld();
    try {
      const result = await run();
      assertPrivateStateLocksHeld();
      return result;
    } catch (error) {
      assertPrivateStateLocksHeld();
      throw error;
    }
  });
}
