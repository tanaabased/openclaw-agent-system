import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import { nativeObject } from './automation-gateway.ts';
import type { NotificationResetRecord } from './notification-reset-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

/** fresh reset observes native activity without reconstructing obsolete creation receipts. */
export default async function observeResetUnresolved(
  request: DispatchRequest,
  reset: Pick<NotificationResetRecord, 'resources' | 'warnings'>,
  entry: OpenClawDispatchRecord,
  agentId: string,
): Promise<boolean> {
  const workspaceDir = entry.worktree ?? entry.request?.cwd;
  if (!workspaceDir) throw new Error('notification-reset-session-creation-unresolved');
  let found = false;
  let idle = true;
  const observe = async (row: Record<string, unknown>) => {
    found = true;
    // unknown or foreign sessions are preserved, never adopted solely by checkout location.
    if (row.agentId !== agentId) return;
    if (typeof row.key !== 'string')
      throw new Error('notification-reset-session-inventory-unavailable');
    const history = await request('chat.history', { sessionKey: row.key, limit: 1 });
    if (
      !nativeObject(history) ||
      !nativeObject(history.sessionInfo) ||
      !nativeObject(history.pendingInputs)
    )
      throw new Error('notification-reset-session-inventory-unavailable');
    if (history.sessionInfo.hasActiveRun !== false || history.pendingInputs.total !== 0)
      idle = false;
  };
  const key = entry.request?.key;
  if (key) {
    const result = await request('sessions.describe', { key });
    if (!nativeObject(result) || !(result.session === null || nativeObject(result.session)))
      throw new Error('notification-reset-session-inventory-unavailable');
    if (nativeObject(result.session)) await observe(result.session);
  }
  for (let offset = 0; offset < 10000; offset += 100) {
    const result = await request('sessions.list', {
      archived: 'all',
      workspaceDir,
      includeGlobal: true,
      includeUnknown: true,
      limit: 100,
      offset,
    });
    if (
      !nativeObject(result) ||
      !Array.isArray(result.sessions) ||
      result.sessions.some((row) => !nativeObject(row))
    )
      throw new Error('notification-reset-session-inventory-unavailable');
    for (const row of result.sessions) await observe(row);
    if (result.sessions.length === 100) continue;
    if (found) {
      const warning = `notification-reset-unresolved-session-preserved: ${workspaceDir}; native conversations and their checkout were preserved because the creation receipt does not identify an owned chat`;
      reset.warnings = [...new Set([...(reset.warnings ?? []), warning])];
      for (const resource of reset.resources) {
        if (
          resource.kind === 'worktree' &&
          resource.description === workspaceDir &&
          resource.state !== 'done'
        )
          resource.state = 'preserved';
      }
    }
    return idle;
  }
  throw new Error('notification-reset-session-inventory-incomplete');
}
