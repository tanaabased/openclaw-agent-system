import { GatewayClientRequestTimeoutError } from '@openclaw/gateway-client';

/** controlled sdk boundary; elapsed time follows the options supplied by the owned adapter. */
export default function gatewayRequestFixture(timeoutFailure?: Error) {
  let elapsed = 0;
  let timeoutMs = 30_000;
  let settled = false;
  let calls = 0;
  let deadline: { at: number; abort(): void } | undefined;
  let signal: AbortSignal | undefined;
  const dispatched = Promise.withResolvers<void>();
  const result = Promise.withResolvers<Record<string, unknown>>();
  const abort = () => {
    settled = true;
    result.reject(signal?.reason);
  };
  return {
    dispatched: dispatched.promise,
    calls: () => calls,
    settled: () => settled,
    deadline(milliseconds: number, abort: () => void) {
      deadline = { at: elapsed + milliseconds, abort };
    },
    request(budget = 30_000, cancellation?: AbortSignal) {
      calls += 1;
      timeoutMs = budget;
      signal = cancellation;
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      dispatched.resolve();
      return result.promise.finally(() => signal?.removeEventListener('abort', abort));
    },
    advance(milliseconds: number) {
      elapsed += milliseconds;
      if (deadline && elapsed >= deadline.at) {
        deadline.abort();
        deadline = undefined;
      }
      if (!settled && elapsed >= timeoutMs) {
        settled = true;
        result.reject(
          timeoutFailure ??
            new GatewayClientRequestTimeoutError({
              method: 'sessions.create',
              timeoutMs,
              requestSent: true,
            }),
        );
      }
    },
    complete() {
      if (settled) return;
      settled = true;
      result.resolve({ key: 'created' });
    },
  };
}
