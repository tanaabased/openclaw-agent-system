import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import GitHubIdentityCache from '../identity-cache.ts';
import type { BoundStorage } from '../../../agent/storage/storage-lifecycle.ts';
import { resolve } from 'node:path';
import { projectWorkMatches, projectWorkSchema } from '../../../agent/issue-pickup-authority.ts';
import {
  assertNotificationManagement,
  ownsNotificationReset,
} from '../../../agent/notification-reset-state.ts';
import mergeStateSnapshot, {
  refreshStateSnapshot,
  stateSnapshotConflictCode,
} from '../../../core/merge-state-snapshot.ts';
import { providerDiagnosticSchema } from '../../../utils/provider-diagnostic.ts';
import { repositoryScopeDecisionSchema } from '../repository-scope.ts';
const intakeCleanupBytes = 2 * 1024 * 1024;
const maximumIntakeBytes = 4 * 1024 * 1024;

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { automationHash } from '../../../agent/automation-hash.ts';
import storedDataSchema from '../../../core/stored-data-schema.ts';

const text = Type.String({ minLength: 1, maxLength: 4096 });
const time = Type.Integer({ minimum: 0 });
const identity = Type.Object({ login: text, nodeId: text }, { additionalProperties: false });
const eventIdentity = Type.Object(
  { ...identity.properties, type: text },
  { additionalProperties: false },
);
export const intakeRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    id: text,
    scope: text,
    receiving: identity,
    workspaceDir: text,
    agentId: text,
    host: Type.Literal('github.com'),
    repository: Type.Object(
      { nodeId: text, databaseId: time, owner: identity, name: text },
      { additionalProperties: false },
    ),
    issue: Type.Object(
      { nodeId: text, databaseId: time, number: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    assignment: Type.Object(
      {
        nodeId: text,
        databaseId: time,
        createdAt: text,
        event: Type.Literal('assigned'),
        actor: eventIdentity,
        assignee: eventIdentity,
      },
      { additionalProperties: false },
    ),
    evidence: Type.Object(
      {
        policyDigest: text,
        mode: Type.Union([Type.Literal('plan'), Type.Literal('work'), Type.Literal('auto')]),
        open: Type.Literal(true),
        assigned: Type.Literal(true),
        repositoryReadable: Type.Literal(true),
        ownerPinned: Type.Boolean(),
        repositoryScope: Type.Optional(repositoryScopeDecisionSchema),
        actorPinned: Type.Literal(true),
        projectWork: Type.Optional(projectWorkSchema),
      },
      { additionalProperties: false },
    ),
    observedAt: time,
    admittedAt: time,
    status: Type.Literal('admitted'),
    requiresRevalidation: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type IntakeRecord = Static<typeof intakeRecordSchema>;
export const intakeObservationSchema = Type.Object(
  {
    ...Type.Omit(intakeRecordSchema, ['evidence', 'admittedAt', 'status', 'requiresRevalidation'])
      .properties,
    consumedThrough: Type.Optional(time),
    consumedBy: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  },
  { additionalProperties: false },
);
export type IntakeObservation = Static<typeof intakeObservationSchema>;

const stateSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: text,
    workspaceDir: text,
    agentId: text,
    account: identity,
    policyDigest: text,
    baselineAt: time,
    resetGeneration: Type.Optional(text),
    manualOnly: Type.Optional(Type.Literal(true)),
    checkpoint: Type.Optional(time),
    discovery: Type.Optional(
      Type.Object(
        {
          page: Type.Integer({ minimum: 1 }),
          pending: Type.Array(Type.String({ maxLength: 16000 })),
          observations: Type.Optional(
            Type.Record(Type.String(), Type.String({ maxLength: 512000 })),
          ),
          nextPage: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    deferred: Type.Optional(
      Type.Array(
        Type.Object(
          {
            key: text,
            candidate: Type.String({ maxLength: 16000 }),
            code: text,
            providerDiagnostic: Type.Optional(providerDiagnosticSchema),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    lastAttemptAt: Type.Optional(time),
    blocker: Type.Optional(
      Type.Object(
        {
          code: text,
          since: time,
          retryAfter: time,
          providerDiagnostic: Type.Optional(providerDiagnosticSchema),
        },
        { additionalProperties: false },
      ),
    ),
    observedAssignments: Type.Optional(Type.Array(intakeObservationSchema)),
    records: Type.Array(intakeRecordSchema),
  },
  { additionalProperties: false },
);
export type IntakeState = Static<typeof stateSchema>;
const storedStateSchema = storedDataSchema(stateSchema);
// an assignment extension must never select the operator-only origin branch.
Object.assign(storedStateSchema.properties.records.items.properties, { initiation: Type.Never() });

export class IntakeError extends Error {
  constructor(readonly code: string) {
    super(`${code}: ${intakeRemediation(code)}`);
  }
}

export function intakeRemediation(code: string): string {
  if (code === 'intake-state-capacity' || code === 'dispatch-state-capacity')
    return 'The working journal exceeds its byte budget. Normal saves offload only settled detail; unfinished work and replay identities cannot be evicted. Preserve the journal, resolve pending work or inspect irreducible identity growth; do not reset the assignment baseline to reclaim space.';
  if (code === 'intake-automation-paused')
    return 'Intake scheduling is paused. Resume the native job, or set `paused: false` and run Install. Accepted runs and existing issue work retain their authority.';
  if (code === 'intake-manifest-unavailable')
    return 'Restore a readable, valid `agent.yaml` in the bound workspace, then retry. No rebind or Install is required for a policy-only repair.';
  if (code === 'intake-automation-update-required')
    return 'Run Agent System Install to apply the update and resume intake. Existing chats and work are retained.';
  if (code === 'automation-recovery-required')
    return 'Check Doctor for recovery steps before retrying intake.';
  if (code === 'intake-activation-required') return 'Run Agent System Install to activate intake.';
  if (/^intake-github-(?:unknown|transport|rate-limit|authentication|permission)$/.test(code)) {
    if (code.endsWith('authentication'))
      return 'GitHub rejected authentication. Check the current GitHub credential and retry this scan; preserve the checkpoint.';
    if (code.endsWith('permission'))
      return 'GitHub denied access. Check the granted repository permissions; preserve the checkpoint.';
    if (code.endsWith('rate-limit'))
      return 'Wait for the reported provider cooldown; the next eligible scan retries without resetting the checkpoint.';
    if (code.endsWith('transport'))
      return 'Retry this scan when connectivity returns; preserve the checkpoint and any pending work.';
    return 'Inspect the bounded provider diagnostic; this failure was not classified. Preserve the checkpoint and do not change credentials without evidence of an authentication failure.';
  }
  if (code.includes('permission'))
    return 'Inspect the denial for the affected operation. Correct provider access if GitHub denied it; a native approval denial remains a stop.';
  if (code.includes('profile') || code.includes('model'))
    return 'Correct the indicated model or effort profile, then retry the affected operation; no substitute is selected.';
  if (code.includes('state'))
    return 'Preserve the private evidence. Inspect its size, ownership, or schema and restore a verified copy; do not reset the baseline.';
  if (code.includes('identity') || code.includes('account') || code.includes('auth'))
    return 'Check the GitHub account against the configured login and identity pins, then retry the affected operation.';
  if (code.includes('incomplete'))
    return 'Provider evidence exceeded the bounded scan. Review repository scope or assignment history; the checkpoint has not advanced.';
  if (code.includes('disabled') || code.includes('binding'))
    return 'Check the current workspace binding and live policy. Use Install only if the saved automation must be paused or changed.';
  if (code.includes('policy') || code.includes('activation') || code.includes('reserved'))
    return 'Review the current `issue-assignment` policy in `agent.yaml`, then retry the scan. Policy-only changes apply without Install.';
  return 'Inspect the diagnostic for the affected operation before retrying. Retained evidence and the last successful checkpoint remain available; no credential failure has been established.';
}

export function intakeScopeLocation(root: string, scope: string) {
  return {
    root: resolve(root),
    scope,
  };
}

export function intakeLocation(input: {
  runtime: 'codex' | 'openclaw';
  root: string;
  namespace: string;
  workspaceDir: string;
  agentId: string;
}) {
  const scope = automationHash({
    runtime: input.runtime,
    namespace: input.namespace,
    workspaceDir: input.workspaceDir,
    agentId: input.agentId,
  });
  return intakeScopeLocation(input.root, scope);
}

// Discovery can wait on GitHub while another connection consumes observations. A changed
// scan cursor or an admission based on a just-consumed observation needs a fresh scan.
function reconcileIntakeCheckpoint(
  expected: IntakeState | undefined,
  state: IntakeState,
  current: IntakeState | undefined,
): IntakeState {
  if (expected?.resetGeneration !== current?.resetGeneration)
    throw new Error('notification-reset-stale-operation');
  if (isDeepStrictEqual(expected, current)) return state;
  if (!expected || !current || state.resetGeneration !== expected.resetGeneration)
    throw new Error(stateSnapshotConflictCode);
  const { observedAssignments: before = [], ...beforeScan } = expected;
  const { observedAssignments: latest = [], ...currentScan } = current;
  if (!isDeepStrictEqual(beforeScan, currentScan)) throw new Error(stateSnapshotConflictCode);
  const admitted = new Set(beforeScan.records.map((r) => r.id));
  const consumed = new Set(latest.filter((r) => r.consumedBy).map((r) => r.id));
  if (state.records.some((r) => !admitted.has(r.id) && consumed.has(r.id)))
    throw new Error(stateSnapshotConflictCode);
  return {
    ...state,
    observedAssignments: mergeStateSnapshot(
      before,
      state.observedAssignments ?? [],
      latest,
    ) as IntakeObservation[],
  };
}

export default class IntakeRecordStore {
  readonly identities: GitHubIdentityCache;
  constructor(
    readonly location: ReturnType<typeof intakeLocation>,
    readonly agentStorage: BoundStorage['agent'],
  ) {
    this.identities = new GitHubIdentityCache(location, agentStorage);
  }
  async read(): Promise<IntakeState | undefined> {
    return this.validate(await this.agentStorage.readIntake(this.location.scope));
  }
  private validate(value: unknown): IntakeState | undefined {
    if (value === undefined) return;
    try {
      if (
        !Value.Check(storedStateSchema, value) ||
        value.scope !== this.location.scope ||
        new Set(value.records.map((r) => r.id)).size !== value.records.length ||
        (value.observedAssignments ?? []).some(
          (r) =>
            r.scope !== value.scope ||
            r.receiving.nodeId !== value.account.nodeId ||
            r.workspaceDir !== value.workspaceDir ||
            r.agentId !== value.agentId ||
            r.id !==
              automationHash([
                value.scope,
                r.repository.nodeId,
                r.issue.nodeId,
                r.assignment.nodeId,
              ]),
        ) ||
        value.records.some(
          (r) =>
            r.scope !== value.scope ||
            r.receiving.nodeId !== value.account.nodeId ||
            r.workspaceDir !== value.workspaceDir ||
            r.agentId !== value.agentId ||
            (r.evidence.projectWork !== undefined &&
              !projectWorkMatches(r.evidence.projectWork, r)) ||
            r.id !==
              automationHash([
                value.scope,
                r.repository.nodeId,
                r.issue.nodeId,
                r.assignment.nodeId,
              ]),
        )
      )
        throw new Error('invalid state');
      return value;
    } catch {
      throw new IntakeError('intake-state-invalid');
    }
  }
  private prepare(state: IntakeState) {
    if (!Value.Check(storedStateSchema, state) || state.scope !== this.location.scope)
      throw new IntakeError('intake-state-invalid');
    const retained = structuredClone(state);
    if (Buffer.byteLength(JSON.stringify(retained)) > intakeCleanupBytes) {
      const admitted = new Set(retained.records.map((record) => record.id));
      retained.observedAssignments = retained.observedAssignments?.filter(
        (record) => record.consumedBy || !admitted.has(record.id),
      );
      if (Buffer.byteLength(JSON.stringify(retained)) > maximumIntakeBytes)
        throw new IntakeError('intake-state-capacity');
    }
    return retained;
  }

  private get resetOwner() {
    return ownsNotificationReset(this.location.scope, this.agentStorage);
  }

  async exclusive<T>(
    operation: (
      state: IntakeState | undefined,
      save: (state: IntakeState) => Promise<void>,
      signal: AbortSignal,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const storage = this.agentStorage;
    const active = signal ?? new AbortController().signal;
    active.throwIfAborted();
    await assertNotificationManagement(this.location.scope, storage);
    let expected = await this.read();
    return operation(
      structuredClone(expected),
      async (state) => {
        const retained = await storage.changeIntake(
          this.location.scope,
          this.resetOwner,
          (saved) => {
            active.throwIfAborted();
            const current = this.validate(saved);
            const result = this.prepare(reconcileIntakeCheckpoint(expected, state, current));
            return { state: result, result };
          },
        );
        // Match the persisted representation, including omission of undefined JSON fields.
        expected = JSON.parse(JSON.stringify(retained)) as IntakeState;
        refreshStateSnapshot(state, retained);
      },
      active,
    );
  }
  async consume(
    observation: IntakeObservation,
    taskId: string,
    consumedThrough?: number,
  ): Promise<string> {
    if (
      observation.scope !== this.location.scope ||
      observation.id !==
        automationHash([
          this.location.scope,
          observation.repository.nodeId,
          observation.issue.nodeId,
          observation.assignment.nodeId,
        ]) ||
      !/^[a-f0-9]{64}$/.test(taskId)
    )
      throw new IntakeError('intake-state-invalid');
    const consume = (previous?: IntakeState): { state?: IntakeState; result: string } => {
      if (
        previous &&
        (previous.account.nodeId !== observation.receiving.nodeId ||
          previous.agentId !== observation.agentId ||
          previous.workspaceDir !== observation.workspaceDir)
      )
        throw new IntakeError('intake-account-changed');
      const state: IntakeState = previous ?? {
        version: 1,
        scope: this.location.scope,
        workspaceDir: observation.workspaceDir,
        agentId: observation.agentId,
        account: observation.receiving,
        policyDigest: 'manual',
        baselineAt: observation.observedAt,
        manualOnly: true,
        records: [],
      };
      state.observedAssignments ??= [];
      const existing = state.observedAssignments.find((entry) => entry.id === observation.id);
      if (existing?.consumedBy && existing.consumedBy !== taskId)
        return { result: existing.consumedBy };
      const advancesCutoff =
        consumedThrough !== undefined && consumedThrough > (existing?.consumedThrough ?? -1);
      if (existing?.consumedBy && !advancesCutoff) return { result: existing.consumedBy };
      if (existing) {
        existing.consumedBy = taskId;
        if (advancesCutoff) existing.consumedThrough = consumedThrough;
      } else
        state.observedAssignments.push({
          version: observation.version,
          id: observation.id,
          scope: observation.scope,
          receiving: observation.receiving,
          workspaceDir: observation.workspaceDir,
          agentId: observation.agentId,
          host: observation.host,
          repository: observation.repository,
          issue: observation.issue,
          assignment: observation.assignment,
          observedAt: observation.observedAt,
          consumedBy: taskId,
          ...(consumedThrough !== undefined ? { consumedThrough } : {}),
        });
      return { state, result: taskId };
    };
    return this.agentStorage.changeIntake(this.location.scope, this.resetOwner, (current) => {
      const { state, result } = consume(this.validate(current));
      return state ? { state: this.prepare(state), result } : { result };
    });
  }

  async reset(
    baselineAt: number,
    initial?: Pick<IntakeState, 'scope' | 'workspaceDir' | 'agentId' | 'account' | 'policyDigest'>,
  ): Promise<void> {
    await this.exclusive(async (state, save) => {
      const baseline = state ?? initial;
      if (!baseline) throw new IntakeError('intake-activation-required');
      await save({
        version: 1,
        resetGeneration: randomUUID(),
        scope: baseline.scope,
        workspaceDir: baseline.workspaceDir,
        agentId: baseline.agentId,
        account: baseline.account,
        policyDigest: baseline.policyDigest,
        baselineAt,
        records: [],
      });
    });
  }
}
