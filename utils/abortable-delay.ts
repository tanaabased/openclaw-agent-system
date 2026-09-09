/** Wait for a bounded duration and reject promptly when the caller aborts. */
export default function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647) {
    return Promise.reject(new Error('Abortable delays must use bounded non-negative integers.'));
  }
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('The delay was aborted.', 'AbortError'),
    );
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const complete = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason ?? new DOMException('The delay was aborted.', 'AbortError'));
    };
    const timeout = setTimeout(complete, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
