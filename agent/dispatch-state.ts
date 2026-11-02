import { pickupReportSchema, projectPickupStateSchema } from './project-pickup-state.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { projectWorkSchema } from './project-pickup-authority.ts';
import { issueKey } from './dispatch-pending.ts';
import { adoptedPullRequestSchema } from './delivery-state.ts';
import ColdHistory from './cold-history.ts';
import intakePassStarted from './intake-pass-started.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { historyLifetimeMs, historySoftBytes, retainedHistorySchema } from './history-state.ts';
import {
  assertDispatchStorage,
  dispatchStorageBytes,
  dispatchStorageLimits,
} from './dispatch-storage.ts';
import retainDispatchHistory, {
  validTerminalRecord,
  verifiedTerminalCleanup,
} from './retain-dispatch-history.ts';
import { routingInstructionsSchema } from './routing-instructions.ts';
import { operatorIssueSchema } from './managed-issue.ts';
import { assessmentEntriesSchema } from './assessment-entry-state.ts';
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
import { openclawIntakePassSchema, sameIntakeRun } from './openclaw-intake-pass.ts';
import { workflowBindingSchema } from './workflow-result.ts';
import { issueProgressionSchema } from './issue-progression.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock, {
  type PrivateStateFileLockHandle,
} from '../core/private-state-file-lock.ts';
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
  projectWork: Type.Optional(projectWorkSchema),
  retainedHistory: Type.Optional(retainedHistorySchema),
  directAssessments: Type.Optional(assessmentEntriesSchema),
  providerDiagnostic: Type.Optional(providerDiagnosticSchema),
  id: hash,
  intakeId: Type.Optional(hash),
  manualIssue: Type.Optional(operatorIssueSchema),
  adoptedPullRequest: Type.Optional(adoptedPullRequestSchema),
  supersededBy: Type.Optional(hash),
  predecessorId: Type.Optional(hash),
  recovery: Type.Optional(
    Type.Object(
      { digest: hash, by: text, turnId: text, inputId: text, at: Type.Integer({ minimum: 0 }) },
      { additionalProperties: false },
    ),
  ),
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
  routingInstructions: Type.Optional(routingInstructionsSchema),
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
      { at: Type.Integer({ minimum: 0 }), by: text, turnId: text, inputId: Type.Optional(text) },
      { additionalProperties: false },
    ),
  ),
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
      storageReclaimedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
      version: Type.Literal(1),
      scope: hash,
      resetGeneration: Type.Optional(text),
      records: Type.Array(Type.Unsafe<R>(recordSchema)),
      projectPickup: Type.Optional(projectPickupStateSchema),
      projectPickupReport: Type.Optional(pickupReportSchema),
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
    },
    { additionalProperties: false },
  );
}
export type DispatchState<R extends SharedDispatchRecord> = Static<
  ReturnType<typeof dispatchStateSchema<R>>
>;

