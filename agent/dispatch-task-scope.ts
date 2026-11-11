import { AsyncLocalStorage } from 'node:async_hooks';

const task = new AsyncLocalStorage<
  { runtime: 'codex' | 'openclaw'; session: string } | undefined
>();

/** native callers narrow damaged-journal access; this supplies no execution authority. */
export function withDispatchTask<T>(
  runtime: 'codex' | 'openclaw',
  session: string | undefined,
  run: () => T,
): T {
  return task.run(session ? { runtime, session } : undefined, run);
}

export function dispatchTaskSession(runtime: 'codex' | 'openclaw') {
  const scope = task.getStore();
  return scope?.runtime === runtime ? scope.session : undefined;
}
