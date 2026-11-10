import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import type DispatchStore from '../agent/dispatch-state.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import { assertDispatchStorage } from '../agent/dispatch-storage.ts';
import { dispatchAdmission, managedIssueState } from '../agent/managed-issue.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import pendingRetirement from '../agent/pending-retirement.ts';
import retainDispatchHistory, {
  verifiedTerminalCleanup,
} from '../agent/retain-dispatch-history.ts';
import retirementConsumption from '../agent/retirement-consumption.ts';
import retirementEffects from '../agent/retirement-effects.ts';
import retirementLocalData from '../agent/retirement-local-data.ts';
import IntakeRecordStore, { intakeLocation } from '../channels/github/intake/record-store.ts';
import cutover638Active, { cutover638Compatibility } from './cutover-638-active.ts';

const text = Type.String({ minLength: 1 });
const requestSchema = Type.Object(
  {
    source: text,
    output: text,
    runtime: Type.Union([Type.Literal('codex'), Type.Literal('openclaw')]),
    namespace: text,
    workspace: text,
    agent: text,
  },
  { additionalProperties: false },
);
export type Cutover638Request = Static<typeof requestSchema>;
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const within = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
};

async function inventory(root: string, prefix = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = join(prefix, name);
    const stat = await lstat(join(root, path));
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.nlink > 1 && stat.isFile())
    )
      throw new Error('cutover-unsafe-file: ' + path);
    if (name.endsWith('.lock') || name.endsWith('.tmp'))
      throw new Error('cutover-unsettled-file: ' + path);
    if (stat.isDirectory()) Object.assign(files, await inventory(root, path));
    else files[path] = digest(await readFile(join(root, path)));
  }
  return files;
}

// terminal capsules omit exact provider inputs. recover only their matching final snapshot,
// never an older attempt that could resurrect an already completed publication.
async function effectSource(
  store: DispatchStore<SharedDispatchRecord>,
  record: SharedDispatchRecord,
) {
  if (!record.retainedHistory?.terminal) return record;
  const history = record.retainedHistory;
  const summary = (value: typeof history) =>
    JSON.parse(
      JSON.stringify({
        effects: value.effects,
        outcome: value.outcome,
        sessionId: value.sessionId,
        pullRequest: value.pullRequest,
      }),
    );
  for (const reference of [...history.entries].reverse()) {
    const path = store.history.location(reference);
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!bytes) continue;
    if (digest(bytes) !== reference.digest) throw new Error('history-integrity-failed');
    const decoded: unknown = JSON.parse(bytes.toString());
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      !('version' in decoded) ||
      decoded.version !== 1 ||
      !('value' in decoded)
    )
      throw new Error('cutover-history-invalid');
    const value = decoded.value;
    if (!Value.Check(store.contract.recordSchema, value))
      throw new Error('cutover-history-invalid');
    const original = value as SharedDispatchRecord;
    if (
      original.id !== record.id ||
      original.intakeId !== record.intakeId ||
      !isDeepStrictEqual(original.manualIssue, record.manualIssue) ||
      original.threadId !== record.threadId ||
      original.worktree !== record.worktree ||
      !isDeepStrictEqual(original.retirement, record.retirement)
    )
      continue;
    const projected = retainDispatchHistory(original);
    if (
      projected?.retainedHistory &&
      isDeepStrictEqual(summary(projected.retainedHistory), summary(history))
    )
      return original;
  }
  const settled =
    history.effects?.every(
      (effect) =>
        ['published', 'delivered', 'reconciled', 'prepared'].includes(effect.status) &&
        (!effect.attempt || Boolean(effect.receipt)) &&
        !effect.pendingPush &&
        !effect.contentDigest,
    ) ?? true;
  if (!settled) throw new Error('cutover-unresolved-history: ' + record.id);
  return record;
}

