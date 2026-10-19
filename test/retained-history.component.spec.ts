import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { automationHash } from '../agent/automation-hash.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import { retainedDispatch } from '../agent/dispatch-retention.ts';
import { issueKey } from '../agent/dispatch-pending.ts';
import compactIntakeHistory from '../agent/intake-retention.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import IntakeRecordStore, {
  intakeLocation,
  retainedIntake,
} from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

const contentBytes = 4 * 1024 * 1024;
function record(index: number, terminal = true) {
  const id = automationHash(index);
  return {
    id,
    intakeId: id,
    issueKey: id,
    sourceThreadId: 'coordinator',
    phase: 'routing' as const,
    createdAt: 1,
    manifestDigest: 'manifest',
    context: JSON.stringify({ plan: 'Plan \\ "\n🚀 '.repeat(6000) }).slice(0, 90000),
    ...(terminal
      ? {
          nativeInactive: true,
          retirement: {
            reason: 'issue-closed' as const,
            intakeId: id,
            at: 2,
            checkedAt: 2,
            eligibleAt: 2,
          },
          retired: { at: 2, by: 'coordinator' },
        }
      : {}),
  };
}

describe('agent/retained history journals', () => {
  let root: string;
  const scope = 'a'.repeat(64);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'retained-history-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const Store of [CodexDispatchStore, OpenClawDispatchStore]) {
    const runtime = Store === CodexDispatchStore ? 'codex' : 'openclaw';
    it(`should compact cumulative ${runtime} history beyond four mib and retain protected work`, async () => {
      const store = new Store(root, scope);
      const records = Array.from({ length: 55 }, (_, index) => record(index));
      assert.ok(Buffer.byteLength(JSON.stringify(records)) > contentBytes);
      const active = record(100, false);
      const cleanup = { ...record(101), retired: undefined };
      await store.exclusive(async (state, save) => {
        state.records.push(...structuredClone(records), active, cleanup);
        await save();
        assert.ok(state.records[0]!.retained);
        assert.equal(state.records[0]!.context, undefined);
      });
      const saved = await readFile(store.path, 'utf8');
      assert.ok(Buffer.byteLength(saved) < contentBytes);
      const restarted = await new Store(root, scope).read();
      for (const original of records)
        assert.deepEqual(
          retainedDispatch(restarted.records.find((entry) => entry.id === original.id)),
          original,
        );
      assert.deepEqual(
        restarted.records.find((entry) => entry.id === active.id),
        active,
      );
      assert.equal(
        restarted.records.find((entry) => entry.id === cleanup.id)!.context,
        cleanup.context,
      );
      await store.exclusive(async (_state, save) => save());
      assert.equal(await readFile(store.path, 'utf8'), saved);
    });

    it(`should migrate near-capacity ${runtime} legacy state only on write and preserve failed replacements`, async () => {
      const store = new Store(root, scope);
      const records: ReturnType<typeof record>[] = [];
      while (
        Buffer.byteLength(
          JSON.stringify({ version: 1, scope, records: [...records, record(records.length)] }),
        ) < contentBytes
      )
        records.push(record(records.length));
      const legacy = JSON.stringify({ version: 1, scope, records });
      assert.ok(Buffer.byteLength(legacy) > contentBytes * 0.95);
      await store.file.write(legacy);
      await store.read();
      assert.equal(await readFile(store.path, 'utf8'), legacy);
      const write = store.file.write.bind(store.file);
      store.file.write = async () => {
        throw new Error('injected-replacement-failure');
      };
      await assert.rejects(
        store.exclusive(async (state, save) => {
          state.records.push(record(500));
          await save();
        }),
        /injected-replacement-failure/,
      );
      assert.equal(await readFile(store.path, 'utf8'), legacy);
      store.file.write = write;
      await store.exclusive(async (state, save) => {
        state.records.push(record(500));
        await save();
      });
      assert.ok((await store.read()).records.every((entry) => entry.retained));
      const persisted = await readFile(store.path, 'utf8');
      const corrupt = JSON.parse(persisted);
      corrupt.records[0].retained.digest = 'f'.repeat(64);
      await store.file.write(JSON.stringify(corrupt));
      await assert.rejects(store.read(), /retained-evidence-invalid/);
      assert.equal(await readFile(store.path, 'utf8'), JSON.stringify(corrupt));
    });

    it(`should reject protected-only ${runtime} exhaustion before reserving a side effect`, async () => {
      const store = new Store(root, scope);
      await store.exclusive(async (state, save) => {
        state.records.push(record(100, false));
        await save();
      });
      const before = await readFile(store.path, 'utf8');
      let effects = 0;
      await assert.rejects(
        store.exclusive(async (state, save) => {
          state.records.push(...Array.from({ length: 55 }, (_, index) => record(index, false)));
          await save();
          effects++;
        }),
        (error) => {
          const diagnostic = (error as { retentionDiagnostic: { limit: number; actual: number } })
            .retentionDiagnostic;
          assert.equal(diagnostic.limit, contentBytes);
          assert.ok(diagnostic.actual > contentBytes);
          return true;
        },
      );
      assert.equal(effects, 0);
      assert.equal(await readFile(store.path, 'utf8'), before);
    });
  }

  it('should reject a stale writer after compaction without restoring history or losing newer results', async () => {
    const store = new CodexDispatchStore(root, scope);
    await store.exclusive(async (state, save) => {
      state.records.push(record(0, false));
      await save();
    });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = store.transaction(async (state, save) => {
      entered();
      await gate;
      state.records[0]!.context = 'stale';
      await save();
    });
    await ready;
    await store.transaction(async (state, save) => {
      Object.assign(state.records[0]!, record(0));
      await save();
    });
    release();
    await assert.rejects(stale, /private-state-snapshot-conflict/);
    assert.deepEqual(retainedDispatch((await store.read()).records[0]), record(0));
  });

  it('should migrate intake at its real byte boundary without advancing the baseline or evicting new admissions', async () => {
    const fixture = intakeFixture();
    const store = new IntakeRecordStore(
      intakeLocation({
        runtime: 'codex',
        root,
        namespace: 'bytes',
        workspaceDir: '/workspace',
        agentId: 'receiver',
      }),
    );
    const input = {
      store,
      policy: fixture.policy,
      policyDigest: 'policy',
      workspaceDir: '/workspace',
      agentId: 'receiver',
      now: baseline,
      connect: async () => fixture.client,
      assertCurrent: async () => {},
    };
    await scanAssignments({ ...input, activate: true });
    await scanAssignments({ ...input, now: baseline + 120000 });
    const state = (await store.read())!;
    const original = state.records[0]!;
    const admission = (index: number) => {
      const value = structuredClone(original);
      value.assignment.nodeId = index + '\\'.repeat(4000);
      value.issue.nodeId = index + '"'.repeat(4000);
      value.repository.name = '\\'.repeat(4000);
      value.evidence.policyDigest = '"'.repeat(4000);
      value.id = automationHash([
        value.scope,
        value.repository.nodeId,
        value.issue.nodeId,
        value.assignment.nodeId,
      ]);
      return value;
    };
    state.records = [];
    for (let index = 0; ; index++) {
      const next = admission(index);
      if (
        Buffer.byteLength(JSON.stringify({ ...state, records: [...state.records, next] })) >=
        contentBytes
      )
        break;
      state.records.push(next);
    }
    const legacy = JSON.stringify(state);
    assert.ok(Buffer.byteLength(legacy) > contentBytes * 0.98);
    await store.file.write(legacy);
    await store.read();
    assert.equal(await readFile(store.location.path, 'utf8'), legacy);
    const dispatch = new CodexDispatchStore(root, store.location.scope);
    await dispatch.exclusive(async (current, save) => {
      current.records = state.records.map((item, index) => ({
        ...record(index),
        context: 'finished',
        intakeId: item.id,
        issueKey: issueKey(item),
        retirement: {
          reason: 'issue-closed',
          intakeId: item.id,
          at: baseline + 120000,
          checkedAt: baseline + 120000,
          eligibleAt: baseline + 120000,
        },
      }));
      await save();
    });
    await compactIntakeHistory(store, dispatch);
    const compact = (await store.read())!;
    assert.equal(compact.records.length, 0);
    assert.equal(compact.history!.length, state.records.length);
    assert.equal(compact.baselineAt, state.baselineAt);
    assert.equal(compact.checkpoint, state.checkpoint);
    assert.deepEqual(retainedIntake(compact, state.records[0]!.id), state.records[0]);
    await store.exclusive(async (current, save) => {
      current!.records.push(admission(999));
      await save(current!);
    });
    const before = await readFile(store.location.path, 'utf8');
    await assert.rejects(
      store.exclusive(async (current, save) => {
        current!.records.push(
          ...Array.from({ length: state.records.length + 1 }, (_, index) =>
            admission(index + 1000),
          ),
        );
        await save(current!);
      }),
      /intake-state-capacity/,
    );
    assert.equal(await readFile(store.location.path, 'utf8'), before);
  });

  it('should compact admissions only against committed retirement and preserve repeat-scan suppression', async () => {
    const fixture = intakeFixture();
    const store = new IntakeRecordStore(
      intakeLocation({
        runtime: 'codex',
        root,
        namespace: 'test',
        workspaceDir: '/workspace',
        agentId: 'receiver',
      }),
    );
    const input = {
      store,
      policy: fixture.policy,
      policyDigest: 'policy',
      workspaceDir: '/workspace',
      agentId: 'receiver',
      now: baseline,
      connect: async () => fixture.client,
      assertCurrent: async () => {},
    };
    await scanAssignments({ ...input, activate: true });
    await scanAssignments({ ...input, now: baseline + 120000 });
    const original = (await store.read())!;
    const admission = original.records[0]!;
    const alternate = (name: string, at: number) => {
      const value = structuredClone(admission);
      value.assignment.nodeId = name;
      value.assignment.createdAt = new Date(at).toISOString();
      value.id = automationHash([
        value.scope,
        value.repository.nodeId,
        value.issue.nodeId,
        value.assignment.nodeId,
      ]);
      return value;
    };
    const older = alternate('earlier-assignment', baseline + 1000);
    const newer = alternate('pending-reassignment', baseline + 130000);
    original.records.unshift(older);
    original.records.push(newer);
    await store.exclusive(async (_state, save) => save(original));
    const dispatch = new CodexDispatchStore(root, store.location.scope);
    await dispatch.exclusive(async (state, save) => {
      state.records.push({
        ...record(0),
        intakeId: admission.id,
        issueKey: issueKey(admission),
        retirement: {
          reason: 'issue-closed',
          intakeId: admission.id,
          at: baseline + 120000,
          checkedAt: baseline + 120000,
          eligibleAt: baseline + 120000,
        },
      });
      await save();
    });
    const write = store.file.write.bind(store.file);
    store.file.write = async () => {
      throw new Error('interrupted-intake-commit');
    };
    await assert.rejects(compactIntakeHistory(store, dispatch), /interrupted-intake-commit/);
    assert.deepEqual(await store.read(), original);
    assert.ok((await dispatch.read()).records[0]!.retained);
    store.file.write = write;
    await compactIntakeHistory(store, dispatch);
    await compactIntakeHistory(store, dispatch);
    const compact = (await store.read())!;
    assert.deepEqual(compact.records, [newer]);
    assert.equal(compact.history?.length, 2);
    assert.equal(compact.baselineAt, original.baselineAt);
    assert.equal(compact.checkpoint, original.checkpoint);
    assert.deepEqual(retainedIntake(compact, admission.id), admission);
    assert.deepEqual(retainedIntake(compact, older.id), older);
    await scanAssignments({ ...input, now: baseline + 180000 });
    assert.deepEqual((await store.read())!.records, [newer]);
  });
});
