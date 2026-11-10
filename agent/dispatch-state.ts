import { issueDeliveryStateSchema } from './issue-delivery-state.ts';
import { deliveryAnnouncementStateSchema } from './delivery-announcement-state.ts';
import { announcementRecoverySchema } from './delivery-announcement-recovery.ts';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Type, type Static, type TObject, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import mergeStateSnapshot, {
  refreshStateSnapshot,
  stateSnapshotConflictCode,
} from '../core/merge-state-snapshot.ts';
import acquirePrivateStateFileLock, {
  type PrivateStateFileLockHandle,
} from '../core/private-state-file-lock.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import { providerDiagnosticSchema } from '../utils/provider-diagnostic.ts';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { assignmentObservationSchema, retirementSchema } from './assignment-retirement.ts';
import { adoptedPullRequestSchema, deliveryPullRequestSchema } from './delivery-state.ts';
import { issueKey } from './dispatch-pending.ts';
import {
  assertDispatchStorage,
  dispatchSoftBytes,
  dispatchStorageBytes,
  dispatchStorageLimits,
} from './dispatch-storage.ts';
import intakePassStarted from './intake-pass-started.ts';
import { projectWorkSchema } from './issue-pickup-authority.ts';
import resetIssuePickup from './issue-pickup-reset.ts';
import { issuePickupStateSchema } from './issue-pickup-state.ts';
import { implementationDecisionSchema, issueProgressionSchema } from './issue-progression.ts';
import { operatorIssueSchema } from './managed-issue.ts';
import { validNativeDispatchRecord } from './native-dispatch-record.ts';
import { assertNotificationManagement } from './notification-reset-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { openclawIntakePassSchema, sameIntakeRun } from './openclaw-intake-pass.ts';
import { validPendingRetirement } from './pending-retirement.ts';
import { retirementEffectSchema, type RetirementEffect } from './retirement-effects.ts';
import { routingInstructionsSchema } from './routing-instructions.ts';
const text = Type.String({ minLength: 1, maxLength: 4096 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const dispatchRecordProperties = {
  delivery: Type.Optional(issueDeliveryStateSchema),
  announcement: Type.Optional(deliveryAnnouncementStateSchema),
  announcementRecovery: Type.Optional(announcementRecoverySchema),
  blocker: Type.Optional(text),
  cleanupPending: Type.Optional(Type.Literal(true)),
  projectWork: Type.Optional(projectWorkSchema),
  providerDiagnostic: Type.Optional(providerDiagnosticSchema),
  id: hash,
  intakeId: Type.Optional(hash),
  manualIssue: Type.Optional(operatorIssueSchema),
  adoptedPullRequest: Type.Optional(adoptedPullRequestSchema),
  pullRequestLink: Type.Optional(Type.Union([deliveryPullRequestSchema, Type.Null()])),
  implementationDecision: Type.Optional(implementationDecisionSchema),
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
  reset: Type.Optional(
    Type.Object({ at: Type.Integer({ minimum: 0 }), by: text }, { additionalProperties: false }),
  ),
  lifecycleCheckedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  lifecyclePending: Type.Optional(Type.Literal(true)),
  assignmentObservation: Type.Optional(assignmentObservationSchema),
  retirement: Type.Optional(retirementSchema),
  feedbackReactivation: Type.Optional(
    Type.Object(
      {
        eventId: hash,
        assignmentEventId: text,
      },
      { additionalProperties: false },
    ),
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
      version: Type.Literal(4),
      scope: hash,
      resetGeneration: Type.Optional(text),
      records: Type.Array(Type.Unsafe<R>(recordSchema)),
      retirementEffects: Type.Optional(Type.Array(retirementEffectSchema)),
      projectPickup: Type.Optional(issuePickupStateSchema),
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
      discoveryCycleAt: Type.Optional(Type.Integer({ minimum: 0 })),
      discoveryCheckedAt: Type.Optional(Type.Integer({ minimum: 0 })),
      discoveryTimings: Type.Optional(
        Type.Object(
          {
            assignmentMs: Type.Integer({ minimum: 0 }),
            lifecycleMs: Type.Integer({ minimum: 0 }),
            feedbackMs: Type.Integer({ minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      ),
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
          .filter((r) => !r.reset && !r.retirement && !r.supersededBy && !r.manualIssue?.fresh)
          .map((r) => r.issueKey),
      ).size !==
        state.records.filter(
          (r) => !r.reset && !r.retirement && !r.supersededBy && !r.manualIssue?.fresh,
        ).length ||
      state.records.some(
        (r) =>
          (r.supersededBy &&
            state.records.some(
              (successor) =>
                successor.id === r.supersededBy &&
                (successor.predecessorId !== r.id || successor.issueKey !== r.issueKey),
            )) ||
          (r.predecessorId &&
            state.records.some(
              (predecessor) =>
                predecessor.id === r.predecessorId &&
                (predecessor.supersededBy !== r.id || predecessor.issueKey !== r.issueKey),
            )) ||
          Boolean(r.intakeId) === Boolean(r.manualIssue) ||
          (r.manualIssue &&
            (r.manualIssue.id !== r.id ||
              r.manualIssue.scope !== this.scope ||
              r.manualIssue.initiation.session !== r.sourceThreadId ||
              issueKey(r.manualIssue) !== r.issueKey)) ||
          (!r.cleanupPending &&
            ((r.request && (!r.context || !r.routing || !r.routingNote)) ||
              (r.handoff && (!r.request || !r.threadId || !r.worktree)))),
      ) ||
      state.records.some((r) => !r.cleanupPending && !validNativeDispatchRecord(r)) ||
      state.records.some((r) => r.reset && !r.threadId) ||
      state.records.some((r) =>
        r.cleanupPending ? !validPendingRetirement(r) : !this.contract.validRecord(r),
      )
    )
      throw new Error('dispatch-state-invalid');
  }
  async read(): Promise<DispatchState<R>> {
    const contents = await this.file.read();
    let state: unknown = { version: 4, scope: this.scope, resetGeneration: 'initial', records: [] };
    if (contents !== undefined) {
      try {
        state = JSON.parse(contents);
      } catch {
        throw new Error('dispatch-state-invalid');
      }
    }
    if (state && typeof state === 'object' && 'version' in state && state.version !== 4)
      throw new Error(
        'dispatch-clean-start-required: stop writers and perform the reviewed clean start before using this runtime',
      );
    this.validate(state);
    return state;
  }
  retainRetirementEffects(state: DispatchState<R>, effects: RetirementEffect[]) {
    if (!effects.length) return;
    const retained = (state.retirementEffects ??= []);
    for (const effect of effects)
      if (!retained.some((entry) => entry.id === effect.id)) retained.push(effect);
  }
  /** caller has verified native cleanup and independent assignment consumption. */
  async dispose(state: DispatchState<R>, record: R) {
    const index = state.records.findIndex((entry) => entry.id === record.id);
    if (index < 0) throw new Error('retirement-task-missing');
    state.records.splice(index, 1);
    // References on other attempts preserve their historical fence and checkout identity.
    // They may point to a disposed task; removing them could reactivate a predecessor.
    for (const pass of state.openclawPasses ?? []) {
      pass.selected = pass.selected.filter((id) => id !== record.id);
      pass.recovery = pass.recovery.filter((id) => id !== record.id);
      if (pass.started) pass.started = pass.started.filter((id) => id !== record.id);
    }
  }
  /** external work runs unlocked; each save commits only checked changes to fresh state. */
  async transaction<T>(
    run: (state: DispatchState<R>, save: () => Promise<void>, signal: AbortSignal) => Promise<T>,
    options: {
      signal?: AbortSignal;
      operation?: 'delivery-checkpoint' | 'continuation-checkpoint';
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
    await this.reconcile(signal);
    const state = await this.read();
    let before = structuredClone(state);
    return run(
      state,
      async () => {
        signal.throwIfAborted();
        await this.exclusive(
          async (current, save) => {
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
            // checkpoints compare durable json, not optional properties omitted by serialization.
            const committed = JSON.parse(JSON.stringify(current)) as DispatchState<R>;
            refreshStateSnapshot(state, committed);
            before = structuredClone(committed);
          },
          true,
          options.operation,
          signal,
        );
      },
      signal,
    );
  }
  /** Check the current journal under its lock before accepting new effects. */
  async reconcile(signal?: AbortSignal) {
    await this.exclusive(async () => {}, true, 'dispatch-reconcile', signal);
  }
  async exclusive<T>(
    run: (state: DispatchState<R>, save: () => Promise<void>, signal: AbortSignal) => Promise<T>,
    waitForLock = true,
    operation:
      | 'dispatch-commit'
      | 'dispatch-reconcile'
      | 'occurrence-registration'
      | 'delivery-checkpoint'
      | 'continuation-checkpoint' = 'dispatch-commit',
    signal?: AbortSignal,
  ): Promise<T> {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: this.contract.runtime + ' issue dispatch',
    });
    const acquire = (wait: boolean) =>
      acquirePrivateStateFileLock(this.path, {
        staleMs: 30000,
        contention: {
          category: 'dispatch',
          operation,
          // preserve the existing forty 250-ms retry envelope, including local queue time.
          timeoutMs: wait ? 10000 : 0,
          retryMs: 250,
          signal,
        },
        retries: { retries: 0, factor: 1, minTimeout: 250, maxTimeout: 250 },
      });
    const lock: PrivateStateFileLockHandle = await acquire(waitForLock);
    const controller = new AbortController();
    const followLease = () => {
      const signal = lock!.signal;
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    };
    followLease();
    const guard = {
      path: lock.path,
      signal: controller.signal,
      assertHeld() {
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
          const retained = structuredClone(state);
          this.validate(retained);
          const originalBytes = dispatchStorageBytes(retained).contentBytes;
          const pressure = originalBytes > dispatchSoftBytes;
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
          this.validate(retained);
          const admission = retained.records.some((record) => {
            if (record.retirement || record.reset) return false;
            const previous = committed.records.find((entry) => entry.id === record.id);
            return !previous || (!previous.request && Boolean(record.request));
          });
          assertDispatchStorage(retained, admission);
          this.validate(retained);
          const reclaimed = originalBytes - dispatchStorageBytes(retained).contentBytes;
          if (reclaimed > 0) retained.storageReclaimedBytes = reclaimed;
          const contents = assertDispatchStorage(retained, admission);
          await this.file.write(contents);
          refreshStateSnapshot(state, retained);
          committed = JSON.parse(contents) as DispatchState<R>;
        };
        return run(state, save, guard.signal);
      });
    } finally {
      await lock?.release();
    }
  }
  async reset(generation: string): Promise<void> {
    await this.exclusive(async (state, save) => {
      if (state.resetGeneration === generation) return;
      const pickup = resetIssuePickup(state.projectPickup, state.records);
      const version = state.version;
      for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key];
      Object.assign(state, {
        version,
        scope: this.scope,
        resetGeneration: generation,
        records: [],
        ...(pickup ? { projectPickup: pickup } : {}),
      });
      await save();
    }, true);
  }
}
