import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

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
  state: Type.Union([Type.Literal('pending'), Type.Literal('attempted'), Type.Literal('done')]),
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

/** only the reset owner may write managed state while its recovery record exists. */
export async function assertNotificationManagement(root: string, scope: string): Promise<void> {
  const store = new NotificationResetStore(root, scope);
  if (access.getStore() !== store.path && (await store.read()))
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
  ) {
    this.path = join(root, `notification-reset-${scope}.json`);
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [root],
      currentUid: process.getuid?.(),
      maximumBytes: 32 * 1024 * 1024,
      label: 'notification reset',
    });
  }
  async read(): Promise<NotificationResetRecord | undefined> {
    const contents = await this.file.read();
    if (contents === undefined) return;
    const record: unknown = JSON.parse(contents);
    if (!Value.Check(schema, record) || record.scope !== this.scope)
      throw new Error('notification-reset-state-invalid');
    return record;
  }
  async exclusive<T>(
    run: (
      record: NotificationResetRecord | undefined,
      save: (record: NotificationResetRecord) => Promise<void>,
      remove: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'notification reset',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await withPrivateStateLock(lock, () =>
        access.run(this.path, async () =>
          run(
            await this.read(),
            async (record) => {
              lock.assertHeld();
              if (!Value.Check(schema, record) || record.scope !== this.scope)
                throw new Error('notification-reset-state-invalid');
              await this.file.write(JSON.stringify(record));
            },
            async () => {
              lock.assertHeld();
              await this.file.remove();
            },
          ),
        ),
      );
    } finally {
      await lock.release();
    }
  }
}
