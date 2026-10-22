import { providerDiagnosticSchema } from '../utils/provider-diagnostic.ts';
import { assertNotificationManagement } from './notification-reset-state.ts';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import mergeStateSnapshot, {
  refreshStateSnapshot,
  stateSnapshotConflictCode,
} from '../core/merge-state-snapshot.ts';

import { Type, type Static, type TObject, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import { assignmentObservationSchema, retirementSchema } from './assignment-retirement.ts';

import { assessmentResultSchema } from './assessment-result.ts';
import { assessmentSummarySchema } from './assessment-summary-state.ts';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { codexNoticeSchema, codexNoticeLimit } from './codex-notice-outbox.ts';
import { openclawIntakePassSchema } from './openclaw-intake-pass.ts';
import { workflowBindingSchema } from './workflow-result.ts';
import recoverTaskBlockers from './recover-task-blockers.ts';
import { issueProgressionSchema, retainedIssueProgression } from './issue-progression.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const assessmentStageReceiptSchema = Type.Object(
  {
    binding: workflowBindingSchema,
    resultDigest: hash,
    selection: Type.Optional(assessmentSelectionSchema),
  },
  { additionalProperties: false },
);
export const dispatchRecordProperties = {
  providerDiagnostic: Type.Optional(providerDiagnosticSchema),
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
    Type.Literal('waiting'),
    Type.Literal('retrying'),
  ]),
  createdAt: Type.Integer({ minimum: 0 }),
  progression: Type.Optional(issueProgressionSchema),
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
  compatibilityRecovery: Type.Optional(
    Type.Object(
      {
        version: Type.Literal(1),
        codes: Type.Array(text),
        previousResult: Type.Optional(assessmentResultSchema),
      },
      { additionalProperties: false },
    ),
  ),
  assessmentRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  assessmentSummaries: Type.Optional(Type.Array(assessmentSummarySchema)),
  stageReceipt: Type.Optional(assessmentStageReceiptSchema),
  resultTurnId: Type.Optional(text),
  reset: Type.Optional(
    Type.Object({ at: Type.Integer({ minimum: 0 }), by: text }, { additionalProperties: false }),
  ),
  lifecycleCheckedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  assignmentObservation: Type.Optional(assignmentObservationSchema),
  retirement: Type.Optional(retirementSchema),
  feedbackReactivation: Type.Optional(
    Type.Object(
      {
        eventId: hash,
        assignmentEventId: text,
        policyDigest: hash,
        at: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
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
  retry: Type.Optional(
    Type.Object(
      { code: text, attempts: Type.Integer({ minimum: 1, maximum: 5 }) },
      { additionalProperties: false },
    ),
  ),
  nativeInactive: Type.Optional(Type.Boolean()),
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
      resetGeneration: Type.Optional(text),
      records: Type.Array(Type.Unsafe<R>(recordSchema)),
      openclawOccurrence: Type.Optional(
        Type.Object(
          { sessionKey: text, sessionId: text, runId: text },
          { additionalProperties: false },
        ),
      ),
      openclawPasses: Type.Optional(Type.Array(openclawIntakePassSchema)),
      continuationRun: Type.Optional(
        Type.Object(
          {
            id: text,
            actions: Type.Integer({ minimum: 0, maximum: 12 }),
            responses: Type.Optional(Type.Array(text, { maxItems: 12 })),
          },
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
            reportVersion: Type.Optional(Type.Literal(1)),
          },
          { additionalProperties: false },
        ),
      ),
      intakeReport: Type.Optional(
        Type.Object(
          {
            fingerprint: hash,
            reportVersion: Type.Optional(Type.Literal(1)),
            problems: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 256 }),
            runId: text,
            response: Type.String({ maxLength: 128000 }),
          },
          { additionalProperties: false },
        ),
      ),
      discoveryCycleAt: Type.Optional(Type.Integer({ minimum: 0 })),
      discoveryCheckedAt: Type.Optional(Type.Integer({ minimum: 0 })),
      discoveryRun: Type.Optional(
        Type.Pick(openclawIntakePassSchema, ['sessionKey', 'sessionId', 'runId']),
      ),
      discoveryProgress: Type.Optional(
        Type.Object(
          {
            pending: Type.Boolean(),
            reported: Type.Optional(Type.Boolean()),
            sources: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      ),
      intakeHealth: Type.Optional(Type.String({ maxLength: 128 })),
      intakeHealthVersion: Type.Optional(Type.Literal(1)),
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
      (state.openclawPasses !== undefined &&
        (this.contract.runtime !== 'openclaw' ||
          new Set(
            state.openclawPasses.map((pass) =>
              JSON.stringify([pass.sessionKey, pass.sessionId, pass.runId]),
            ),
          ).size !== state.openclawPasses.length ||
          state.openclawPasses.some(
            (pass) =>
              pass.allowance > pass.limit ||
              pass.recovery.length > pass.limit ||
              pass.candidates.length > 12 ||
              (pass.allowance === 0 && pass.selected.some((id) => !pass.recovery.includes(id))) ||
              pass.selected.filter((id) => !pass.recovery.includes(id)).length >
                pass.candidates.length ||
              pass.recovery.some((id) => !state.records.some((record) => record.id === id)) ||
              pass.selected.some((id) => !state.records.some((record) => record.id === id)),
          ))) ||
      new Set(state.records.map((r) => r.id)).size !== state.records.length ||
      new Set(
        state.records.filter((r) => !r.reset && !r.retired && !r.retirement).map((r) => r.issueKey),
      ).size !== state.records.filter((r) => !r.reset && !r.retired && !r.retirement).length ||
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
    for (let index = 0; index < state.records.length; index++) {
      const candidate = structuredClone(state.records[index]!);
      recoverTaskBlockers(candidate);
      const progression = retainedIssueProgression(candidate);
      if (progression) candidate.progression = progression;
      // incomplete native custody remains for its owning reconciliation route.
      if (this.contract.validRecord(candidate)) state.records[index] = candidate;
    }
    this.validate(state);
    // discard obsolete presentation queues, preserving all assignment and assessment records.
    delete state.notices;
    delete state.reports;
    serializeState(state);
    return state;
  }
  /** external work runs unlocked; each save commits only checked changes to fresh state. */
  async transaction<T>(
    run: (state: DispatchState<R>, save: () => Promise<void>, signal: AbortSignal) => Promise<T>,
    options: {
      signal?: AbortSignal;
      reconcile?: (
        before: DispatchState<R>,
        proposed: DispatchState<R>,
        current: DispatchState<R>,
      ) => void;
      validate?: (before: DispatchState<R>, after: DispatchState<R>) => void;
    } = {},
  ): Promise<T> {
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    await assertNotificationManagement(this.root, this.scope);
    const state = await this.read();
    let before = structuredClone(state);
    return run(
      state,
      async () => {
        signal.throwIfAborted();
        await this.exclusive(async (current, save) => {
          signal.throwIfAborted();
          if (before.resetGeneration !== current.resetGeneration)
            throw new Error('notification-reset-stale-operation');
          for (const record of state.records) {
            const previous = before.records.find((entry) => entry.id === record.id);
            const fresh = current.records.find((entry) => entry.id === record.id);
            if (!previous || isDeepStrictEqual(previous, record)) continue;
            if (
              !fresh ||
              [
                'reset',
                'retired',
                'retirement',
                'feedbackReactivation',
                'intakeId',
                'handoff',
                'manifestDigest',
                'request',
                'assessment',
                'threadId',
                'worktree',
                'effective',
              ].some((key) => !isDeepStrictEqual(previous[key as keyof R], fresh[key as keyof R]))
            )
              throw Object.assign(new Error(stateSnapshotConflictCode), {
                code: stateSnapshotConflictCode,
              });
          }
          options.reconcile?.(before, state, current);
          const merged = mergeStateSnapshot(before, state, current) as DispatchState<R>;
          options.validate?.(current, merged);
          this.validate(merged);
          if (!isDeepStrictEqual(current, merged)) {
            refreshStateSnapshot(current, merged);
            await save();
          }
          refreshStateSnapshot(state, merged);
          before = structuredClone(merged);
        }, true);
      },
      signal,
    );
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
        await assertNotificationManagement(this.root, this.scope);
        const state = await this.read();
        return run(
          state,
          async () => {
            lock.assertHeld();
            await assertNotificationManagement(this.root, this.scope);
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

  async reset(generation: string): Promise<void> {
    await this.exclusive(async (state, save) => {
      for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key];
      Object.assign(state, {
        version: 1,
        scope: this.scope,
        resetGeneration: generation,
        records: [],
      });
      await save();
    }, true);
  }
}
