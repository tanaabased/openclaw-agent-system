import { assertPrivateStateLocksHeld } from '../../core/private-state-lock-context.ts';

/** Compatibility for the released Gateway's unmarked stale-instance read rejection. */
export function staleSessionInstanceMessage(message: string): boolean {
  return /^PluginInstanceUnavailableError: Plugin [\w-]+ was reloaded or disabled; use its current tools\.$/.test(
    message,
  );
}

/** Read-only recovery: one elapsed budget includes backoff and subsequent RPCs. */
export default async function retrySessionResolution(
  firstError: unknown,
  invoke: (timeoutMs: number, signal?: AbortSignal) => Promise<Record<string, unknown>>,
  dependencies: {
    sleep(ms: number, signal?: AbortSignal): Promise<unknown>;
    now(): number;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const { isGatewayClientRequestError, ErrorCodes } =
    await import('openclaw/plugin-sdk/gateway-runtime');
  const deadline = dependencies.now() + 60_000;
  let error = firstError;
  let delay = 250;
  while (
    isGatewayClientRequestError(error) &&
    error.gatewayCode === ErrorCodes.UNAVAILABLE &&
    staleSessionInstanceMessage(error.message)
  ) {
    assertPrivateStateLocksHeld();
    dependencies.signal?.throwIfAborted();
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) throw error;
    await dependencies.sleep(Math.min(delay, remaining), dependencies.signal);
    assertPrivateStateLocksHeld();
    dependencies.signal?.throwIfAborted();
    const timeoutMs = Math.floor(deadline - dependencies.now());
    if (timeoutMs <= 0) throw error;
    try {
      const result = await invoke(timeoutMs, dependencies.signal);
      assertPrivateStateLocksHeld();
      dependencies.signal?.throwIfAborted();
      return result;
    } catch (next) {
      error = next;
    }
    delay = Math.min(delay * 2, 5_000);
  }
  throw error;
}
