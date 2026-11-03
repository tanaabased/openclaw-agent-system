import { resolve } from 'node:path';

import properLockfile from 'proper-lockfile';

import nodeErrorCode from '../utils/node-error-code.ts';
import { holdsPrivateStateLock, type PrivateStateLockGuard } from './private-state-lock-context.ts';

export const privateStateFileLockBusyErrorCode = 'private-state-file-lock-busy';
export const privateStateFileLockLostErrorCode = 'private-state-file-lock-lost';

export interface PrivateStateFileLockHandle extends PrivateStateLockGuard {
  release(): Promise<void>;
}

export interface PrivateStateFileLockRetryOptions {
  factor: number;
  maxTimeout: number;
  minTimeout: number;
  retries: number;
}

export interface PrivateStateFileLockOptions {
  retries: PrivateStateFileLockRetryOptions;
  staleMs: number;
  contention?: {
    category: 'dispatch' | 'intake';
    operation:
      | 'dispatch-commit'
      | 'dispatch-reconcile'
      | 'occurrence-registration'
      | 'intake-commit'
      | 'delivery-checkpoint'
      | 'continuation-checkpoint';
    timeoutMs: number;
    retryMs: number;
    signal?: AbortSignal;
  };
}

export interface PrivateStateContention {
  category: NonNullable<PrivateStateFileLockOptions['contention']>['category'];
  operation: NonNullable<PrivateStateFileLockOptions['contention']>['operation'];
  waitedMs: number;
  holderOperation: PrivateStateContention['operation'] | 'unknown';
  heldMs?: number;
}

export class PrivateStateFileLockBusyError extends Error {
  readonly code = privateStateFileLockBusyErrorCode;
  constructor(readonly contention?: PrivateStateContention) {
    super(
      'The private state file lock is busy.' + (contention ? ' ' + JSON.stringify(contention) : ''),
    );
  }
}

interface ProperLockfile {
  lock(
    path: string,
    options: {
      onCompromised(error: Error): void;
      realpath: false;
      retries: PrivateStateFileLockRetryOptions;
      stale: number;
    },
  ): Promise<() => Promise<void>>;
}

interface Slot {
  operation: PrivateStateContention['operation'];
  heldAt?: number;
  ready: () => void;
}
const queues = new Map<string, Slot[]>();

/** acquire one lease, releasing its local slot too when archive work suspends the lease. */
export default async function acquirePrivateStateFileLock(
  path: string,
  options: PrivateStateFileLockOptions,
  dependencies: {
    lock?: ProperLockfile['lock'];
    now?: () => number;
    schedule?: (run: () => void, ms: number) => () => void;
  } = {},
): Promise<PrivateStateFileLockHandle> {
  const policy = options.contention;
  if (
    !path ||
    !Number.isSafeInteger(options.staleMs) ||
    options.staleMs < 2_000 ||
    (policy &&
      (!Number.isSafeInteger(policy.timeoutMs) ||
        policy.timeoutMs < 0 ||
        !Number.isSafeInteger(policy.retryMs) ||
        policy.retryMs < 1))
  ) {
    throw new Error('Private state file lock options are invalid.');
  }
  const key = resolve(path);
  const now = dependencies.now ?? (() => performance.now());
  const schedule =
    dependencies.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  const started = now();
  const deadline = started + (policy?.timeoutMs ?? 0);
  const busy = () => {
    const holder = queues.get(key)?.[0];
    const contention: PrivateStateContention | undefined = policy
      ? {
          category: policy.category,
          operation: policy.operation,
          waitedMs: Math.max(0, Math.round(now() - started)),
          holderOperation: holder?.heldAt !== undefined ? holder.operation : 'unknown',
          ...(holder?.heldAt !== undefined
            ? { heldMs: Math.max(0, Math.round(now() - holder.heldAt)) }
            : {}),
        }
      : undefined;
    return new PrivateStateFileLockBusyError(contention);
  };
  policy?.signal?.throwIfAborted();
  if (holdsPrivateStateLock(key)) throw busy();
  let slot: Slot | undefined;
  const leave = () => {
    if (!slot) return;
    const queue = queues.get(key)!;
    const index = queue.indexOf(slot);
    if (index < 0) return;
    queue.splice(index, 1);
    slot = undefined;
    if (!queue.length) queues.delete(key);
    else if (index === 0) queue[0]!.ready();
  };
  if (policy) {
    const queue = queues.get(key) ?? [];
    queues.set(key, queue);
    const ready = Promise.withResolvers<void>();
    slot = { operation: policy.operation, ready: ready.resolve };
    queue.push(slot);
    if (queue.length > 1) {
      try {
        let cancel = () => {};
        let aborted = () => {};
        try {
          await Promise.race([
            ready.promise,
            new Promise<never>((_accept, reject) => {
              cancel = schedule(() => reject(busy()), Math.max(0, deadline - now()));
              aborted = () => reject(policy.signal!.reason);
              policy.signal?.addEventListener('abort', aborted, { once: true });
            }),
          ]);
          policy.signal?.throwIfAborted();
          if (now() >= deadline) throw busy();
        } finally {
          cancel();
          policy.signal?.removeEventListener('abort', aborted);
        }
      } catch (error) {
        leave();
        throw error;
      }
    }
  }
  const controller = new AbortController();
  let lost: Error | undefined;
  let releasing: Promise<void> | undefined;
  const assertHeld = () => {
    if (lost) throw lost;
    if (releasing) throw new Error('The private state file lock has been released.');
  };
  try {
    let release: () => Promise<void>;
    for (;;) {
      policy?.signal?.throwIfAborted();
      try {
        release = await (dependencies.lock ?? properLockfile.lock)(path, {
          onCompromised() {
            lost ??= Object.assign(
              new Error('The private state file lock was lost; retry the operation.'),
              { code: privateStateFileLockLostErrorCode },
            );
            controller.abort(lost);
          },
          realpath: false,
          retries: policy ? { ...options.retries, retries: 0 } : options.retries,
          stale: options.staleMs,
        });
        break;
      } catch (error) {
        if (nodeErrorCode(error) !== 'ELOCKED') throw error;
        if (!policy || now() >= deadline) throw busy();
        await new Promise<void>((accept, reject) => {
          const aborted = () => {
            cancel();
            reject(policy.signal!.reason);
          };
          const cancel = schedule(
            () => {
              policy.signal?.removeEventListener('abort', aborted);
              accept();
            },
            Math.min(policy.retryMs, deadline - now()),
          );
          policy.signal?.addEventListener('abort', aborted, { once: true });
        });
      }
    }
    if (policy?.signal?.aborted || (policy && policy.timeoutMs > 0 && now() > deadline)) {
      if (!lost) await release();
      policy.signal?.throwIfAborted();
      throw busy();
    }
    if (slot) slot.heldAt = now();
    return {
      path: key,
      assertHeld,
      signal: controller.signal,
      release() {
        // a compromised lease no longer owns the lock directory. leave its successor alone.
        releasing ??= Promise.resolve()
          .then(() => (lost ? undefined : release()))
          .finally(leave);
        return releasing;
      },
    };
  } catch (error) {
    leave();
    throw error;
  }
}
