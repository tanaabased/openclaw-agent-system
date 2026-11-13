import automationCompatibilityDiagnostic from './automation-compatibility-diagnostic.ts';
import { assertPrivateStateLocksHeld } from '../../core/private-state-lock-context.ts';

/** Intentional 11.3 compatibility: keep until upstream session resolution is verified across reload. */
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
    deadline: number;
    signal?: AbortSignal;
  },
): Promise<Record<string, unknown>> {
  const { isGatewayClientRequestError, ErrorCodes } =
    await import('openclaw/plugin-sdk/gateway-runtime');
  const deadline = dependencies.deadline;
  const started = dependencies.now();
  let attempts = 1;
  let outcome = 'different-error';
  try {
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
      if (remaining <= 0) {
        outcome = 'deadline';
        throw error;
      }
      await dependencies.sleep(Math.min(delay, remaining), dependencies.signal);
      assertPrivateStateLocksHeld();
      dependencies.signal?.throwIfAborted();
      const timeoutMs = Math.floor(deadline - dependencies.now());
      if (timeoutMs <= 0) {
        outcome = 'deadline';
        throw error;
      }
      try {
        attempts += 1;
        const result = await invoke(timeoutMs, dependencies.signal);
        assertPrivateStateLocksHeld();
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
    automationCompatibilityDiagnostic('automation-session-recovery', {
      attempts,
      recoveryElapsedMs: Math.round(dependencies.now() - started),
      remainingMs: Math.max(0, Math.round(deadline - dependencies.now())),
      outcome: dependencies.signal?.aborted ? 'cancelled' : outcome,
    });
  }
}
