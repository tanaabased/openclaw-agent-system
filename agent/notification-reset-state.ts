import withWorkflowLock from './storage/workflow-lock.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import PrivateStateFile from '../core/private-state-file.ts';

import type { BoundStorage } from './storage/storage-lifecycle.ts';
import nodeErrorCode from '../utils/node-error-code.ts';

const maximumBytes = 32 * 1024 * 1024;
const text = Type.String({ minLength: 1, maxLength: 4096 });
const resource = Type.Object({
  id: text,
  kind: Type.Union([
    Type.Literal('chat'),
    Type.Literal('coordinator'),
    Type.Literal('pull-request'),
    Type.Literal('worktree'),
  ]),
  description: text,
  identity: Type.String({ minLength: 1, maxLength: 65536 }),
  custody: Type.Optional(Type.String({ minLength: 1, maxLength: 65536 })),
  details: Type.Array(Type.String({ maxLength: 16000 }), { maxItems: 1000 }),
  state: Type.Union([
    Type.Literal('pending'),
    Type.Literal('attempted'),
    Type.Literal('done'),
    Type.Literal('preserved'),
  ]),
});
const schema = Type.Object(
  {
    version: Type.Literal(1),
    id: text,
    runtime: Type.Union([Type.Literal('codex'), Type.Literal('openclaw')]),
    agentId: text,
    workspace: text,
    scope: text,
    purge: Type.Boolean(),
    fresh: Type.Optional(Type.Boolean()),
    warnings: Type.Optional(Type.Array(text)),
    createdAt: Type.Integer({ minimum: 0 }),
    phase: Type.Union([
      Type.Literal('pause'),
      Type.Literal('drain'),
      Type.Literal('clear'),
      Type.Literal('purge'),
      Type.Literal('baseline'),
      Type.Literal('restore'),
      Type.Literal('coordinator'),
    ]),
    automation: Type.String({ minLength: 1, maxLength: 128000 }),
    coordinatorReplaced: Type.Optional(Type.Boolean()),
    pickup: Type.Optional(
      Type.Object(
        {
          automation: Type.String({ minLength: 1, maxLength: 128000 }),
          pauseAttempted: Type.Optional(Type.Boolean()),
          coordinatorArchiveAttempted: Type.Optional(Type.Boolean()),
          coordinatorUpdateAttempted: Type.Optional(Type.Boolean()),
          coordinatorReplaced: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    inventory: Type.String({ minLength: 1, maxLength: 12 * 1024 * 1024 }),
    resources: Type.Array(resource, { maxItems: 3000 }),
    coordinatorArchiveAttempted: Type.Optional(Type.Boolean()),
    coordinatorUpdateAttempted: Type.Optional(Type.Boolean()),
    baselineAt: Type.Optional(Type.Integer({ minimum: 0 })),
    pauseAttempted: Type.Optional(Type.Boolean()),
    nativeRequest: Type.Optional(Type.String({ maxLength: 128000 })),
  },
  { additionalProperties: false },
);
export type NotificationResetRecord = Static<typeof schema>;
export type NotificationResetResource = Static<typeof resource>;

const access = new AsyncLocalStorage<string>();

export function ownsNotificationReset(root: string, scope: string) {
  return access.getStore() === join(root, `notification-reset-${scope}.json`);
}

/** only the reset owner may write managed state while its recovery record exists. */
export async function assertNotificationManagement(
  root: string,
  scope: string,
  storage?: BoundStorage['agent'],
): Promise<void> {
  const store = new NotificationResetStore(root, scope, storage);
  if (!ownsNotificationReset(root, scope) && (await store.read()))
    throw Object.assign(new Error('notification-reset-in-progress'), {
      code: 'notification-reset-in-progress',
    });
}

export default class NotificationResetStore {
  readonly path: string;
  readonly file: PrivateStateFile;
  constructor(
    readonly root: string,
    readonly scope: string,
    private readonly storage?: BoundStorage['agent'],
  ) {
    this.path = join(root, `notification-reset-${scope}.json`);
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [root],
      currentUid: process.getuid?.(),
      maximumBytes,
      label: 'notification reset',
    });
  }
  private async readSaved(): Promise<unknown> {
    if (this.storage) {
      const rows = await this.storage
        .read({ notificationResets: { scope: this.scope } })
        .catch((error: unknown) => {
          if (nodeErrorCode(error) !== 'ENOENT') throw error;
          return { notificationResets: [] };
        });
      return rows.notificationResets[0]?.value;
    }
    const contents = await this.file.read();
    return contents === undefined ? undefined : JSON.parse(contents);
  }
  async read(): Promise<NotificationResetRecord | undefined> {
    const record = await this.readSaved();
    if (record === undefined) return;
    if (!Value.Check(schema, record) || record.scope !== this.scope)
      throw new Error('notification-reset-state-invalid');
    return record;
  }
  // Applying the preview verifies its fingerprint again under the reset and dispatch locks.
  async inspect<T>(run: (record?: NotificationResetRecord) => Promise<T>) {
    return this.storage ? run(await this.read()) : this.exclusive(run);
  }
  async intakeCheckpoint() {
    if (this.storage) return { expected: await this.storage.readIntake(this.scope) };
  }
  async exclusive<T>(
    run: (
      record: NotificationResetRecord | undefined,
      save: (
        record: NotificationResetRecord,
        checkpoint?: Awaited<ReturnType<NotificationResetStore['intakeCheckpoint']>>,
      ) => Promise<void>,
      remove: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return withWorkflowLock(this.path, 'notification reset', (lock) =>
      access.run(this.path, async () =>
        run(
          await this.read(),
          async (record, checkpoint) => {
            lock.assertHeld();
            if (!Value.Check(schema, record) || record.scope !== this.scope)
              throw new Error('notification-reset-state-invalid');
            const contents = JSON.stringify(record);
            if (!this.storage) return this.file.write(contents);
            if (Buffer.byteLength(contents) > maximumBytes)
              throw new Error('The notification reset exceeds its size limit.');
            if (checkpoint) return this.storage.beginNotificationReset(record, checkpoint.expected);
            await this.storage.write([
              {
                table: 'notificationResets',
                action: 'save',
                row: { scope: this.scope, value: record },
              },
            ]);
          },
          async () => {
            lock.assertHeld();
            if (!this.storage) {
              await this.file.remove();
              return;
            }
            await this.storage.write([
              { table: 'notificationResets', action: 'remove', key: { scope: this.scope } },
            ]);
          },
        ),
      ),
    );
  }
}
