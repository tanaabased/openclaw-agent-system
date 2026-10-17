import { join } from 'node:path';

import { Type, type Static, type TObject, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { assessmentResultSchema } from './assessment-result.ts';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { codexNoticeSchema, codexNoticeLimit } from './codex-notice-outbox.ts';
import { workflowBindingSchema } from './workflow-result.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const dispatchRecordProperties = {
  id: hash,
  intakeId: hash,
  issueKey: hash,
  sourceThreadId: text,
  phase: Type.Union([
    Type.Literal('routing'),
    Type.Literal('creating'),
    Type.Literal('created'),
    Type.Literal('assessing'),
    Type.Literal('complete'),
    Type.Literal('blocked'),
  ]),
  createdAt: Type.Integer({ minimum: 0 }),
  manifestDigest: text,
  assessment: Type.Optional(assessmentSelectionSchema),
  context: Type.Optional(Type.String({ maxLength: 96000 })),
  routing: Type.Optional(Type.String({ maxLength: 32000 })),
  routingNote: Type.Optional(text),
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
  stageReceipt: Type.Optional(
    Type.Object(
      {
        binding: workflowBindingSchema,
        resultDigest: hash,
      },
      { additionalProperties: false },
    ),
  ),
  resultTurnId: Type.Optional(text),
  reset: Type.Optional(
    Type.Object({ at: Type.Integer({ minimum: 0 }), by: text }, { additionalProperties: false }),
  ),
  retired: Type.Optional(
    Type.Object({ at: Type.Integer({ minimum: 0 }), by: text }, { additionalProperties: false }),
  ),
  handoff: Type.Optional(
    Type.Object(
      { at: Type.Integer({ minimum: 0 }), by: text, turnId: text },
      { additionalProperties: false },
    ),
  ),
  notice: Type.Optional(hash), // legacy presentation metadata; never used for intake decisions.
  dispatchedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  intakeReportedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  retryAfter: Type.Optional(Type.Integer({ minimum: 0 })),
};
export type SharedDispatchRecord = Static<TObject<typeof dispatchRecordProperties>> & {
  request?: unknown;
};

