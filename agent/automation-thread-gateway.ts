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
    if (!row || typeof row.sessionId !== 'string')
      throw new AutomationError('automation-thread-unavailable');
    if (
      typeof row.workspaceDir !== 'string' ||
      (await realpath(row.workspaceDir).catch(() => '')) !== context.workspaceDir
    )
      throw new AutomationError('automation-thread-workspace-mismatch');
    return {
      id: key,
      incarnation: row.sessionId,
      ...(typeof row.lifecycleRevision === 'string'
        ? { lifecycleRevision: row.lifecycleRevision }
        : {}),
      ...(typeof row.model === 'string'
        ? {
            model: row.model.includes('/')
              ? row.model
              : typeof row.modelProvider === 'string'
                ? `${row.modelProvider}/${row.model}`
                : undefined,
          }
        : {}),
      ...(typeof row.thinkingLevel === 'string' ? { effort: row.thinkingLevel } : {}),
      archived: row.archived === true,
      ...(typeof row.displayName === 'string' ? { name: row.displayName } : {}),
      ...(typeof row.category === 'string' ? { group: row.category } : {}),
      sessionId: row.sessionId,
      label: row.label,
      autoLabel: row.autoLabel,
    };
  }
  return {
    lookup,
    async create(record, saveId, _fresh, settings) {
      const key =
        record.nativeId ??
        `agent:${context.agentId}:automation:${context.scope}:${record.key}${record.generation ? `:${record.generation}` : ''}`;
      if (!record.nativeId) await saveId(key);
      if (!(await lookup(key)))
        await request('sessions.create', {
          key,
          agentId: context.agentId,
          cwd: context.workspaceDir,
          ...(settings?.model ? { model: settings.model } : {}),
          ...(settings?.effort ? { thinkingLevel: settings.effort } : {}),
        });
      return key;
    },
    async updateSettings(current, settings) {
      const latest = await lookup(current.id);
      if (
        !latest ||
        latest.incarnation !== current.incarnation ||
        latest.model !== current.model ||
        latest.effort !== current.effort
      )
        throw new AutomationError('automation-thread-settings-conflict');
      try {
        await request('sessions.patch', {
          key: current.id,
          expectedSessionId: latest.sessionId,
          ...(latest.lifecycleRevision
            ? { expectedLifecycleRevision: latest.lifecycleRevision }
            : {}),
          ...(settings.model === undefined ? {} : { model: settings.model }),
          ...(settings.effort === undefined ? {} : { thinkingLevel: settings.effort }),
        });
      } catch (error) {
        if (error instanceof AutomationError && error.diagnostic?.category === 'rejected')
          throw new AutomationError('automation-thread-settings-denied', error.diagnostic);
        throw error;
      }
    },
    async setGroup(id, group) {
      const current = await lookup(id);
      if (!current) throw new AutomationError('automation-thread-recovery-required');
      await request('sessions.patch', {
        key: id,
        expectedSessionId: current.sessionId,
        category: group,
      });
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
