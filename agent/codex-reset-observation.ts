import { nativeObject } from './automation-gateway.ts';
import { codexDispatchNative, type DispatchNativeThread } from './codex-dispatch-native.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import { CodexThreadRpcError, type CodexThreadRequest } from './codex-thread-client.ts';
import { validTerminalRecord } from './retain-dispatch-history.ts';

/** reset observes compact terminal identities without recreating runnable creation requests. */
export default async function observeResetThread(
  request: CodexThreadRequest,
  entry: DispatchRecord,
): Promise<DispatchNativeThread | undefined> {
  if (entry.request)
    return codexDispatchNative(request).find({
      sourceThreadId: entry.sourceThreadId,
      prompt: entry.request.prompt,
      createdAfter: entry.createdAt,
      threadId: entry.threadId,
      observationOnly: true,
    });
  if (!entry.threadId) return undefined;
  if (!validTerminalRecord(entry) || !entry.worktree)
    throw new Error('notification-reset-native-identity-unresolved');
  let thread;
  try {
    ({ thread } = await request('thread/read', { threadId: entry.threadId, includeTurns: false }));
  } catch (error) {
    if (
      error instanceof CodexThreadRpcError &&
      error.code === -32600 &&
      error.message === 'no rollout found for thread id ' + entry.threadId
    )
      return undefined;
    throw error;
  }
  if (
    !nativeObject(thread) ||
    thread.id !== entry.threadId ||
    thread.cwd !== entry.worktree ||
    thread.ephemeral === true ||
    !nativeObject(thread.status) ||
    typeof thread.status.type !== 'string'
  )
    throw new Error('notification-reset-native-identity-changed');
  const turns = await request('thread/turns/list', {
    threadId: entry.threadId,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
    limit: 1,
  });
  if (!Array.isArray(turns.data) || turns.data.length > 1)
    throw new Error('notification-reset-native-observation-unavailable');
  const last = turns.data[0];
  return {
    id: entry.threadId,
    cwd: entry.worktree,
    status: thread.status.type,
    archived:
      thread.archived === true ||
      (typeof thread.path === 'string' &&
        thread.path.split(/[\\/]/u).includes('archived_sessions')),
    turnEnded:
      nativeObject(last) &&
      ['completed', 'failed', 'interrupted'].includes(String(last.status)) &&
      typeof last.completedAt === 'number' &&
      Number.isFinite(last.completedAt) &&
      last.completedAt > 0,
  };
}
