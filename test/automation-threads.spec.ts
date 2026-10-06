import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

import AutomationThreads, { automationThreadSelection } from '../agent/automation-threads.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';

function jobs(thread: unknown, ids = ['builds', 'reviews']) {
  const result = normalizeAutomations(
    ids.map((id) => ({ id, prompt: 'Check activity.', schedule: 'every 1 hour', thread })),
  );
  assert.equal(result.status, 'valid');
  if (result.status !== 'valid') throw new Error('invalid fixture');
  return result.automations as ResolvedAutomation[];
}
const rejects = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;

describe('agent/automation-threads', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp('/tmp/automation-threads-');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  function fixture(runtime: 'openclaw' | 'codex') {
    const native = new Map<string, { id: string; name?: string }>();
    let creates = 0;
    const adapter = {
      async lookup(id: string) {
        return native.get(id) ?? null;
      },
      async create(
        record: { nativeId?: string },
        saveId: (id: string) => Promise<void>,
        fresh: boolean,
      ) {
        if (!fresh && !record.nativeId) throw new Error('ambiguous');
        const id = record.nativeId ?? `native-${++creates}`;
        await saveId(id);
        native.set(id, { id });
        return id;
      },
      async rename(id: string, name: string) {
        native.set(id, { id, name });
      },
    };
    const store = new AutomationThreads({ root, scope: runtime, runtime }, adapter);
    return { store, adapter, native, creates: () => creates };
  }
  it('should share explicit ids in openclaw but partition codex by stable automation id', async () => {
    for (const runtime of ['openclaw', 'codex'] as const) {
      const f = fixture(runtime);
      const declarations = jobs({ id: 'activity', name: 'Activity' });
      const first = await f.store.resolve(declarations, true);
      assert.equal(
        new Set([...first.values()].map((x) => x.id)).size,
        runtime === 'openclaw' ? 1 : 2,
      );
      const reordered = await f.store.resolve([...declarations].reverse(), true);
      for (const [id, value] of first) assert.equal(reordered.get(id)?.id, value.id);
      assert.equal(f.creates(), runtime === 'openclaw' ? 1 : 2);
    }
  });
  it('should keep equal titles separate and retain identity after rename or removal', async () => {
    const f = fixture('openclaw');
    const first = await f.store.resolve(jobs('Activity'), true);
    assert.equal(f.creates(), 2);
    await f.store.resolve([], true);
    const renamed = await f.store.resolve(jobs({ name: 'New title' }), true);
    for (const [id, value] of first) assert.equal(renamed.get(id)?.id, value.id);
    assert.equal(f.creates(), 2);
    assert.ok([...renamed.values()].every((x) => x.name === 'New title'));
  });
  it('should adopt only an exact existing id and preserve an omitted name', async () => {
    const f = fixture('openclaw');
    f.native.set('activity', { id: 'activity', name: 'Existing title' });
    const resolved = await f.store.resolve(jobs({ id: 'activity' }), true);
    assert.equal(resolved.get('builds')?.outcome, 'bound');
    assert.equal(resolved.get('builds')?.name, 'Existing title');
    assert.equal(f.creates(), 0);
  });
  it('should require a persisted binding before scheduling an adopted conversation', async () => {
    const f = fixture('openclaw');
    f.native.set('activity', { id: 'activity' });
    await assert.rejects(
      f.store.resolve(jobs({ id: 'activity' })),
      rejects('automation-thread-sync-required'),
    );
    await f.store.resolve(jobs({ id: 'activity' }), true);
    assert.equal((await f.store.resolve(jobs({ id: 'activity' }))).get('builds')?.id, 'activity');
    assert.equal(f.creates(), 0);
  });

  it('should detect conflicting names before creating or renaming any conversation', async () => {
    const f = fixture('openclaw');
    const declarations = jobs({ id: 'activity', name: 'First' });
    declarations[1]!.thread!.name = 'Second';
    await assert.rejects(
      f.store.resolve(declarations, true),
      rejects('automation-thread-name-conflict'),
    );
    assert.equal(f.creates(), 0);
  });
  it('should reject a vanished saved binding without silently replacing it', async () => {
    const f = fixture('openclaw');
    await f.store.resolve(jobs({ id: 'activity' }), true);
    f.native.clear();
    await assert.rejects(
      f.store.resolve(jobs({ id: 'activity' }), true),
      rejects('automation-thread-recovery-required'),
    );
    assert.equal(f.creates(), 1);
  });
  it('should recover a known partial creation and serialize concurrent reconcilers', async () => {
    const f = fixture('openclaw');
    const create = f.adapter.create;
    let lost = true;
    f.adapter.create = async (...args) => {
      const id = await create(...args);
      if (lost) {
        lost = false;
        throw new Error('lost response');
      }
      return id;
    };
    const declarations = jobs({ id: 'activity' });
    await assert.rejects(f.store.resolve(declarations, true));
    await Promise.all([f.store.resolve(declarations, true), f.store.resolve(declarations, true)]);
    assert.equal(f.creates(), 1);
    assert.equal((await f.store.read()).records[0]?.phase, 'ready');
  });
  it('should leave inspection read-only and stop on failed lookups', async () => {
    const f = fixture('openclaw');
    await assert.rejects(
      f.store.resolve(jobs({ id: 'activity' })),
      rejects('automation-thread-sync-required'),
    );
    await assert.rejects(readFile(f.store.path), { code: 'ENOENT' });
    f.adapter.lookup = async () => {
      throw new Error('permission denied');
    };
    await assert.rejects(f.store.resolve(jobs({ id: 'activity' }), true), /permission denied/);
    assert.equal(f.creates(), 0);
  });
  it('should keep target overrides exact and ignore the whole shared declaration', async () => {
    const f = fixture('openclaw');
    const declarations = jobs({ id: 'activity', name: 'Ignored' });
    declarations[0]!.overrides.openclaw = { target: 'independent' };
    declarations[1]!.overrides.openclaw = { target: { thread: 'existing' } };
    assert.equal(automationThreadSelection(declarations[0]!, 'openclaw'), undefined);
    await assert.rejects(f.store.resolve(declarations, true), rejects('automation-thread-missing'));
    f.native.set('existing', { id: 'existing', name: 'Retained' });
    const resolved = await f.store.resolve(declarations, true);
    assert.equal(resolved.size, 1);
    assert.equal(resolved.get('reviews')?.name, 'Retained');
    assert.equal(f.creates(), 0);
  });
  it('should reject multiple active codex jobs adopting the same native id', async () => {
    const f = fixture('codex');
    f.native.set('native', { id: 'native' });
    await assert.rejects(
      f.store.resolve(jobs({ id: 'native' }), true),
      rejects('automation-thread-schedule-conflict'),
    );
    assert.equal(f.creates(), 0);
  });
});
