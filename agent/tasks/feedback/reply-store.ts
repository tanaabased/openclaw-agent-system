import type { SessionStorage } from '../../storage/storage-lifecycle.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { statusUpdateSchema } from '../../../tools/dispatch/reply-schema.ts';
import { assessmentSelectionSchema } from '../assessment/assessment-selection.ts';
import { automationHash } from '../../automation-hash.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const draftSchema = Type.Object(
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
    ownerId: Type.Optional(hash),
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

/** Bind reply drafts and publication leases to their existing native custody. */
export default class ReplyStore {
  readonly scope: string;
  constructor(
    binding: ReplyBinding,
    private readonly storage: SessionStorage,
  ) {
    this.scope = automationHash(binding);
  }
  async read(): Promise<ReplyDraft[]> {
    const drafts = await this.storage.readReplies(this.scope);
    if (!Value.Check(schema, { scope: this.scope, drafts })) throw new Error('reply-state-invalid');
    return drafts;
  }
  async edit<T>(run: (drafts: ReplyDraft[], save: () => Promise<void>) => Promise<T>) {
    const drafts = await this.read();
    let checkSelection = true;
    const saved = new Map(drafts.map((draft) => [draft.id, JSON.stringify(draft)]));
    return run(drafts, async () => {
      if (!Value.Check(schema, { scope: this.scope, drafts }))
        throw new Error('reply-state-invalid');
      const changed = drafts.filter((draft) => saved.get(draft.id) !== JSON.stringify(draft));
      const removed = [...saved.keys()].filter((id) => !drafts.some((draft) => draft.id === id));
      await this.storage.saveReplies(this.scope, saved, changed, removed, checkSelection);
      // Once the send is reserved, its receipt depends only on the rows being updated.
      checkSelection = false;
      for (const draft of changed) {
        const content = JSON.stringify(draft);
        saved.set(draft.id, content);
      }
      for (const id of removed) {
        saved.delete(id);
      }
    });
  }
}
