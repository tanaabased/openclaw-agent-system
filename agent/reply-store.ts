import { join } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { assessmentSelectionSchema } from './assessment-selection.ts';
import { statusUpdateSchema } from '../tools/dispatch/reply-schema.ts';
import { automationHash } from './automation-hash.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const draftSchema = Type.Object(
  {
    id: hash,
    turnId: text,
    inputId: text,
    target: Type.String({ maxLength: 256000 }),
    privateText: Type.String({ minLength: 1, maxLength: 32000 }),
    outcome: Type.Optional(Type.String({ maxLength: 32000 })),
    update: Type.Optional(statusUpdateSchema),
    configuration: hash,
    selection: assessmentSelectionSchema,
    authorLogin: text,
    authorNodeId: text,
    ownerContext: Type.String({ maxLength: 256000 }),
    publicText: Type.Optional(Type.String({ maxLength: 32000 })),
    attempted: Type.Optional(Type.Boolean()),
    receipt: Type.Optional(
      Type.Object(
        { nodeId: text, databaseId: Type.Integer({ minimum: 1 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const schema = Type.Object(
  { scope: hash, drafts: Type.Array(draftSchema, { maxItems: 40 }) },
  { additionalProperties: false },
);
export type ReplyDraft = Static<typeof draftSchema>;
export interface ReplyBinding {
  runtime: 'codex' | 'openclaw';
  agentId: string;
  workspace: string;
  namespace: string;
  session: string;
  incarnation: string;
}

/** draft custody uses existing private-file and lease primitives, never an intake event. */
export default class ReplyStore {
  readonly scope: string;
  readonly path: string;
  private readonly file: PrivateStateFile;
  constructor(
    private readonly root: string,
    binding: ReplyBinding,
  ) {
    this.scope = automationHash(binding);
    this.path = join(root, `github-reply-${this.scope}.json`);
    this.file = new PrivateStateFile({
      currentUid: process.getuid?.(),
      directories: [root],
      label: 'reply drafts',
      maximumBytes: 8 * 1024 * 1024,
      path: this.path,
    });
  }
  async publication<T>(key: string, run: () => Promise<T>) {
    const lock = await acquirePrivateStateFileLock(
      join(this.root, `github-reply-publication-${automationHash(key)}`),
      { staleMs: 30000, retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 } },
    );
    try {
      return await withPrivateStateLock(lock, run);
    } finally {
      await lock.release();
    }
  }
  async exclusive<T>(run: (drafts: ReplyDraft[], save: () => Promise<void>) => Promise<T>) {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'reply drafts',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await withPrivateStateLock(lock, async () => {
        const contents = await this.file.read();
        const state: unknown =
          contents === undefined ? { scope: this.scope, drafts: [] } : JSON.parse(contents);
        if (!Value.Check(schema, state) || state.scope !== this.scope)
          throw new Error('reply-state-invalid');
        return run(state.drafts, async () => {
          lock.assertHeld();
          if (!Value.Check(schema, state)) throw new Error('reply-state-invalid');
          await this.file.write(JSON.stringify(state));
        });
      });
    } finally {
      await lock.release();
    }
  }
}
