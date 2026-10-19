import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { codexNoticeSchema, codexNoticeLimit } from '../../../agent/codex-notice-outbox.ts';
import { automationHash } from '../../../agent/automation-hash.ts';
import ensurePrivateStateDirectories from '../../../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../../../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../../../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../../../core/private-state-lock-context.ts';
import mergeStateSnapshot, {
  refreshStateSnapshot,
  stateSnapshotConflictCode,
} from '../../../core/merge-state-snapshot.ts';
import {
  retainedDecodeBudget,
  retainedEvidenceSchema,
  retainedHistoryLimit,
  unpackRetained,
  RetainedHistoryError,
} from '../../../agent/retained-history.ts';

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
        ownerPinned: Type.Literal(true),
        actorPinned: Type.Literal(true),
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
const stateSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: text,
    workspaceDir: text,
    agentId: text,
    account: identity,
    policyDigest: text,
    baselineAt: time,
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
    lastAttemptAt: Type.Optional(time),
    blocker: Type.Optional(
      Type.Object({ code: text, since: time, retryAfter: time }, { additionalProperties: false }),
    ),
    records: Type.Array(intakeRecordSchema),
    history: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: text,
            issueKey: text,
            assignmentAt: text,
            retiredAt: time,
            dispatchId: text,
            evidence: retainedEvidenceSchema,
          },
          { additionalProperties: false },
        ),
        { maxItems: retainedHistoryLimit },
      ),
    ),
    notices: Type.Optional(Type.Array(codexNoticeSchema, { maxItems: codexNoticeLimit })),
    noticePending: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type IntakeState = Static<typeof stateSchema>;

export function retainedIntake(
  state: IntakeState | undefined,
  id: string | undefined,
): IntakeRecord | undefined {
  const live = state?.records.find((record) => record.id === id);
  if (live) return live;
  const entry = state?.history?.find((record) => record.id === id);
  if (!entry) return;
  const record = unpackRetained(entry.evidence);
  if (
    !Value.Check(intakeRecordSchema, record) ||
    record.id !== entry.id ||
    record.assignment.createdAt !== entry.assignmentAt ||
    automationHash([
      record.scope,
      record.receiving.nodeId,
      record.repository.nodeId,
      record.issue.nodeId,
    ]) !== entry.issueKey
  )
    throw new IntakeError('intake-state-invalid');
  return record;
}

export class IntakeError extends Error {
  constructor(readonly code: string) {
    super(`${code}: ${intakeRemediation(code)}`);
  }
}

export function intakeRemediation(code: string): string {
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
    return 'Review the exact operation in the native approval prompt. Approval does not prove successful or unattended execution; verify the next run.';
  if (code.includes('profile') || code.includes('model'))
    return 'Configure a supported low model and effort profile, then retry authorized Install; no substitute is selected.';
  if (code.includes('state'))
    return 'Preserve the private evidence. Inspect its size, ownership, or schema and restore a verified copy; do not reset the baseline.';
  if (code.includes('identity') || code.includes('account') || code.includes('auth'))
    return 'Check the native gh account against the configured login and identity pins, then retry authorized Install.';
  if (code.includes('incomplete'))
    return 'Provider evidence exceeded the bounded scan. Review repository scope or assignment history; the checkpoint has not advanced.';
  if (code.includes('disabled') || code.includes('binding'))
    return 'Restore the trusted binding and policy, or authorize Install to pause the retained intake job.';
  if (code.includes('policy') || code.includes('activation') || code.includes('reserved'))
    return 'Review the current issue-assignment policy and authorize Install reconciliation before scanning.';
  return 'Inspect the diagnostic for the affected operation before retrying. Retained evidence and the last successful checkpoint remain available; no credential failure has been established.';
}

/** host location mapping only; the openclaw production monitor does not consume this store. */
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
  return {
    root: resolve(input.root),
    scope,
    path: join(resolve(input.root), `github-intake-${scope}.json`),
  };
}

