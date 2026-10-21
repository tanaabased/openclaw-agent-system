import { lstat } from 'node:fs/promises';

import { nativeObject } from './automation-gateway.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import { CodexThreadRpcError, type CodexThreadRequest } from './codex-thread-client.ts';

/** reconcile already removed resources; never turn an unreadable live chat into absence. */
export default async function codexResetRemoved(
  request: CodexThreadRequest,
  entry: Pick<DispatchRecord, 'retired' | 'threadId' | 'worktree'>,
  error?: unknown,
  stat: (path: string) => Promise<unknown> = lstat,
): Promise<boolean> {
  if (!entry.retired || !entry.threadId || !entry.worktree) return false;
  if (
    error !== undefined &&
    !(
      error instanceof CodexThreadRpcError &&
      error.code === -32600 &&
      error.message === 'thread not loaded: ' + entry.threadId
    )
  )
    return false;
  try {
    await stat(entry.worktree);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    let complete = false;
    for (let page = 0; page < 100; page++) {
      const result = await request('thread/list', {
        archived,
        limit: 100,
        modelProviders: [],
        sourceKinds: [
          'cli',
          'vscode',
          'exec',
          'appServer',
          'subAgent',
          'subAgentReview',
          'subAgentCompact',
          'subAgentThreadSpawn',
          'subAgentOther',
          'unknown',
        ],
        ...(cursor ? { cursor } : {}),
      });
      if (
        !Array.isArray(result.data) ||
        result.data.some((row) => !nativeObject(row) || typeof row.id !== 'string')
      )
        throw new Error('notification-reset-native-inventory-invalid');
      if (result.data.some((row) => row.id === entry.threadId)) return false;
      if (result.nextCursor == null) {
        complete = true;
        break;
      }
      if (
        typeof result.nextCursor !== 'string' ||
        !result.nextCursor ||
        seen.has(result.nextCursor)
      )
        throw new Error('notification-reset-native-inventory-incomplete');
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    if (!complete) throw new Error('notification-reset-native-inventory-incomplete');
  }
  return true;
}
