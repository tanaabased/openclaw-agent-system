import { randomUUID } from 'node:crypto';

import { automationHash } from './automation-hash.ts';
import type NotificationResetStore from './notification-reset-state.ts';
import type {
  NotificationResetRecord,
  NotificationResetResource,
} from './notification-reset-state.ts';

export interface NotificationResetSnapshot {
  runtime: 'codex' | 'openclaw';
  agentId: string;
  workspace: string;
  scope: string;
  automation: string;
  inventory: string;
  resources: NotificationResetResource[];
}

export interface NotificationResetEffect {
  status: 'done' | 'waiting' | 'native-action' | 'incomplete';
  code?: string;
  request?: { tool: string; arguments: Record<string, unknown> };
  instruction?: string;
}

export interface NotificationResetAdapter {
  fence<T>(run: () => Promise<T>): Promise<T>;
  snapshot(): Promise<NotificationResetSnapshot>;
  pause(record: NotificationResetRecord): Promise<NotificationResetEffect>;
  idle(record: NotificationResetRecord): Promise<NotificationResetEffect>;
  clear(record: NotificationResetRecord): Promise<void>;
  purge(
    record: NotificationResetRecord,
    resource: NotificationResetResource,
  ): Promise<NotificationResetEffect>;
  baseline(record: NotificationResetRecord): Promise<void>;
  restore(record: NotificationResetRecord): Promise<NotificationResetEffect>;
}

export interface NotificationResetPreview extends NotificationResetSnapshot {
  operationId?: string;
  purge: boolean;
  continuing: boolean;
  fingerprint: string;
}

/** confirmation stays in the operator interface; the fingerprint never needs to be copied. */
export async function previewNotificationReset(
  store: NotificationResetStore,
  adapter: NotificationResetAdapter,
  purge: boolean,
): Promise<NotificationResetPreview> {
  return store.exclusive(async (retained) => {
    const snapshot = retained ?? (await adapter.snapshot());
    if (retained && retained.purge !== purge) throw new Error('notification-reset-mode-conflict');
    return {
      ...snapshot,
      purge,
      continuing: Boolean(retained),
      ...(retained ? { operationId: retained.id } : {}),
      fingerprint: automationHash(snapshot),
    };
  });
}

/** an interrupted operation is resumed by repeating the same reset, never by deleting its map. */
export default async function resetNotifications(input: {
  store: NotificationResetStore;
  adapter: NotificationResetAdapter;
  preview: NotificationResetPreview;
  now?: () => number;
}) {
  const { store, adapter, preview } = input;
  return store.exclusive(async (retained, save, remove) => {
    const record = await adapter.fence(async () => {
      const snapshot = retained ?? (await adapter.snapshot());
      if (
        automationHash(snapshot) !== preview.fingerprint ||
        snapshot.scope !== store.scope ||
        snapshot.agentId !== preview.agentId ||
        snapshot.workspace !== preview.workspace ||
        (retained && retained.purge !== preview.purge)
      )
        throw new Error('notification-reset-preview-changed');
      const record: NotificationResetRecord = retained ?? {
        ...snapshot,
        version: 1,
        id: randomUUID(),
        purge: preview.purge,
        createdAt: (input.now ?? Date.now)(),
        phase: 'pause',
      };
      await save(record);
      return record;
    });
    const pending = async (effect: NotificationResetEffect) => {
      if (effect.request) {
        const request = JSON.stringify(effect.request);
        if (record.nativeRequest === request)
          effect = {
            status: 'incomplete',
            code: 'notification-reset-native-action-unverified',
            instruction:
              'the requested native action has not been verified; inspect its result before retrying it',
          };
        else {
          record.nativeRequest = request;
          await save(record);
        }
      }
      return {
        ...effect,
        operationId: record.id,
        agentId: record.agentId,
        workspace: record.workspace,
        phase: record.phase,
        intakePaused: record.phase !== 'pause',
        resources: record.resources,
      };
    };
    if (record.phase !== 'pause' && record.phase !== 'restore') {
      const effect = await adapter.pause({ ...record, pauseAttempted: true });
      if (effect.status !== 'done') return pending(effect);
    }
    if (record.phase === 'pause') {
      const previous = record.pauseAttempted;
      record.pauseAttempted = true;
      await save(record);
      const effect = await adapter.pause({ ...record, pauseAttempted: previous });
      if (effect.status !== 'done') return pending(effect);
      record.phase = 'drain';
      await save(record);
    }
    if (record.phase !== 'restore') {
      const effect = await adapter.idle(record);
      if (effect.status !== 'done') return pending(effect);
      if (record.phase === 'drain') {
        record.phase = 'clear';
        await save(record);
      }
    }
    if (record.phase === 'clear') {
      await adapter.clear(record);
      record.phase = record.purge ? 'purge' : 'baseline';
      await save(record);
    }
    if (record.phase === 'purge') {
      for (const resource of record.resources) {
        if (resource.state === 'done') continue;
        // persist intent before submission so an uncertain result is observed before retry.
        const previous = resource.state;
        resource.state = 'attempted';
        await save(record);
        const effect = await adapter.purge(record, { ...resource, state: previous });
        if (effect.status !== 'done') return pending(effect);
        resource.state = 'done';
        await save(record);
      }
      record.phase = 'baseline';
      await save(record);
    }
    if (record.phase === 'baseline') {
      record.baselineAt ??= (input.now ?? Date.now)();
      await save(record);
      await adapter.baseline(record);
      record.phase = 'restore';
      await save(record);
    }
    const effect = await adapter.restore(record);
    if (effect.status !== 'done') return pending(effect);
    await remove();
    return {
      status: 'complete' as const,
      operationId: record.id,
      agentId: record.agentId,
      workspace: record.workspace,
      resources: record.resources,
      automationRestored: true,
    };
  });
}