/** one private transaction contains records and checkpoint so neither can outrun the other. */
export default class IntakeRecordStore {
  readonly file: PrivateStateFile;
  constructor(readonly location: ReturnType<typeof intakeLocation>) {
    this.file = new PrivateStateFile({
      path: location.path,
      directories: [location.root],
      currentUid: process.getuid?.(),
      label: 'GitHub assignment intake',
      maximumBytes: 4 * 1024 * 1024,
    });
  }
  private validate(value: unknown): asserts value is IntakeState {
    try {
      if (
        !Value.Check(stateSchema, value) ||
        value.scope !== this.location.scope ||
        new Set(value.records.map((r) => r.id)).size !== value.records.length ||
        value.records.some(
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
        )
      )
        throw new Error('invalid state');
      retainedDecodeBudget('intake', value.scope)(value);
      const ids = [...value.records, ...(value.history ?? [])].map((record) => record.id);
      if (new Set(ids).size !== ids.length) throw new Error('invalid state');
      for (const entry of value.history ?? []) {
        const record = retainedIntake(value, entry.id)!;
        if (
          record.scope !== value.scope ||
          record.workspaceDir !== value.workspaceDir ||
          record.agentId !== value.agentId ||
          record.receiving.nodeId !== value.account.nodeId ||
          record.id !==
            automationHash([
              value.scope,
              record.repository.nodeId,
              record.issue.nodeId,
              record.assignment.nodeId,
            ])
        )
          throw new Error('invalid state');
      }
    } catch (error) {
      if (error instanceof RetainedHistoryError) throw error;
      throw new IntakeError('intake-state-invalid');
    }
  }
  async read(): Promise<IntakeState | undefined> {
    const contents = await this.file.read();
    if (contents === undefined) return;
    try {
      const value: unknown = JSON.parse(contents);
      this.validate(value);
      // obsolete presentation never controls admission.
      delete value.notices;
      delete value.noticePending;
      return value;
    } catch (error) {
      if (error instanceof RetainedHistoryError) throw error;
      throw new IntakeError('intake-state-invalid');
    }
  }
  /** provider reads run unlocked; only a fresh, nonconflicting snapshot may advance discovery. */
  async transaction<T>(
    operation: (
      state: IntakeState | undefined,
      save: (state: IntakeState) => Promise<void>,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    let before = await this.read();
    return operation(
      before && structuredClone(before),
      async (proposed) => {
        await this.exclusive(async (current, save) => {
          if (
            before &&
            current &&
            [
              'scope',
              'workspaceDir',
              'agentId',
              'account',
              'policyDigest',
              'baselineAt',
              'checkpoint',
              'discovery',
            ].some(
              (key) =>
                !isDeepStrictEqual(
                  before![key as keyof IntakeState],
                  current[key as keyof IntakeState],
                ),
            )
          )
            throw new Error(stateSnapshotConflictCode);
          const merged = mergeStateSnapshot(before, proposed, current) as IntakeState;
          await save(merged);
          refreshStateSnapshot(proposed, merged);
          before = structuredClone(merged);
        });
      },
      new AbortController().signal,
    );
  }
  async exclusive<T>(
    operation: (
      state: IntakeState | undefined,
      save: (state: IntakeState) => Promise<void>,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    await ensurePrivateStateDirectories({
      directories: [this.location.root],
      currentUid: process.getuid?.(),
      label: 'GitHub assignment intake',
    });
    const lock = await acquirePrivateStateFileLock(this.location.path, {
      staleMs: 30_000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await withPrivateStateLock(lock, async () =>
        operation(
          await this.read(),
          async (state) => {
            lock.assertHeld();
            this.validate(state);
            const contents = JSON.stringify(state);
            if (Buffer.byteLength(contents) > 4 * 1024 * 1024)
              throw new RetainedHistoryError('intake-state-capacity', {
                journal: 'intake',
                record: state.records.at(-1)?.id ?? state.scope,
                reason: 'protected-admissions-and-required-history',
                limit: 4 * 1024 * 1024,
                actual: Buffer.byteLength(contents),
              });
            retainedDecodeBudget('intake', state.scope)(state);
            await this.file.write(contents);
          },
          lock.signal,
        ),
      );
    } finally {
      await lock.release();
    }
  }
}
