import dispatchOwnershipSchema from './dispatch-ownership-schema.ts';
import { dispatchTaskSession } from './dispatch-task-scope.ts';
import { issueDeliveryStateSchema } from './tasks/delivery/issue-delivery-state.ts';
import { deliveryAnnouncementStateSchema } from './tasks/delivery/delivery-announcement-state.ts';
import { announcementRecoverySchema } from './tasks/delivery/delivery-announcement-recovery.ts';
import { isAbsolute, join, resolve, sep } from 'node:path';
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
import storedDataSchema from '../core/stored-data-schema.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import { providerDiagnosticSchema } from '../utils/provider-diagnostic.ts';
import { assessmentSelectionSchema } from './tasks/assessment/assessment-selection.ts';
import { assignmentObservationSchema, retirementSchema } from './assignment-retirement.ts';
import {
  adoptedPullRequestSchema,
  deliveryPullRequestSchema,
} from './tasks/delivery/delivery-state.ts';
import { issueKey } from './dispatch-pending.ts';
import {
  assertDispatchStorage,
  dispatchSoftBytes,
  dispatchStorageBytes,
  dispatchStorageLimits,
  dispatchStorageNotice,
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
> & {
  // Read-time reservations only; saves retain the original records, never this projection.
  isolatedRecords?: Array<{ id: string; issueKey: string; intakeId?: string; code: string }>;
};
/** one journal bridges native actions; a persisted creation intent is never issued twice. */
export default class DispatchStore<R extends SharedDispatchRecord> {
  readonly file: PrivateStateFile;
  readonly schema: ReturnType<typeof dispatchStateSchema<R>>;
  readonly path: string;
  readonly envelopeSchema: ReturnType<typeof dispatchStateSchema<R>>;
  readonly ownershipSchema: TObject;
  private readonly recordSchema: TObject;
  constructor(
    readonly root: string,
    readonly scope: string,
    readonly contract: {
      runtime: 'codex' | 'openclaw';
      recordSchema: TObject;
      validRecord(record: R): boolean;
    },
  ) {
    this.recordSchema = storedDataSchema(contract.recordSchema, ['request']);
    this.schema = storedDataSchema(dispatchStateSchema<R>(this.recordSchema), ['request']);
    this.envelopeSchema = storedDataSchema(dispatchStateSchema<R>(Type.Unknown()));
    this.ownershipSchema = dispatchOwnershipSchema(contract.recordSchema);

    this.path = join(root, contract.runtime + '-dispatch-' + scope + '.json');
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [root],
      currentUid: process.getuid?.(),
      label: this.contract.runtime + ' issue dispatch',
      maximumBytes: dispatchStorageLimits.file,
    });
  }
  private validateEnvelope(state: unknown): asserts state is DispatchState<R> {
    if (!Value.Check(this.envelopeSchema, state) || state.scope !== this.scope)
      throw new Error('dispatch-state-invalid');
  }
  private validateShared(state: unknown): asserts state is DispatchState<R> {
    if (
      !Value.Check(this.envelopeSchema, state) ||
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
            )),
      )
    )
      throw new Error('dispatch-state-invalid');
  }
  private validRecord(r: R): boolean {
    return (
      Value.Check(this.recordSchema, r) &&
      !(
        Boolean(r.intakeId) === Boolean(r.manualIssue) ||
        (r.manualIssue &&
          (r.manualIssue.id !== r.id ||
            r.manualIssue.scope !== this.scope ||
            r.manualIssue.initiation.session !== r.sourceThreadId ||
            issueKey(r.manualIssue) !== r.issueKey)) ||
        (!r.cleanupPending &&
          ((r.request && (!r.context || !r.routing)) ||
            (r.handoff && (!r.request || !r.threadId || !r.worktree)))) ||
        (!r.cleanupPending && !validNativeDispatchRecord(r, this.contract.runtime)) ||
        (r.reset && !r.threadId) ||
        (r.cleanupPending ? !validPendingRetirement(r) : !this.contract.validRecord(r))
      )
    );
  }
  private validate(state: unknown): asserts state is DispatchState<R> {
    if (!Value.Check(this.schema, state)) throw new Error('dispatch-state-invalid');
    this.validateShared(state);
    if (state.records.some((r) => !this.validRecord(r))) throw new Error('dispatch-state-invalid');
  }
  private project(raw: unknown): DispatchState<R> {
    try {
      this.validate(raw);
      return raw;
    } catch (error) {
      const session = dispatchTaskSession(this.contract.runtime);
      if (!Value.Check(this.envelopeSchema, raw) || raw.scope !== this.scope)
        throw new Error('dispatch-state-invalid', { cause: error });
      const records = raw.records;
      if (
        records.some(
          (record) =>
            !record || typeof record !== 'object' || !Value.Check(this.ownershipSchema, record),
        )
      )
        throw new Error('dispatch-task-ownership-unresolved', { cause: error });
      const owners = session ? records.filter((record) => record.threadId === session) : [];
      if (!owners.length && (!session || records.some((r) => r.sourceThreadId === session))) {
        this.validateShared(raw);
        const isolatedRecords: NonNullable<DispatchState<R>['isolatedRecords']> = [];
        const damaged = records.filter((record) => !this.validRecord(record));
        const usable = records.filter((record) => {
          let code = 'dispatch-task-record-invalid';
          try {
            if (this.validRecord(record)) {
              this.assertIndependent(record, damaged);
              return true;
            }
          } catch {
            code = 'dispatch-task-ownership-unresolved';
          }
          isolatedRecords.push({
            id: record.id,
            issueKey: record.issueKey,
            intakeId: record.intakeId,
            code,
          });
          return false;
        });
        return { ...raw, records: usable, isolatedRecords };
      }
      if (owners.length !== 1)
        throw new Error('dispatch-task-ownership-unresolved', { cause: error });
      const owner = owners[0]!;
      if (!this.validRecord(owner))
        throw new Error('dispatch-task-record-invalid', { cause: error });
      this.assertIndependent(owner, records);
      return { ...raw, records: [owner] };
    }
  }
  private assertIndependent(owner: R, records: R[]) {
    const native = (r: R) => {
      const value = r as R & {
        clientThreadId?: string;
        receiptThreadId?: string;
        request?: { key?: string };
        sessionCreation?: { sessionId?: string };
      };
      return [
        r.threadId,
        value.clientThreadId,
        value.receiptThreadId,
        value.request?.key,
        r.delivery?.binding.threadId,
        value.sessionCreation?.sessionId,
      ].filter(Boolean);
    };
    const paths = (r: R) => {
      const value = r as R & {
        project?: { path: string };
        request?: { cwd?: string };
        repositoryPreparation?: { checkout?: string };
      };
      const paths = [
        r.worktree,
        value.request?.cwd,
        value.repositoryPreparation?.checkout,
        r.delivery?.binding.worktree,
      ].filter((value): value is string => Boolean(value));
      if (paths.some((path) => !isAbsolute(path)))
        throw new Error('dispatch-task-ownership-unresolved');
      return paths.map((path) => resolve(path));
    };
    const branch = (r: R) => {
      const value = r as R & {
        project?: { commonDir: string };
        issueBranch?: { name: string };
        adoptedLocalBranch?: string;
      };
      return {
        common: value.project?.commonDir,
        names: [
          value.issueBranch?.name,
          value.adoptedLocalBranch,
          r.delivery?.localBranch,
          r.delivery?.binding?.branch,
          r.adoptedPullRequest?.branch,
          r.manualIssue?.pullRequest?.headRef,
        ].filter(Boolean),
      };
    };
    const identities = (r: R) => {
      const value = r as R & { worktreeAttemptId?: string; issueBranch?: { attemptId: string } };
      return [r.id, value.worktreeAttemptId, value.issueBranch?.attemptId].filter(Boolean);
    };
    const issues = (r: R) => [r.issueKey, r.manualIssue && issueKey(r.manualIssue)].filter(Boolean);
    const pullRequests = (r: R) =>
      [
        r.pullRequestLink?.pullRequestNodeId,
        r.adoptedPullRequest?.pullRequestNodeId,
        r.delivery?.pullRequest?.pullRequestNodeId,
        r.delivery?.adopted?.pullRequestNodeId,
        r.manualIssue?.pullRequest && r.manualIssue.issue.nodeId,
      ].filter(Boolean);
    for (const other of records) {
      if (other === owner) continue;
      const left = branch(owner),
        right = branch(other);
      if (
        ((other.request || 'sessionCreation' in other) && !other.threadId) ||
        identities(owner).some((value) => identities(other).includes(value)) ||
        issues(owner).some((value) => issues(other).includes(value)) ||
        (other.intakeId && other.intakeId === owner.intakeId) ||
        [other.predecessorId, other.supersededBy].includes(owner.id) ||
        [owner.predecessorId, owner.supersededBy].includes(other.id) ||
        pullRequests(owner).some((value) => pullRequests(other).includes(value)) ||
        native(owner).some((value) => native(other).includes(value)) ||
        paths(owner).some((left) =>
          paths(other).some(
            (right) =>
              left === right || left.startsWith(right + sep) || right.startsWith(left + sep),
          ),
        ) ||
        (left.names.some((value) => right.names.includes(value)) &&
          (!left.common || !right.common || left.common === right.common))
      )
        throw new Error('dispatch-task-ownership-unresolved');
    }
  }
  private restore(
    proposed: DispatchState<R>,
    snapshot: { raw: DispatchState<R>; state: DispatchState<R> },
  ) {
    if (snapshot.raw === snapshot.state) {
      this.validate(proposed);
      return proposed;
    }
    if (snapshot.state.isolatedRecords) {
      if (!isDeepStrictEqual(proposed.isolatedRecords, snapshot.state.isolatedRecords))
        throw new Error('dispatch-task-isolation-required');
      const held = snapshot.raw.records.filter((r) =>
        snapshot.state.isolatedRecords!.some((entry) => entry.id === r.id),
      );
      for (const record of proposed.records) {
        if (!this.validRecord(record)) throw new Error('dispatch-task-record-invalid');
        this.assertIndependent(record, held);
      }
      const restored = {
        ...proposed,
        records: [
          ...snapshot.raw.records.flatMap((r) =>
            held.includes(r) ? [r] : proposed.records.filter((entry) => entry.id === r.id),
          ),
          ...proposed.records.filter(
            (r) => !snapshot.raw.records.some((entry) => entry.id === r.id),
          ),
        ],
      };
      delete restored.isolatedRecords;
      this.validateShared(restored);
      return restored;
    }
    const owner = snapshot.state.records[0]!;
    if (
      proposed.records.length !== 1 ||
      proposed.records[0]?.id !== owner.id ||
      !isDeepStrictEqual({ ...proposed, records: [] }, { ...snapshot.state, records: [] })
    )
      throw new Error('dispatch-task-isolation-required');
    const record = proposed.records[0]!;
    if (!this.validRecord(record)) throw new Error('dispatch-task-record-invalid');
    if (
      [
        'threadId',
        'issueKey',
        'intakeId',
        'manualIssue',
        'sourceThreadId',
        'reset',
        'retirement',
        'cleanupPending',
        'supersededBy',
        'predecessorId',
      ].some((key) => !isDeepStrictEqual(record[key as keyof R], owner[key as keyof R]))
    )
      throw new Error('dispatch-task-isolation-required');
    if (!owner.request && record.request) throw new Error('dispatch-task-isolation-required');
    const restored = {
      ...proposed,
      records: snapshot.raw.records.map((r) => (r.id === owner.id ? record : r)),
    };
    this.validateEnvelope(restored);
    this.assertIndependent(record, restored.records);
    return restored;
  }
  private async readEnvelope() {
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
    this.validateEnvelope(state);
    return state;
  }
  private async snapshot() {
    const raw = await this.readEnvelope();
    return { raw, state: this.project(raw) };
  }
  async inspectIntake() {
    const state = await this.readEnvelope();
    return {
      projectPickup: state.projectPickup,
      storage: dispatchStorageNotice(state),
    };
  }
  async observeIntake<T>(
    run: (
      state: Pick<DispatchState<R>, 'run' | 'checked'>,
      save: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.exclusive(
      async (state, save) => {
        const observation = { run: state.run, checked: state.checked };
        return run(observation, async () => {
          state.run = observation.run;
          state.checked = observation.checked;
          await save();
        });
      },
      true,
      'intake-observation',
    );
  }
  async read(): Promise<DispatchState<R>> {
    return (await this.snapshot()).state;
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
      | 'intake-observation'
      | 'delivery-checkpoint'
      | 'continuation-checkpoint' = 'dispatch-commit',
    signal?: AbortSignal,
  ): Promise<T> {
    const intake = operation === 'intake-observation';
    const snapshotForOperation = async () => {
      if (!intake) return this.snapshot();
      const raw = await this.readEnvelope();
      return { raw, state: raw };
    };
    const restore = (
      proposed: DispatchState<R>,
      snapshot: { raw: DispatchState<R>; state: DispatchState<R> },
    ) => {
      if (!intake) return this.restore(proposed, snapshot);
      this.validateEnvelope(proposed);
      if (
        !isDeepStrictEqual(
          { ...proposed, run: undefined, checked: undefined },
          { ...snapshot.raw, run: undefined, checked: undefined },
        )
      )
        throw new Error('dispatch-intake-isolation-required');
      return proposed;
    };
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
          operation: intake ? 'occurrence-registration' : operation,
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
        let snapshot = await snapshotForOperation();
        const state = structuredClone(snapshot.state);
        let committed = structuredClone(state);
        const save = async () => {
          guard.assertHeld();
          await assertNotificationManagement(this.root, this.scope);
          const freshSnapshot = await snapshotForOperation();
          const current = freshSnapshot.state;
          if (current.resetGeneration !== committed.resetGeneration)
            throw new Error('notification-reset-stale-operation');
          if (
            !isDeepStrictEqual(current, committed) ||
            !isDeepStrictEqual(freshSnapshot.raw, snapshot.raw)
          )
            throw new Error(stateSnapshotConflictCode);
          const retained = structuredClone(state);
          const originalBytes = dispatchStorageBytes(restore(retained, snapshot)).contentBytes;
          const pressure = originalBytes > dispatchSoftBytes;
          if (!intake && this.contract.runtime === 'openclaw' && snapshot.raw === snapshot.state) {
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
          const admission =
            !intake &&
            retained.records.some((record) => {
              if (record.retirement || record.reset) return false;
              const previous = committed.records.find((entry) => entry.id === record.id);
              return !previous || (!previous.request && Boolean(record.request));
            });
          const reclaimed =
            originalBytes - dispatchStorageBytes(restore(retained, snapshot)).contentBytes;
          if (!intake && reclaimed > 0) retained.storageReclaimedBytes = reclaimed;
          const contents = assertDispatchStorage(restore(retained, snapshot), admission);
          await this.file.write(contents);
          refreshStateSnapshot(state, retained);
          const raw = JSON.parse(contents) as DispatchState<R>;
          snapshot = { raw, state: intake ? raw : this.project(raw) };
          committed = structuredClone(snapshot.state);
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