/** one journal bridges native actions; a persisted creation intent is never issued twice. */
export default class DispatchStore<R extends SharedDispatchRecord> {
  readonly file: PrivateStateFile;
  readonly schema: ReturnType<typeof dispatchStateSchema<R>>;
  readonly path: string;
  readonly history: ColdHistory;
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
    this.history = new ColdHistory(root, contract.runtime + '-' + scope);
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [root],
      currentUid: process.getuid?.(),
      label: this.contract.runtime + ' issue dispatch',
      maximumBytes: dispatchStorageLimits.file,
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
              pass.started?.some(
                (id) => !pass.selected.includes(id) || pass.recovery.includes(id),
              ) ||
              (pass.completed &&
                (pass.candidates.length > 0 ||
                  pass.recovery.length > 0 ||
                  pass.selected.length > 0 ||
                  (pass.started?.length ?? 0) > 0)) ||
              (pass.allowance === 0 && pass.selected.some((id) => !pass.recovery.includes(id))) ||
              pass.selected.filter((id) => !pass.recovery.includes(id)).length >
                pass.candidates.length ||
              pass.recovery.some((id) => !state.records.some((record) => record.id === id)) ||
              pass.selected.some((id) => !state.records.some((record) => record.id === id)),
          ))) ||
      new Set(state.records.map((r) => r.id)).size !== state.records.length ||
      new Set(
        state.records
          .filter(
            (r) =>
              !r.reset && !r.retired && !r.retirement && !r.supersededBy && !r.manualIssue?.fresh,
          )
          .map((r) => r.issueKey),
      ).size !==
        state.records.filter(
          (r) =>
            !r.reset && !r.retired && !r.retirement && !r.supersededBy && !r.manualIssue?.fresh,
        ).length ||
      state.records.some(
        (r) =>
          (r.supersededBy &&
            !state.records.some(
              (successor) =>
                successor.id === r.supersededBy &&
                successor.predecessorId === r.id &&
                successor.issueKey === r.issueKey,
            )) ||
          (r.predecessorId &&
            !state.records.some(
              (predecessor) =>
                predecessor.id === r.predecessorId &&
                predecessor.supersededBy === r.id &&
                predecessor.issueKey === r.issueKey,
            )) ||
          Boolean(r.intakeId) === Boolean(r.manualIssue) ||
          (r.manualIssue &&
            (r.manualIssue.id !== r.id ||
              r.manualIssue.scope !== this.scope ||
              r.manualIssue.initiation.session !== r.sourceThreadId ||
              issueKey(r.manualIssue) !== r.issueKey)) ||
          (!r.retainedHistory?.terminal &&
            ((r.request && (!r.context || !r.routing || !r.routingNote)) ||
              (['creating', 'assessing', 'complete'].includes(r.phase) && !r.request) ||
              (r.phase === 'created' &&
                (this.contract.runtime !== 'openclaw' ||
                  !r.request ||
                  !r.threadId ||
                  !r.effective)) ||
              (r.phase === 'complete' && !r.result) ||
              (r.handoff && (!r.request || !r.threadId || !r.worktree)))),
      ) ||
      state.records.some((r) => r.reset && (r.phase !== 'complete' || !r.threadId)) ||
      state.records.some((r) =>
        r.retainedHistory?.terminal ? !validTerminalRecord(r) : !this.contract.validRecord(r),
      )
    )
      throw new Error('dispatch-state-invalid');
  }
  async read(): Promise<DispatchState<R>> {
    const contents = await this.file.read();
    let state: unknown = { version: 1, scope: this.scope, resetGeneration: 'initial', records: [] };
    if (contents !== undefined) {
      try {
        state = JSON.parse(contents);
      } catch {
        throw new Error('dispatch-state-invalid');
      }
    }
    if (
      state &&
      typeof state === 'object' &&
      'scope' in state &&
      state.scope === this.scope &&
      'records' in state &&
      Array.isArray(state.records) &&
      state.records.length > 0 &&
      !('resetGeneration' in state)
    )
      throw new Error('notification-state-reset-required');
    this.validate(state);
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
    await this.reconcile();
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
                'supersededBy',
                'feedbackReactivation',
                'intakeId',
                'manualIssue',
                'handoff',
                'manifestDigest',
                'request',
                'assessment',
                'threadId',
                'worktree',
                'effective',
                'retainedHistory',
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
          refreshStateSnapshot(state, current);
          before = structuredClone(current);
        }, true);
      },
      signal,
    );
  }

  /** Existing runtime transactions recover eligible history before accepting new effects. */
  async reconcile() {
    await this.exclusive(async () => {}, true);
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
    // capture only enclosing guards; archive io must not inherit this journal's released lease.
    const outsideJournal = AsyncLocalStorage.snapshot();
    const acquire = (wait: boolean) =>
      acquirePrivateStateFileLock(this.path, {
        staleMs: 30000,
        retries: wait
          ? { retries: 40, factor: 1, minTimeout: 250, maxTimeout: 250 }
          : { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
      });
    let lock: PrivateStateFileLockHandle | undefined = await acquire(waitForLock);
    const controller = new AbortController();
    let reacquireFailure: unknown;
    const followLease = () => {
      const signal = lock!.signal;
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    };
    followLease();
    const guard = {
      signal: controller.signal,
      assertHeld() {
        if (!lock) throw reacquireFailure ?? new Error('dispatch-journal-lease-suspended');
        lock.assertHeld();
      },
    };
    try {
      return await withPrivateStateLock(guard, async () => {
        await assertNotificationManagement(this.root, this.scope);
        const state = await this.read();
        let committed = structuredClone(state);
        const save = async () => {
          guard.assertHeld();
          await assertNotificationManagement(this.root, this.scope);
          const current = await this.read();
          if (current.resetGeneration !== committed.resetGeneration)
            throw new Error('notification-reset-stale-operation');
          if (!isDeepStrictEqual(current, committed)) throw new Error(stateSnapshotConflictCode);
          this.validate(state);
          const retained = structuredClone(state);
          const originalBytes = dispatchStorageBytes(retained).contentBytes;
          const pressure = originalBytes > historySoftBytes;
          const now = Date.now();
          let expiredHistory = false;
          for (const record of retained.records) {
            const history = record.retainedHistory;
            if (!history) continue;
            const entries = history.entries.filter((entry) => entry.at + historyLifetimeMs > now);
            if (entries.length !== history.entries.length) {
              history.expired = true;
              expiredHistory = true;
            }
            history.entries = entries;
          }
          const snapshots: { original: R; projected: R }[] = [];
          if (this.contract.runtime === 'openclaw') {
            for (const pass of retained.openclawPasses ?? []) {
              if (pass.completed) continue;
              const started = intakePassStarted(
                pass,
                retained.records as unknown as OpenClawDispatchRecord[],
              );
              if (started.length || pass.started) pass.started = started;
              if (
                pressure &&
                retained.openclawOccurrence &&
                !sameIntakeRun(pass, retained.openclawOccurrence) &&
                started.length >= pass.allowance &&
                pass.recovery.every((id) => pass.selected.includes(id))
              ) {
                pass.completed = true;
                pass.candidates = [];
                pass.recovery = [];
                pass.selected = [];
                pass.started = [];
              }
            }
          }
          for (let index = 0; index < retained.records.length; index++) {
            const original = retained.records[index]!;
            const events = (original as R & { feedback?: { events: unknown[] } }).feedback?.events;
            if (!verifiedTerminalCleanup(original) && !pressure && (events?.length ?? 0) < 350)
              continue;
            const projected = retainDispatchHistory(original);
            if (!projected) continue;
            // preflight the projected size before performing any archive effects.
            projected.retainedHistory ??= { entries: [] };
            snapshots.push({ original, projected });
            retained.records[index] = projected;
          }
          this.validate(retained);
          const admission = retained.records.some((record) => {
            if (record.retired || record.retirement || record.reset) return false;
            const previous = committed.records.find((entry) => entry.id === record.id);
            return !previous || (!previous.request && Boolean(record.request));
          });
          assertDispatchStorage(retained, admission);
          if (snapshots.length || expiredHistory) {
            await lock!.release();
            lock = undefined;
            let archiveError: unknown;
            let archiveFailed = false;
            try {
              await outsideJournal(() =>
                this.history.exclusive(async () => {
                  for (const { original, projected } of snapshots) {
                    const reference = await this.history.retain(
                      original,
                      original.retired?.at ?? now,
                      now,
                    );
                    projected.retainedHistory!.entries.push(reference);
                  }
                  await this.history.prune(now);
                }),
              );
            } catch (error) {
              archiveError = error;
              archiveFailed = true;
            }
            try {
              lock = await acquire(true);
              followLease();
            } catch (error) {
              reacquireFailure = error;
              throw error;
            }
            await assertNotificationManagement(this.root, this.scope);
            const fresh = await this.read();
            if (fresh.resetGeneration !== committed.resetGeneration)
              throw new Error('notification-reset-stale-operation');
            if (!isDeepStrictEqual(fresh, committed)) throw new Error(stateSnapshotConflictCode);
            if (archiveFailed) throw archiveError;
          }
          this.validate(retained);
          const reclaimed = originalBytes - dispatchStorageBytes(retained).contentBytes;
          if (reclaimed > 0) retained.storageReclaimedBytes = reclaimed;
          const contents = assertDispatchStorage(retained, admission);
          await this.file.write(contents);
          refreshStateSnapshot(state, retained);
          committed = JSON.parse(contents) as DispatchState<R>;
        };
        const pressured = dispatchStorageBytes(state).contentBytes > historySoftBytes;
        if (
          state.records.some(
            (record) =>
              !record.retainedHistory?.terminal &&
              (verifiedTerminalCleanup(record) || pressured) &&
              retainDispatchHistory(record),
          )
        )
          await save();
        return run(state, save, guard.signal);
      });
    } finally {
      await lock?.release();
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
