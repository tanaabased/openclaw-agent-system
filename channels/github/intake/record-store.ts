import { providerDiagnosticSchema } from '../../../utils/provider-diagnostic.ts';
import { join, resolve } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { codexNoticeSchema, codexNoticeLimit } from '../../../agent/codex-notice-outbox.ts';
import { automationHash } from '../../../agent/automation-hash.ts';
import ensurePrivateStateDirectories from '../../../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../../../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../../../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../../../core/private-state-lock-context.ts';

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
    observedAssignments: Type.Optional(
      Type.Array(
        Type.Omit(intakeRecordSchema, ['evidence', 'admittedAt', 'status', 'requiresRevalidation']),
      ),
    ),
    records: Type.Array(intakeRecordSchema),
    notices: Type.Optional(Type.Array(codexNoticeSchema, { maxItems: codexNoticeLimit })),
    noticePending: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type IntakeState = Static<typeof stateSchema>;

export class IntakeError extends Error {
  constructor(readonly code: string) {
    super(`${code}: ${intakeRemediation(code)}`);
  }
}

export function intakeRemediation(code: string): string {
  if (code === 'intake-automation-paused')
    return 'Intake scheduling is paused. Resume the native job, or set paused: false and run Install. Accepted runs and existing issue work retain their authority.';
  if (code === 'intake-manifest-unavailable')
    return 'Restore a readable, valid agent.yaml in the bound workspace, then retry. No rebind or Install is required for a policy-only repair.';
  if (code === 'intake-automation-update-required')
    return 'Run Agent System Install to apply the update and resume intake. Existing chats and work are retained.';
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
    return 'Review the current issue-assignment policy in agent.yaml, then retry the scan. Policy-only changes apply without Install.';
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
  async read(): Promise<IntakeState | undefined> {
    const contents = await this.file.read();
    if (contents === undefined) return;
    try {
      const value: unknown = JSON.parse(contents);
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
      // old notification backlogs never control admission or survive the next save.
      delete value.notices;
      delete value.noticePending;
      return value;
    } catch {
      throw new IntakeError('intake-state-invalid');
    }
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
            if (!Value.Check(stateSchema, state) || state.scope !== this.location.scope)
              throw new IntakeError('intake-state-invalid');
            const contents = JSON.stringify(state);
            if (Buffer.byteLength(contents) > 4 * 1024 * 1024)
              throw new IntakeError('intake-state-capacity');
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
