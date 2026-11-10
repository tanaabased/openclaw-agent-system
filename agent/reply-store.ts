import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import nodeErrorCode from '../utils/node-error-code.ts';
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
    feedback: Type.Optional(
      Type.Object(
        {
          ownerId: hash,
          eventId: hash,
          revision: hash,
          source: Type.String({ minLength: 1, maxLength: 256000 }),
          number: Type.Integer({ minimum: 1 }),
          nodeId: text,
          itemType: Type.Union([Type.Literal('issue'), Type.Literal('pull-request')]),
        },
        { additionalProperties: false },
      ),
    ),
    configuration: hash,
    selection: assessmentSelectionSchema,
    authorLogin: text,
    authorNodeId: text,
    ownerContext: Type.String({ maxLength: 256000 }),
    publicText: Type.Optional(Type.String({ maxLength: 32000 })),
    publication: Type.Optional(Type.String({ minLength: 1, maxLength: 65536 })),
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
  { scope: hash, drafts: Type.Array(draftSchema) },
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
  private draftFile(id: string) {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('reply-state-invalid');
    return new PrivateStateFile({
      currentUid: process.getuid?.(),
      directories: [this.root],
      label: 'reply draft',
      maximumBytes: 8 * 1024 * 1024,
      path: join(this.root, `github-reply-${this.scope}-${id}.json`),
    });
  }
  async read(): Promise<ReplyDraft[]> {
    // Older journals remain readable. New writes are bounded per operation, not
    // by the lifetime volume of an otherwise valid conversation.
    const contents = await this.file.read();
    const state: unknown =
      contents === undefined ? { scope: this.scope, drafts: [] } : JSON.parse(contents);
    if (!Value.Check(schema, state) || state.scope !== this.scope)
      throw new Error('reply-state-invalid');
    const drafts = new Map(state.drafts.map((draft) => [draft.id, draft]));
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if (nodeErrorCode(error) !== 'ENOENT') throw error;
      return [...drafts.values()];
    }
    const prefix = `github-reply-${this.scope}-`;
    for (const name of names.sort()) {
      if (!name.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/u.test(name.slice(prefix.length)))
        continue;
      const id = name.slice(prefix.length, -5);
      const content = await this.draftFile(id).read();
      if (content === undefined) throw new Error('reply-state-invalid');
      const draft: unknown = JSON.parse(content);
      if (!Value.Check(draftSchema, draft) || draft.id !== id)
        throw new Error('reply-state-invalid');
      drafts.set(id, draft);
    }
    return [...drafts.values()];
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
        const drafts = await this.read();
        const saved = new Map(drafts.map((draft) => [draft.id, JSON.stringify(draft)]));
        return run(drafts, async () => {
          lock.assertHeld();
          if (!Value.Check(schema, { scope: this.scope, drafts }))
            throw new Error('reply-state-invalid');
          for (const draft of drafts) {
            const content = JSON.stringify(draft);
            if (saved.get(draft.id) === content) continue;
            await this.draftFile(draft.id).write(content);
            saved.set(draft.id, content);
          }
          const removed = [...saved.keys()].filter(
            (id) => !drafts.some((draft) => draft.id === id),
          );
          if (removed.length) {
            // Drop the legacy aggregate first; retained operations already have individual files.
            for (const draft of drafts) await this.draftFile(draft.id).write(JSON.stringify(draft));
            await this.file.remove();
            for (const id of removed) {
              await this.draftFile(id).remove();
              saved.delete(id);
            }
          }
        });
      });
    } finally {
      await lock.release();
    }
  }
}
