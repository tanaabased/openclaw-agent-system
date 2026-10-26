import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ColdHistory from '../agent/cold-history.ts';
import CodexDispatchStore, { type DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type DispatchStore from '../agent/dispatch-state.ts';
import OpenClawDispatchStore, {
  type OpenClawDispatchRecord,
} from '../agent/openclaw-dispatch-state.ts';
import { historyLifetimeMs } from '../agent/history-state.ts';
import managedOwner from '../agent/managed-owner.ts';
import readRetainedHistory from '../agent/read-retained-history.ts';

const scope = 'a'.repeat(64);
function retired(index: number, now = Date.now()): OpenClawDispatchRecord {
  const id = index.toString(16).padStart(64, '0');
  return {
    id,
    intakeId: id,
    issueKey: id,
    sourceThreadId: 'intake',
    phase: 'routing',
    createdAt: 1,
    manifestDigest: 'manifest',
    threadId: 'issue-' + index,
    context: '界'.repeat(30000),
    routing: 'r'.repeat(30000),
    retired: { at: now, by: 'intake' },
    retirement: {
      reason: 'issue-closed',
      at: now,
      checkedAt: now,
      eligibleAt: now,
      intakeId: id,
      archivedAt: now,
      worktreeRemovedAt: now,
    },
  };
}

describe('agent/history retention filesystem', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'history-retention-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const Store of [CodexDispatchStore, OpenClawDispatchStore]) {
    const runtime = Store === CodexDispatchStore ? 'codex' : 'openclaw';
    it(`should offload above two mib and cross cumulative four mib in ${runtime} without losing identities`, async () => {
      const store = new Store(root, scope) as DispatchStore<
        DispatchRecord | OpenClawDispatchRecord
      >;
      await store.exclusive(async (state, save) => {
        state.records.push(retired(1));
        await save();
      });
      assert.equal((await store.read()).records[0]!.retainedHistory, undefined);
      const originals = Array.from({ length: 36 }, (_, i) => retired(i + 2));
      const pending = { ...retired(99), retired: undefined, retirement: undefined };
      await store.transaction(async (state, save) => {
        state.records.push(...structuredClone(originals), pending);
        await save();
        assert.equal(state.records[0]!.retainedHistory?.terminal, true);
        assert.equal(JSON.stringify(state.records.at(-1)), JSON.stringify(pending));
      });
      const restarted = new Store(root, scope);
      const saved = await restarted.read();
      assert.equal(saved.records.length, 38);
      assert.ok((await readFile(store.path)).byteLength < 2 * 1024 * 1024);
      const terminal = saved.records[1]!;
      assert.equal(
        managedOwner<DispatchRecord | OpenClawDispatchRecord>(
          saved.records,
          terminal.threadId!,
          (r) => r.id === terminal.id,
        ).status,
        'historical',
      );
      const history = await restarted.history.read(
        terminal.retainedHistory!.entries[0]!,
        Date.now(),
      );
      assert.equal(history.status, 'available');
      if (history.status === 'available') assert.deepEqual(history.value, originals[0]);
      await rm(restarted.history.directory, { recursive: true });
      assert.equal(
        (await readRetainedHistory(terminal, restarted.history, Date.now()))!.entries[0]!.status,
        'history-unavailable',
      );
      assert.deepEqual(await restarted.read(), saved);
    });

    it(`should keep completed feedback out of the runnable limit across restart in ${runtime}`, async () => {
      const store = new Store(root, scope) as DispatchStore<
        DispatchRecord | OpenClawDispatchRecord
      >;
      const active = { ...retired(1), retired: undefined, retirement: undefined };
      if (runtime === 'openclaw') {
        active.phase = 'created';
        active.worktree = '/worktree';
        active.routingNote = 'selected';
        active.request = {
          key: 'issue-1',
          idempotencyKey: 'creation',
          agentId: 'receiver',
          cwd: '/worktree',
          label: 'issue',
          category: 'issues',
          model: 'provider/model',
          thinkingLevel: 'high',
        };
        active.sessionCreation = {
          attempted: true,
          sourceSessionId: 'intake',
          sourceRunId: 'run',
          sourceToolCallId: 'call',
          sessionId: 'child',
          verified: true,
        };
        active.effective = { status: 'verified', model: 'provider/model', effort: 'high' };
      }
      active.feedback = { baseline: {}, events: [] };
      await store.exclusive(async (state, save) => {
        state.records.push(active);
        await save();
      });
      for (let batch = 0; batch < 2; batch++) {
        await store.exclusive(async (state, save) => {
          const record = state.records[0]!;
          for (let n = 1; n <= 350; n++) {
            const index = batch * 350 + n;
            record.feedback!.events.push({
              id: index.toString(16).padStart(64, '0'),
              sourceId: 'comment-' + index,
              number: 1,
              nodeId: 'issue',
              itemType: 'issue',
              source: 'exact source ' + index,
              revision: scope,
              policyDigest: scope,
              createdAt: 1,
              phase: 'published',
              reported: true,
              receipt: { nodeId: 'reply-' + index, databaseId: index },
              result: { privateText: 'exact response ' + index },
            });
          }
          await save();
        });
      }
      const saved = (await new Store(root, scope).read()).records[0]!;
      assert.equal(saved.feedback!.events.length, 1);
      assert.equal(saved.feedback!.completed!.length, 699);
      assert.equal(saved.feedback!.events[0]!.result!.privateText, 'exact response 700');
      assert.ok(saved.retainedHistory!.entries.length >= 2);
      await rm(store.history.directory, { recursive: true });
      assert.deepEqual(
        (await store.read()).records[0]!.feedback!.completed,
        saved.feedback!.completed,
      );
    });

    it(`should preserve the journal on archive failure and retry a staged snapshot in ${runtime}`, async () => {
      const store = new Store(root, scope) as DispatchStore<
        DispatchRecord | OpenClawDispatchRecord
      >;
      await store.exclusive(async (_state, save) => {
        await save();
      });
      const before = await readFile(store.path, 'utf8');
      const originalWrite = store.file.write.bind(store.file);
      store.file.write = async () => {
        throw new Error('interrupted-live-commit');
      };
      const records = Array.from({ length: 20 }, (_, i) => retired(i + 1));
      const save = () =>
        store.exclusive(async (state, commit) => {
          state.records.push(...records);
          await commit();
        });
      await assert.rejects(save(), /interrupted-live-commit/);
      assert.equal(await readFile(store.path, 'utf8'), before);
      const staged = await readdir(store.history.directory);
      store.file.write = originalWrite;
      await save();
      assert.deepEqual(await readdir(store.history.directory), staged);
      const saved = await store.read();
      assert.equal(saved.records.length, records.length);
      assert.ok(saved.records.every((r) => r.retainedHistory?.terminal));
    });

    it(`should preserve protected-only exhaustion and reject stale resurrection in ${runtime}`, async () => {
      const store = new Store(root, scope) as DispatchStore<
        DispatchRecord | OpenClawDispatchRecord
      >;
      await store.exclusive(async (state, save) => {
        state.records.push(retired(1));
        await save();
      });
      await store.transaction(async (state, save) => {
        const stale = state.records[0]!;
        await store.exclusive(async (fresh, commit) => {
          fresh.records.push(...Array.from({ length: 20 }, (_, i) => retired(i + 2)));
          await commit();
        });
        stale.context = 'late edit';
        await assert.rejects(save(), /snapshot-conflict|dispatch-state-invalid/);
      });
      const before = await readFile(store.path, 'utf8');
      await assert.rejects(
        store.exclusive(async (state, save) => {
          state.records.push(
            ...Array.from({ length: 40 }, (_, i) => ({
              ...retired(i + 100),
              retired: undefined,
              retirement: undefined,
            })),
          );
          await save();
        }),
        /dispatch-state-capacity/,
      );
      assert.equal(await readFile(store.path, 'utf8'), before);
    });

    for (const mutation of ['update', 'reset'] as const) {
      it(`should release the journal during archive io and reject a concurrent ${mutation} in ${runtime}`, async () => {
        const store = new Store(root, scope) as DispatchStore<
          DispatchRecord | OpenClawDispatchRecord
        >;
        await store.exclusive(async (state, save) => {
          state.records.push(retired(1));
          await save();
        });
        const retain = store.history.retain.bind(store.history);
        let changed = false;
        store.history.retain = async (...args) => {
          if (!changed) {
            changed = true;
            const concurrent = new Store(root, scope);
            if (mutation === 'reset') await concurrent.reset('new-generation');
            else
              await concurrent.exclusive(async (state, save) => {
                state.records[0]!.context = 'newer evidence';
                await save();
              });
          }
          return retain(...args);
        };
        const expected =
          mutation === 'reset' ? /notification-reset-stale-operation/ : /snapshot-conflict/;
        await store.exclusive(async (state, save) => {
          state.records.push(...Array.from({ length: 20 }, (_, i) => retired(i + 2)));
          await assert.rejects(save(), expected);
          // a caller catching the first conflict still cannot overwrite the newer owner.
          await assert.rejects(save(), expected);
        });
        const saved = await store.read();
        if (mutation === 'reset') {
          assert.equal(saved.resetGeneration, 'new-generation');
          assert.deepEqual(saved.records, []);
        } else {
          assert.equal(saved.records.length, 1);
          assert.equal(saved.records[0]!.context, 'newer evidence');
        }
      });
    }

    it(`should leave live bytes intact when an archive write fails in ${runtime}`, async () => {
      const store = new Store(root, scope) as DispatchStore<
        DispatchRecord | OpenClawDispatchRecord
      >;
      await store.exclusive(async (state, save) => {
        state.records.push(retired(1));
        await save();
      });
      const before = await readFile(store.path, 'utf8');
      store.history.retain = async () => {
        throw new Error('archive-unavailable');
      };
      await assert.rejects(
        store.exclusive(async (state, save) => {
          state.records.push(...Array.from({ length: 20 }, (_, i) => retired(i + 2)));
          await save();
        }),
        /archive-unavailable/,
      );
      assert.equal(await readFile(store.path, 'utf8'), before);
    });
  }

  it('should expire cold detail without renewing its deadline or restoring executable state', async () => {
    const archive = new ColdHistory(root, scope);
    const value = { id: scope, plan: 'exact unicode — 界' };
    const reference = await archive.retain(value, 100, 100);
    assert.deepEqual(await archive.retain(value, 200, 200), reference);
    assert.equal(
      (await archive.read(reference, 100 + historyLifetimeMs)).status,
      'history-unavailable',
    );
    await archive.prune(100 + historyLifetimeMs);
    assert.deepEqual(await readdir(archive.directory), []);
  });

  it('should reject corruption and scope substitution without modifying the active journal', async () => {
    const archive = new ColdHistory(root, scope);
    const reference = await archive.retain({ id: scope, detail: 'original' }, 100, 100);
    const name = (await readdir(archive.directory))[0]!;
    await writeFile(join(archive.directory, name), '{}');
    assert.equal((await archive.read(reference, 100)).status, 'history-unavailable');
    await assert.rejects(archive.retain({ id: scope, detail: 'original' }, 100, 100), /integrity/);
    assert.equal(
      (await new ColdHistory(root, 'b'.repeat(64)).read(reference, 100)).status,
      'history-unavailable',
    );
  });
});
