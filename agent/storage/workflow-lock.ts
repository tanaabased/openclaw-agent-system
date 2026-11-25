import { automationHash } from '../automation-hash.ts';
import { basename, dirname, join } from 'node:path';
import ensurePrivateStateDirectories from '../../core/ensure-private-state-directories.ts';
import acquirePrivateStateFileLock, {
  type PrivateStateFileLockOptions,
} from '../../core/private-state-file-lock.ts';
import {
  type PrivateStateLockGuard,
  withPrivateStateLock,
} from '../../core/private-state-lock-context.ts';

export type AgentLockFamily =
  'dispatch' | 'notification-reset' | 'implementation' | 'automation-threads';

/** Lock the same SQLite resource regardless of the caller's legacy journal directory. */
export function agentWorkflowLockPath(database: string, family: AgentLockFamily, scope: string) {
  return join(dirname(database), family + '-' + automationHash([basename(database), scope]));
}

export function assignmentClaimLockPath(installationRoot: string) {
  return join(installationRoot, 'assignment-claims');
}

/** Hold ownership through an external effect and its receipt, across either storage backend. */
export default async function withWorkflowLock<T>(
  path: string,
  label: string,
  run: (guard: PrivateStateLockGuard) => Promise<T>,
  options: Partial<PrivateStateFileLockOptions> = {},
) {
  await ensurePrivateStateDirectories({
    directories: [dirname(path)],
    currentUid: process.getuid?.(),
    label,
  });
  const lock = await acquirePrivateStateFileLock(path, {
    staleMs: 30_000,
    retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    ...options,
  });
  try {
    return await withPrivateStateLock(lock, () => run(lock));
  } finally {
    await lock.release();
  }
}