export function dispatchStateSchema<R extends SharedDispatchRecord>(recordSchema: TSchema) {
  return Type.Object(
    {
      version: Type.Literal(1),
      scope: hash,
      records: Type.Array(Type.Unsafe<R>(recordSchema)),
      continuationRun: Type.Optional(
        Type.Object(
          { id: text, actions: Type.Integer({ minimum: 0, maximum: 12 }) },
          { additionalProperties: false },
        ),
      ),
      run: Type.Optional(
        Type.Object(
          {
            id: text,
            automationId: text,
            currentTimeIso: text,
            actions: Type.Integer({ minimum: 0, maximum: 12 }),
            stopped: Type.Optional(Type.Literal('blocked')),
            response: Type.Optional(Type.String({ maxLength: 128000 })),
          },
          { additionalProperties: false },
        ),
      ),
      intakeReport: Type.Optional(
        Type.Object(
          {
            fingerprint: hash,
            problems: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 256 }),
            runId: text,
            response: Type.String({ maxLength: 128000 }),
          },
          { additionalProperties: false },
        ),
      ),
      intakeHealth: Type.Optional(Type.String({ maxLength: 128 })),
      checked: Type.Optional(
        Type.Object(
          { at: Type.Integer({ minimum: 0 }), digest: hash },
          { additionalProperties: false },
        ),
      ),
      notices: Type.Optional(Type.Array(codexNoticeSchema, { maxItems: codexNoticeLimit })),
      reports: Type.Optional(
        Type.Array(
          Type.Object(
            {
              response: Type.String({ minLength: 1, maxLength: 128000 }),
              automationId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
              createdAt: Type.Integer({ minimum: 0 }),
              notices: Type.Array(hash, { maxItems: 100 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 8 },
        ),
      ),
    },
    { additionalProperties: false },
  );
}
export type DispatchState<R extends SharedDispatchRecord> = Static<
  ReturnType<typeof dispatchStateSchema<R>>
>;

const contentBytes = 4 * 1024 * 1024;
// a bounded report may expand under json escaping; producers cannot consume this reserve.
const journalBytes = contentBytes + 1024 * 1024;

function serializeState<R extends SharedDispatchRecord>(state: DispatchState<R>) {
  const contents = JSON.stringify(state);
  if (
    Buffer.byteLength(contents) > journalBytes ||
    Buffer.byteLength(
      JSON.stringify({
        ...state,
        reports: undefined,
        run: state.run && { ...state.run, response: undefined },
      }),
    ) > contentBytes
  )
    throw new Error('dispatch-state-capacity');
  return contents;
}

/** one journal bridges native actions; a persisted creation intent is never issued twice. */
export default class DispatchStore<R extends SharedDispatchRecord> {
  readonly file: PrivateStateFile;
  readonly schema: ReturnType<typeof dispatchStateSchema<R>>;
  readonly path: string;
  constructor(
    readonly root: string,
    readonly scope: string,
    readonly contract: {
      runtime: 'codex' | 'openclaw';
      recordSchema: TSchema;
      validRecord(record: R): boolean;
    },
  ) {
    this.schema = dispatchStateSchema<R>(contract.recordSchema);
    this.path = join(root, contract.runtime + '-dispatch-' + scope + '.json');
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [root],
      currentUid: process.getuid?.(),
      label: this.contract.runtime + ' issue dispatch',
      maximumBytes: journalBytes,
    });
  }
  private validate(state: unknown): asserts state is DispatchState<R> {
    if (
      !Value.Check(this.schema, state) ||
      state.scope !== this.scope ||
      new Set(state.records.map((r) => r.id)).size !== state.records.length ||
      new Set(state.records.filter((r) => !r.reset && !r.retired).map((r) => r.issueKey)).size !==
        state.records.filter((r) => !r.reset && !r.retired).length ||
      state.records.some(
        (r) =>
          (r.request && (!r.context || !r.routing || !r.routingNote)) ||
          (['creating', 'assessing', 'complete'].includes(r.phase) && !r.request) ||
          (r.phase === 'created' &&
            (this.contract.runtime !== 'openclaw' || !r.request || !r.threadId || !r.effective)) ||
          (r.phase === 'complete' && !r.result) ||
          (r.handoff && (!r.request || !r.threadId || !r.worktree)),
      ) ||
      state.records.some((r) => r.reset && (r.phase !== 'complete' || !r.threadId)) ||
      state.records.some((r) => !this.contract.validRecord(r))
    )
      throw new Error('dispatch-state-invalid');
  }
  async read(): Promise<DispatchState<R>> {
    const contents = await this.file.read();
    let state: unknown = { version: 1, scope: this.scope, records: [] };
    if (contents !== undefined) {
      try {
        state = JSON.parse(contents);
      } catch {
        throw new Error('dispatch-state-invalid');
      }
    }
    this.validate(state);
    // discard obsolete presentation queues, preserving all assignment and assessment records.
    delete state.notices;
    delete state.reports;
    serializeState(state);
    return state;
  }
  async exclusive<T>(
    run: (state: DispatchState<R>, save: () => Promise<void>, signal: AbortSignal) => Promise<T>,
    waitForLock = false,
  ): Promise<T> {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: this.contract.runtime + ' issue dispatch',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30000,
      retries: waitForLock
        ? { retries: 40, factor: 1, minTimeout: 250, maxTimeout: 250 }
        : { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await withPrivateStateLock(lock, async () => {
        const state = await this.read();
        return run(
          state,
          async () => {
            lock.assertHeld();
            this.validate(state);
            await this.file.write(serializeState(state));
          },
          lock.signal,
        );
      });
    } finally {
      await lock.release();
    }
  }
}
