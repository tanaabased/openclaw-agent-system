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
  automation?: string;
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
  coordinator(
    record: NotificationResetRecord,
    save: (record: NotificationResetRecord) => Promise<void>,
  ): Promise<NotificationResetEffect>;
  restore(record: NotificationResetRecord): Promise<NotificationResetEffect>;
}

export interface NotificationResetPreview extends NotificationResetSnapshot {
  operationId?: string;
  purge: boolean;
  continuing: boolean;
  fresh?: boolean;
  restarting?: boolean;
  fingerprint: string;
}

/** confirmation stays in the operator interface; the fingerprint never needs to be copied. */
export async function previewNotificationReset(
  store: NotificationResetStore,
  adapter: NotificationResetAdapter,
  purge: boolean,
  fresh = false,
): Promise<NotificationResetPreview> {
  return store.exclusive(async (retained) => {
    const snapshot = retained ?? (await adapter.snapshot());
    if (retained && retained.purge !== purge) throw new Error('notification-reset-mode-conflict');
    return {
      ...snapshot,
      purge,
      continuing: Boolean(retained),
      fresh,
      restarting: fresh && Boolean(retained) && !retained?.fresh,
      ...(retained ? { operationId: retained.id } : {}),
      fingerprint: automationHash([snapshot, fresh]),
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
        automationHash([snapshot, preview.fresh === true]) !== preview.fingerprint ||
        snapshot.scope !== store.scope ||
        snapshot.agentId !== preview.agentId ||
        snapshot.workspace !== preview.workspace ||
        (retained && retained.purge !== preview.purge)
      )
        throw new Error('notification-reset-preview-changed');
      const restart = preview.fresh === true && !retained?.fresh;
      const record: NotificationResetRecord =
        retained && !restart
          ? retained
          : {
              ...snapshot,
              ...retained,
              version: 1,
              id: randomUUID(),
              purge: preview.purge,
              fresh: preview.fresh === true,
              createdAt: (input.now ?? Date.now)(),
              // submitted coordinator actions must be reconciled, never issued again.
              phase:
                retained && ['coordinator', 'restore'].includes(retained.phase)
                  ? retained.phase
                  : 'pause',
            };
      if (restart && record.phase === 'pause') delete record.baselineAt;
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
        ...(record.warnings?.length ? { warnings: record.warnings } : {}),
      };
    };
    if (record.phase !== 'pause' && record.phase !== 'restore' && record.phase !== 'coordinator') {
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
    if (record.phase !== 'restore' && record.phase !== 'coordinator') {
      const effect = await adapter.idle(record);
      await save(record);
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
        if (
          resource.state === 'done' ||
          resource.state === 'preserved' ||
          resource.kind === 'coordinator'
        )
          continue;
        if (resource.kind === 'pull-request') {
          resource.state = 'done';
          await save(record);
          continue;
        }
        // persist intent before submission so an uncertain result is observed before retry.
        const previous = resource.state;
        resource.state = 'attempted';
        await save(record);
        const effect = await adapter.purge(record, { ...resource, state: previous });
        await save(record);
        if (effect.status !== 'done') return pending(effect);
        if (record.resources.find(({ id }) => id === resource.id)?.state !== 'preserved')
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
      record.phase = 'coordinator';
      await save(record);
    }
    if (record.phase === 'coordinator') {
      const replacement = await adapter.coordinator(record, save);
      if (replacement.status !== 'done') return pending(replacement);
      if (replacement.automation) record.automation = replacement.automation;
      for (const resource of record.resources) {
        if (resource.kind === 'coordinator') resource.state = 'done';
      }
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
      ...(record.warnings?.length ? { warnings: record.warnings } : {}),
    };
  });
}