/** one-time offline transformation; only a new output directory is writable. */
export default async function cutover638(input: unknown) {
  if (!Value.Check(requestSchema, input)) throw new Error('cutover-request-invalid');
  const source = await realpath(input.source);
  const output = join(
    await realpath(dirname(resolve(input.output))),
    basename(resolve(input.output)),
  );
  if (within(source, output) || within(output, source)) throw new Error('cutover-path-overlap');
  if (!(await lstat(source)).isDirectory()) throw new Error('cutover-source-invalid');
  const before = await inventory(source);
  const dispatchDirectory = input.runtime === 'codex' ? 'state' : 'dispatch';
  const intakeDirectory = input.runtime === 'codex' ? 'state' : 'intake';
  const location = (root: string) =>
    intakeLocation({
      runtime: input.runtime,
      root: join(root, intakeDirectory),
      namespace: input.namespace,
      workspaceDir: input.workspace,
      agentId: input.agent,
      resetRoot: join(root, dispatchDirectory),
    });
  const Store = input.runtime === 'codex' ? CodexDispatchStore : OpenClawDispatchStore;
  const originalStore: DispatchStore<SharedDispatchRecord> = new Store(
    join(source, dispatchDirectory),
    location(source).scope,
  );
  if (!before[relative(source, originalStore.path)]) throw new Error('cutover-dispatch-missing');
  const original = await originalStore.read();
  const originalIntake = await new IntakeRecordStore(location(source)).read();
  const admitted = managedIssueState(originalIntake, original.records);
  if (!admitted || admitted.workspaceDir !== input.workspace || admitted.agentId !== input.agent)
    throw new Error('cutover-intake-mismatch');
  const selected = original.records.map((record) => {
    const intake = dispatchAdmission(record, admitted.records);
    if (
      !intake ||
      intake.scope !== original.scope ||
      intake.workspaceDir !== input.workspace ||
      intake.agentId !== input.agent ||
      intake.receiving.nodeId !== admitted.account.nodeId
    )
      throw new Error('cutover-assignment-unresolved: ' + record.id);
    return { record, intake };
  });
  await mkdir(output, { mode: 0o700 });
  try {
    for (const [path, hash] of Object.entries(before)) {
      const bytes = await readFile(join(source, path));
      if (digest(bytes) !== hash) throw new Error('cutover-source-changed');
      await mkdir(dirname(join(output, path)), { recursive: true, mode: 0o700 });
      await writeFile(join(output, path), bytes, { flag: 'wx', mode: 0o600 });
    }
    const store: DispatchStore<SharedDispatchRecord> = new Store(
      join(output, dispatchDirectory),
      original.scope,
    );
    const intakeStore = new IntakeRecordStore(location(output));
    const state = structuredClone(original);
    state.version = 2;
    const removed: string[] = [];
    const pending: string[] = [];
    const transformed: string[] = [];
    const pendingOperations: { id: string; reasons: string[] }[] = [];
    // consume exact historical events before disposing any task. existing consumers win.
    for (const { record, intake } of selected)
      await retirementConsumption(intakeStore, intake, record.id, intake.observedAt);
    for (const { record: sourceRecord, intake } of selected) {
      const record = state.records.find((entry) => entry.id === sourceRecord.id)!;
      const complete = verifiedTerminalCleanup(record);
      const cleanup = record.retirement;
      const started =
        cleanup &&
        (record.cleanupPending ||
          cleanup.archiveAttempt ||
          cleanup.archiveRequest ||
          cleanup.archivedAt !== undefined ||
          cleanup.worktreeRemovalAttemptedAt !== undefined ||
          cleanup.worktreeRemovedAt !== undefined);
      if (!complete && !started) {
        const projected = cutover638Active(record);
        if (projected.pending.length)
          pendingOperations.push({ id: record.id, reasons: projected.pending });
        const history = projected.record as typeof record & {
          deliveryHistory?: unknown[];
        };
        delete history.deliveryHistory;
        const retainedEffects = new Set(
          retirementEffects(projected.record, intake).map((effect) => effect.id),
        );
        store.retainRetirementEffects(
          state,
          retirementEffects(record, intake).filter((effect) => !retainedEffects.has(effect.id)),
        );
        if (projected.record.threadId && projected.record.worktree && projected.record.request) {
          delete projected.record.retainedHistory;
          await store.history.exclusive(() => store.history.removeTask(record.id));
        }
        if (!isDeepStrictEqual(projected.record, record)) {
          state.records[state.records.indexOf(record)] = projected.record;
          transformed.push(record.id);
        }
        continue;
      }
      const originalEffectSource = await effectSource(store, record);
      store.retainRetirementEffects(state, retirementEffects(originalEffectSource, intake));
      if (!complete) {
        pendingRetirement(record);
        pending.push(record.id);
        continue;
      }
      if (record.threadId) {
        const incarnation =
          input.runtime === 'codex'
            ? record.threadId
            : ((originalEffectSource as { sessionCreation?: { sessionId?: string } })
                .sessionCreation?.sessionId ?? record.retainedHistory?.sessionId);
        if (!incarnation) throw new Error('cutover-session-unresolved: ' + record.id);
        await retirementLocalData({
          root: store.root,
          binding: {
            runtime: input.runtime,
            agentId: input.agent,
            workspace: input.workspace,
            namespace: input.namespace,
            session: record.threadId,
            incarnation,
          },
          intake,
          retain: async (effects) => {
            store.retainRetirementEffects(state, effects);
          },
        });
      }
      await store.dispose(state, record);
      removed.push(record.id);
    }
    // avoid normal transaction housekeeping: ageing/offloading unrelated active state is not cutover.
    if (!isDeepStrictEqual(state, original)) await store.file.write(assertDispatchStorage(state));
    await store.read();
    await intakeStore.read();
    if (!isDeepStrictEqual(await inventory(source), before))
      throw new Error('cutover-source-changed');
    const after = await inventory(output);
    const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .filter((path) => before[path] !== after[path])
      .map((path) => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
    return {
      artifact: 'cutover-638-v3',
      requiresCompatibleRuntime: 'dispatch-storage-v2',
      runtime: input.runtime,
      scope: original.scope,
      output,
      removed,
      pending,
      transformed,
      pendingOperations,
      remainingCompatibility: state.records.flatMap((record) => {
        const fields = cutover638Compatibility(record);
        return fields.length ? [{ id: record.id, fields }] : [];
      }),
      retained: state.records.length,
      uncertainEffects: new Set(
        [
          ...(state.retirementEffects ?? []),
          ...selected.flatMap(({ record, intake }) => {
            const retained = state.records.find((entry) => entry.id === record.id);
            return retained ? retirementEffects(retained, intake) : [];
          }),
        ].map((effect) => effect.id),
      ).size,
      changes,
    };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
