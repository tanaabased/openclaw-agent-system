import { realpath } from 'node:fs/promises';

import { AutomationError, nativeObject, type AutomationGateway } from './automation-gateway.ts';
import type { AutomationThreadAdapter } from './automation-threads.ts';

/** operator-only native session transport. never inspect or edit the Gateway's private stores. */
export default function automationThreadGateway(
  request: AutomationGateway,
  context: { agentId: string; workspaceDir: string; scope: string },
): AutomationThreadAdapter {
  async function lookup(id: string) {
    let resolved = await request('sessions.resolve', {
      key: id,
      agentId: context.agentId,
      allowMissing: true,
    });
    if (
      resolved.ok === false &&
      (resolved.candidates === undefined ||
        (Array.isArray(resolved.candidates) && resolved.candidates.length === 0))
    )
      resolved = await request('sessions.resolve', {
        sessionId: id,
        agentId: context.agentId,
        allowMissing: true,
      });
    if (
      resolved.ok === false &&
      (resolved.candidates === undefined ||
        (Array.isArray(resolved.candidates) && resolved.candidates.length === 0))
    )
      return null;
    if (
      resolved.ok !== true ||
      typeof resolved.key !== 'string' ||
      resolved.agentId !== context.agentId
    )
      throw new AutomationError('automation-thread-owner-mismatch');
    const key = resolved.key;
    let row: Record<string, unknown> | undefined;
    for (let offset = 0; offset < 100000; offset += 100) {
      const page = await request('sessions.list', {
        agentId: context.agentId,
        archived: 'all',
        limit: 100,
        offset,
        includeDerivedTitles: false,
        includeLastMessage: false,
      });
      if (!Array.isArray(page.sessions) || page.sessions.some((item) => !nativeObject(item)))
        throw new AutomationError('automation-thread-response-invalid');
      const rows = page.sessions as Record<string, unknown>[];
      row = rows.find((item) => item.key === key);
      if (row || rows.length < 100) break;
    }
    if (!row || row.archived === true || typeof row.sessionId !== 'string')
      throw new AutomationError('automation-thread-unavailable');
    if (
      typeof row.workspaceDir !== 'string' ||
      (await realpath(row.workspaceDir).catch(() => '')) !== context.workspaceDir
    )
      throw new AutomationError('automation-thread-workspace-mismatch');
    return {
      id: key,
      ...(typeof row.displayName === 'string' ? { name: row.displayName } : {}),
      sessionId: row.sessionId,
      label: row.label,
      autoLabel: row.autoLabel,
    };
  }
  return {
    lookup,
    async create(record, saveId) {
      const key =
        record.nativeId ?? `agent:${context.agentId}:automation:${context.scope}:${record.key}`;
      if (!record.nativeId) await saveId(key);
      if (!(await lookup(key)))
        await request('sessions.create', {
          key,
          idempotencyKey: key,
          agentId: context.agentId,
          cwd: context.workspaceDir,
        });
      return key;
    },
    async rename(id, name) {
      const current = await lookup(id);
      if (!current) throw new AutomationError('automation-thread-recovery-required');
      // autoLabel is nonunique; an existing explicit title retains the native label semantics.
      await request('sessions.patch', {
        key: id,
        expectedSessionId: current.sessionId,
        ...(current.label || (current.name && current.name !== current.autoLabel)
          ? { label: name }
          : { autoLabel: name }),
      });
    },
  };
}
