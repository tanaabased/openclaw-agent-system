import { randomInt, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import {
  instanceIdPattern,
  instanceNamePattern,
  normalizeInstanceName,
} from '../channels/github/provider/assignment-claim.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

const words = [
  [
    'amber',
    'brisk',
    'calm',
    'cedar',
    'cobalt',
    'copper',
    'coral',
    'crimson',
    'dapper',
    'dusk',
    'fern',
    'gentle',
    'golden',
    'granite',
    'indigo',
    'jade',
    'jolly',
    'lunar',
    'maple',
    'mellow',
    'moss',
    'nimble',
    'ochre',
    'olive',
    'quiet',
    'ruby',
    'silver',
    'solar',
    'spruce',
    'steady',
    'swift',
    'velvet',
  ],
  [
    'badger',
    'beaver',
    'bison',
    'bobcat',
    'crane',
    'dolphin',
    'falcon',
    'finch',
    'fox',
    'gecko',
    'heron',
    'ibis',
    'jay',
    'koala',
    'lemur',
    'lynx',
    'marten',
    'mink',
    'newt',
    'otter',
    'owl',
    'panda',
    'puffin',
    'quail',
    'raven',
    'robin',
    'seal',
    'sparrow',
    'tern',
    'tiger',
    'whale',
    'wren',
  ],
];
const id = Type.String({ pattern: instanceIdPattern.source });
const text = Type.String({ minLength: 1, maxLength: 4096 });
const commentId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const recordSchema = Type.Object(
  {
    instanceId: id,
    firstPass: text,
    attempted: Type.Boolean(),
    commentId: Type.Optional(commentId),
    winnerId: Type.Optional(commentId),
    cleanupPending: Type.Optional(Type.Boolean()),
    cleaned: Type.Optional(Type.Boolean()),
    nativeReceipt: Type.Optional(text),
    recovery: Type.Optional(
      Type.Object(
        { id: text, predecessorReceipt: text, successorReceipt: Type.Optional(text) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const schema = Type.Object(
  {
    version: Type.Literal(1),
    instanceId: id,
    displayName: Type.String({ pattern: instanceNamePattern.source, maxLength: 48 }),
    retiredInstanceIds: Type.Array(id, { uniqueItems: true }),
    claims: Type.Record(Type.String({ pattern: '^[a-f0-9]{64}$' }), recordSchema),
  },
  { additionalProperties: false },
);

export type AssignmentClaimState = Static<typeof schema>;
export type AssignmentClaimRecord = Static<typeof recordSchema>;

/** callers supply the runtime-owned private installation directory, never a manifest path. */
export default class AssignmentClaimStore {
  readonly root: string;
  readonly file: PrivateStateFile;

  constructor(root: string) {
    this.root = resolve(root);
    this.file = new PrivateStateFile({
      directories: [this.root],
      path: join(this.root, 'assignment-claims.json'),
      label: 'assignment claims',
      maximumBytes: 4 * 1024 * 1024,
      currentUid: process.getuid?.(),
    });
  }

  async exclusive<T>(
    operation: (
      state: AssignmentClaimState,
      save: () => Promise<void>,
      signal: AbortSignal,
    ) => Promise<T>,
    initialize = true,
  ): Promise<T> {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'assignment claims',
    });
    const lock = await acquirePrivateStateFileLock(join(this.root, 'assignment-claims.json'), {
      staleMs: 30_000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await withPrivateStateLock(lock, async () => {
        const contents = await this.file.read();
        if (contents === undefined && !initialize) throw new Error('instance-install-required');
        const value: unknown =
          contents === undefined
            ? {
                version: 1,
                instanceId: randomUUID(),
                displayName: words.map((list) => list[randomInt(list.length)]).join('-'),
                retiredInstanceIds: [],
                claims: {},
              }
            : JSON.parse(contents);
        if (!Value.Check(schema, value) || value.retiredInstanceIds.includes(value.instanceId))
          throw new Error('assignment-claim-state-invalid');
        const state = value;
        const save = async () => {
          lock.assertHeld();
          if (!Value.Check(schema, state) || state.retiredInstanceIds.includes(state.instanceId))
            throw new Error('assignment-claim-state-invalid');
          await this.file.write(JSON.stringify(state));
        };
        if (contents === undefined) await save();
        return operation(state, save, lock.signal);
      });
    } finally {
      await lock.release();
    }
  }

  identity() {
    return this.exclusive(async (state) => ({
      instanceId: state.instanceId,
      displayName: state.displayName,
    }));
  }

  /** inspection must never create an identity or repair private state. */
  private async read() {
    const contents = await this.file.read();
    if (contents === undefined) return undefined;
    const state: unknown = JSON.parse(contents);
    if (!Value.Check(schema, state) || state.retiredInstanceIds.includes(state.instanceId))
      throw new Error('assignment-claim-state-invalid');
    return state;
  }

  async inspect() {
    const state = await this.read();
    return state && { instanceId: state.instanceId, displayName: state.displayName };
  }

  /** dormant dispatch may inspect pilot receipts but must never create or mutate them. */
  async assertUnclaimed(key: string) {
    if ((await this.read())?.claims[key]) throw new Error('claim-disabled-pending');
  }

  rename(name: string) {
    const displayName = normalizeInstanceName(name);
    return this.exclusive(async (state, save) => {
      state.displayName = displayName;
      await save();
      return { instanceId: state.instanceId, displayName };
    }, false);
  }

  /** explicit rotation detaches old work; it never rewrites a claim or adopts copied receipts. */
  rotate(expectedInstanceId: string) {
    return this.exclusive(async (state, save) => {
      if (state.instanceId !== expectedInstanceId) throw new Error('instance-rotation-stale');
      state.retiredInstanceIds.push(state.instanceId);
      state.instanceId = randomUUID();
      await save();
      return { instanceId: state.instanceId, displayName: state.displayName };
    }, false);
  }
}
