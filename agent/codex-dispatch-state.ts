import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { assessmentResultSchema } from './assessment-result.ts';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const dispatchProjectSchema = Type.Object(
  {
    id: text,
    path: text,
    commonDir: text,
    ref: text,
    commit: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
  },
  { additionalProperties: false },
);
export type DispatchProject = Static<typeof dispatchProjectSchema>;
const creationSchema = Type.Object(
  {
    title: text,
    prompt: Type.String({ minLength: 1, maxLength: 128000 }),
    model: text,
    thinking: text,
    target: Type.Object(
      {
        type: Type.Literal('project'),
        projectId: text,
        environment: Type.Object(
          {
            type: Type.Literal('worktree'),
            startingState: Type.Object(
              { type: Type.Literal('branch'), branchName: text },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const dispatchRecordSchema = Type.Object(
  {
    id: hash,
    intakeId: hash,
    issueKey: hash,
    sourceThreadId: text,
    phase: Type.Union([
      Type.Literal('routing'),
      Type.Literal('creating'),
      Type.Literal('assessing'),
      Type.Literal('complete'),
      Type.Literal('blocked'),
    ]),
    createdAt: Type.Integer({ minimum: 0 }),
    manifestDigest: text,
    assessment: Type.Optional(assessmentSelectionSchema),
    project: Type.Optional(dispatchProjectSchema),
    context: Type.Optional(Type.String({ maxLength: 96000 })),
    routing: Type.Optional(Type.String({ maxLength: 32000 })),
    routingNote: Type.Optional(text),
    request: Type.Optional(creationSchema),
    deniedCreations: Type.Optional(
      Type.Array(
        Type.Object(
          {
            request: creationSchema,
            createdAt: Type.Integer({ minimum: 0 }),
            recoveredAt: Type.Integer({ minimum: 0 }),
            turnId: text,
            callId: text,
            approvedBy: Type.Optional(text),
          },
          { additionalProperties: false },
        ),
        { maxItems: 8 },
      ),
    ),
    clientThreadId: Type.Optional(text),
    receiptThreadId: Type.Optional(text),
    threadId: Type.Optional(text),
    worktree: Type.Optional(text),
    effective: Type.Optional(
      Type.Object(
        {
          status: Type.Union([Type.Literal('verified'), Type.Literal('unverified')]),
          model: Type.Optional(text),
          effort: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
    result: Type.Optional(assessmentResultSchema),
    resultTurnId: Type.Optional(text),
    reset: Type.Optional(
      Type.Object({ at: Type.Integer({ minimum: 0 }), by: text }, { additionalProperties: false }),
    ),
    retired: Type.Optional(
      Type.Object({ at: Type.Integer({ minimum: 0 }), by: text }, { additionalProperties: false }),
    ),
    notice: Type.Optional(hash),
    // accept journals from the earlier model-mediated title repair.
    renameRequested: Type.Optional(Type.Boolean()),
    retryAfter: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type DispatchRecord = Static<typeof dispatchRecordSchema>;
const schema = Type.Object(
  { version: Type.Literal(1), scope: hash, records: Type.Array(dispatchRecordSchema) },
  { additionalProperties: false },
);
export type DispatchState = Static<typeof schema>;

/** one journal bridges native actions; a persisted creation intent is never issued twice. */
export default class CodexDispatchStore {
  readonly file: PrivateStateFile;
  readonly path: string;
  constructor(
    readonly root: string,
    readonly scope: string,
  ) {
    this.path = join(root, 'codex-dispatch-' + scope + '.json');
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [root],
      currentUid: process.getuid?.(),
      label: 'Codex issue dispatch',
      maximumBytes: 4 * 1024 * 1024,
    });
  }
  async read(): Promise<DispatchState> {
    const contents = await this.file.read();
    const state: unknown =
      contents === undefined
        ? { version: 1, scope: this.scope, records: [] }
        : JSON.parse(contents);
    if (
      !Value.Check(schema, state) ||
      state.scope !== this.scope ||
      new Set(state.records.map((r) => r.id)).size !== state.records.length ||
      new Set(state.records.filter((r) => !r.reset && !r.retired).map((r) => r.issueKey)).size !==
        state.records.filter((r) => !r.reset && !r.retired).length ||
      state.records.some(
        (r) =>
          (r.request && (!r.project || !r.context || !r.routing || !r.routingNote)) ||
          (['creating', 'assessing', 'complete'].includes(r.phase) && !r.request) ||
          (r.phase === 'complete' && !r.result),
      ) ||
      state.records.some((r) => r.reset && (r.phase !== 'complete' || !r.threadId))
    )
      throw new Error('dispatch-state-invalid');
    return state;
  }
  async exclusive<T>(
    run: (state: DispatchState, save: () => Promise<void>, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'Codex issue dispatch',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await withPrivateStateLock(lock, async () => {
        const state = await this.read();
        return run(
          state,
          async () => {
            lock.assertHeld();
            if (!Value.Check(schema, state)) throw new Error('dispatch-state-invalid');
            const contents = JSON.stringify(state);
            if (Buffer.byteLength(contents) > 4 * 1024 * 1024)
              throw new Error('dispatch-state-capacity');
            await this.file.write(contents);
          },
          lock.signal,
        );
      });
    } finally {
      await lock.release();
    }
  }
}
