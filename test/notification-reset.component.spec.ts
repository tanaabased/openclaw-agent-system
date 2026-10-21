import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import resetNotifications, {
  previewNotificationReset,
  type NotificationResetAdapter,
  type NotificationResetSnapshot,
} from '../agent/notification-reset.ts';
import NotificationResetStore, {
  assertNotificationManagement,
} from '../agent/notification-reset-state.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import waitForCodexWorktreeRemoval from '../agent/codex-worktree-removal.ts';
import IntakeRecordStore from '../channels/github/intake/record-store.ts';

describe('agent/notification reset recovery', () => {
  let root: string;
  let store: NotificationResetStore;
  let events: string[];
  let snapshot: NotificationResetSnapshot;
  let adapter: NotificationResetAdapter;
  const scope = 'a'.repeat(64);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notification-reset-'));
    store = new NotificationResetStore(root, scope);
    events = [];
    snapshot = {
      runtime: 'codex',
      agentId: 'tester',
      workspace: '/workspace',
      scope,
      automation: '{"status":"ACTIVE"}',
      inventory: '{"records":[]}',
      resources: [],
    };
    adapter = {
      fence: (run) => run(),
      snapshot: async () => structuredClone(snapshot),
      pause: async () => {
        events.push('pause');
        return { status: 'done' };
      },
      idle: async () => {
        events.push('idle');
        return { status: 'done' };
      },
      clear: async () => {
        events.push('clear');
      },
      purge: async (_record, resource) => {
        events.push(resource.id);
        return { status: 'done' };
      },
      baseline: async () => {
        events.push('baseline');
      },
      coordinator: async () => ({ status: 'done' }),
      restore: async () => {
        events.push('restore');
        return { status: 'done' };
      },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const run = async (purge = false) =>
    resetNotifications({
      store,
      adapter,
      preview: await previewNotificationReset(store, adapter, purge),
      now: () => 100,
    });

  it('should retain intent before effects and delete it only after baseline and restoration', async () => {
    adapter.pause = async () => {
      assert.equal((await store.read())?.phase, 'pause');
      events.push('pause');
      return { status: 'done' };
    };
    adapter.restore = async (record) => {
      assert.equal(record.baselineAt, 100);
      assert.equal((await store.read())?.phase, 'restore');
      events.push('restore');
      return { status: 'done' };
    };
    assert.equal((await run()).status, 'complete');
    assert.deepEqual(events, ['pause', 'idle', 'clear', 'baseline', 'restore']);
    assert.equal(await store.read(), undefined);
  });

  it('should hold without clearing active turns and continue on the same command', async () => {
    adapter.idle = async () => ({ status: 'waiting', code: 'notification-reset-turns-active' });
    assert.equal((await run()).status, 'waiting');
    assert.deepEqual(events, ['pause']);
    await assert.rejects(
      assertNotificationManagement(root, scope),
      /notification-reset-in-progress/u,
    );
    const operation = (await store.read())!.id;
    adapter.idle = async () => ({ status: 'done' });
    adapter.clear = async (record) => {
      assert.equal(record.id, operation);
      events.push('clear');
    };
    assert.equal((await run()).status, 'complete');
    assert.equal(events.filter((event) => event === 'pause').length, 2);
    await assertNotificationManagement(root, scope);
  });

  it('should reject confirmation drift before writing a recovery record', async () => {
    const preview = await previewNotificationReset(store, adapter, false);
    adapter.fence = async (run) => {
      snapshot.inventory = '{"records":["new"]}';
      return run();
    };
    await assert.rejects(
      resetNotifications({ store, adapter, preview }),
      /notification-reset-preview-changed/u,
    );
    assert.equal(await store.read(), undefined);
    assert.deepEqual(events, []);
  });

  it('should resume a partial purge without repeating completed effects or losing identity', async () => {
    snapshot.resources = ['first', 'second'].map((id) => ({
      id,
      kind: 'chat',
      description: id,
      identity: id,
      details: [],
      state: 'pending',
    }));
    adapter.purge = async (_record, resource) => {
      events.push(resource.id);
      if (resource.id === 'second') throw new Error('connection lost');
      return { status: 'done' };
    };
    await assert.rejects(run(true), /connection lost/u);
    assert.deepEqual(
      (await store.read())!.resources.map(({ state }) => state),
      ['done', 'attempted'],
    );
    await assert.rejects(run(false), /notification-reset-mode-conflict/u);
    adapter.purge = async (_record, resource) => {
      assert.equal(resource.state, 'attempted');
      events.push(resource.id);
      return { status: 'done' };
    };
    assert.equal((await run(true)).status, 'complete');
    assert.equal(events.filter((event) => event === 'first').length, 1);
    assert.equal(events.filter((event) => event === 'clear').length, 1);
  });

  it('should retain a timed out checkout and finish recovery without archiving the chat again', async () => {
    snapshot.resources = [
      {
        id: 'chat',
        kind: 'chat',
        description: 'chat',
        identity: 'owner',
        details: [],
        state: 'pending',
      },
      {
        id: 'checkout',
        kind: 'worktree',
        description: '/managed',
        identity: 'owner',
        details: [],
        state: 'pending',
      },
    ];
    let removed = false;
    let elapsed = 0;
    adapter.purge = async (_record, resource) => {
      events.push(resource.id);
      if (resource.kind === 'chat') return { status: 'done' };
      const done = await waitForCodexWorktreeRemoval('/managed', {
        stat: async () => {
          if (removed) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
        now: () => elapsed,
        sleep: async (ms) => {
          assert.equal((await store.read())?.phase, 'purge');
          assert.ok(!events.includes('restore'));
          elapsed += ms;
        },
      });
      return done ? { status: 'done' } : { status: 'incomplete' };
    };
    assert.equal((await run(true)).status, 'incomplete');
    const retained = (await store.read())!;
    assert.equal(retained.phase, 'purge');
    assert.deepEqual(
      retained.resources.map(({ state }) => state),
      ['done', 'attempted'],
    );
    removed = true;
    assert.equal((await run(true)).status, 'complete');
    assert.equal(events.filter((event) => event === 'chat').length, 1);
    assert.equal(events.filter((event) => event === 'clear').length, 1);
    assert.equal(await store.read(), undefined);
  });

  it('should not reissue an unverified native mutation', async () => {
    adapter.pause = async () => ({
      status: 'native-action',
      request: { tool: 'automation_update', arguments: { id: 'job', status: 'PAUSED' } },
    });
    assert.equal((await run()).status, 'native-action');
    const repeated = await run();
    assert.equal(repeated.status, 'incomplete');
    assert.equal('request' in repeated, false);
    adapter.pause = async () => ({ status: 'done' });
    assert.equal((await run()).status, 'complete');
  });

  it('should start fresh checks without losing inventory, completed effects or the prior schedule', async () => {
    snapshot.resources = ['first', 'second'].map((id) => ({
      id,
      kind: 'chat',
      description: id,
      identity: id,
      details: [],
      state: 'pending',
    }));
    adapter.purge = async (_record, resource) => {
      events.push(resource.id);
      if (resource.id === 'second') throw new Error('interrupted');
      return { status: 'done' };
    };
    await assert.rejects(run(true), /interrupted/u);
    const original = (await store.read())!;
    const preview = await previewNotificationReset(store, adapter, true, true);
    assert.equal((await store.read())!.id, original.id);
    assert.equal(preview.restarting, true);
    adapter.snapshot = async () => {
      throw new Error('cleared live tracking is not the cleanup inventory');
    };
    adapter.purge = async (record, resource) => {
      assert.notEqual(record.id, original.id);
      assert.equal(record.fresh, true);
      assert.equal(record.inventory, original.inventory);
      assert.equal(record.automation, original.automation);
      assert.equal(resource.id, 'second');
      assert.equal(resource.state, 'attempted');
      return { status: 'done' };
    };
    assert.equal((await resetNotifications({ store, adapter, preview })).status, 'complete');
    assert.equal(events.filter((event) => event === 'first').length, 1);
    assert.equal(events.filter((event) => event === 'clear').length, 2);
  });

  it('should retain uncertain native actions even when explicitly starting fresh', async () => {
    adapter.pause = async () => ({
      status: 'native-action',
      request: { tool: 'automation_update', arguments: { id: 'job', status: 'PAUSED' } },
    });
    await run();
    const result = await resetNotifications({
      store,
      adapter,
      preview: await previewNotificationReset(store, adapter, false, true),
    });
    assert.equal(result.status, 'incomplete');
    assert.equal('request' in result, false);
  });

  it('should report preserved cleanup targets without deleting them or claiming they were purged', async () => {
    snapshot.resources = [
      {
        id: 'checkout',
        kind: 'worktree',
        description: '/managed',
        identity: 'owner',
        details: [],
        state: 'pending',
      },
    ];
    adapter.idle = async (record) => {
      record.resources[0]!.state = 'preserved';
      record.warnings = ['notification-reset-unresolved-session-preserved: /managed'];
      return { status: 'done' };
    };
    adapter.purge = async () => {
      throw new Error('preserved checkout must not be removed');
    };
    const result = await run(true);
    assert.equal(result.status, 'complete');
    assert.equal(result.resources[0]!.state, 'preserved');
    assert.deepEqual(result.warnings, [
      'notification-reset-unresolved-session-preserved: /managed',
    ]);
  });

  it('should retain a failed coordinator replacement and restore only after verified retargeting', async () => {
    adapter.coordinator = async () => {
      throw new Error('replacement failed');
    };
    await assert.rejects(run(), /replacement failed/u);
    assert.equal((await store.read())?.phase, 'coordinator');
    assert.ok(!events.includes('restore'));
    adapter.coordinator = async () => ({ status: 'done', automation: '{"target":"fresh"}' });
    adapter.restore = async (record) => {
      assert.equal(record.automation, '{"target":"fresh"}');
      return { status: 'done' };
    };
    assert.equal((await run()).status, 'complete');
    assert.equal(events.filter((value) => value === 'clear').length, 1);
    assert.equal(events.filter((value) => value === 'baseline').length, 1);
  });

  it('should discard remote effects from an old purge recovery without calling the provider', async () => {
    snapshot.resources = [
      {
        id: 'pr',
        kind: 'pull-request',
        description: 'old PR',
        identity: 'old',
        details: [],
        state: 'attempted',
      },
    ];
    adapter.purge = async () => {
      throw new Error('remote mutation forbidden');
    };
    assert.equal((await run(true)).status, 'complete');
  });

  it('should preserve a finished baseline across a failed restore', async () => {
    adapter.restore = async () => {
      throw new Error('restore failed');
    };
    await assert.rejects(run(), /restore failed/u);
    assert.equal((await store.read())!.phase, 'restore');
    adapter.restore = async () => ({ status: 'done' });
    await run();
    assert.equal(events.filter((event) => event === 'baseline').length, 1);
  });

  it('should recheck inactivity when recovering after the drain checkpoint', async () => {
    adapter.clear = async () => {
      events.push('clear');
      throw new Error('interrupted');
    };
    await assert.rejects(run(), /interrupted/u);
    adapter.idle = async () => ({ status: 'waiting' });
    adapter.clear = async () => {
      events.push('clear');
    };
    assert.equal((await run()).status, 'waiting');
    assert.equal(events.filter((event) => event === 'clear').length, 1);
    adapter.idle = async () => ({ status: 'done' });
    assert.equal((await run()).status, 'complete');
  });

  it('should reject old transactions after the reset journal is removed', async () => {
    const dispatch = new CodexDispatchStore(root, scope);
    let release!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = dispatch.transaction(async (state, save) => {
      ready();
      await blocked;
      state.intakeHealth = 'stale';
      await save();
    });
    await started;
    adapter.clear = async (record) => {
      await dispatch.reset(record.id);
    };
    await run();
    release();
    await assert.rejects(stale, /notification-reset-stale-operation/u);
    assert.equal((await dispatch.read()).intakeHealth, undefined);
  });

  it('should block intake writes while retaining read-only inspection', async () => {
    const intake = new IntakeRecordStore({ root, path: join(root, 'intake.json'), scope });
    await intake.exclusive(async (_state, save) =>
      save({
        version: 1,
        scope,
        workspaceDir: '/workspace',
        agentId: 'tester',
        account: { login: 'tester', nodeId: 'user' },
        policyDigest: 'policy',
        baselineAt: 1,
        records: [],
        checkpoint: 2,
        discovery: { page: 1, pending: [], nextPage: 2 },
      }),
    );
    adapter.idle = async () => ({ status: 'waiting' });
    await run();
    assert.equal((await intake.read())!.checkpoint, 2);
    await assert.rejects(intake.reset(10), /notification-reset-in-progress/u);
    adapter.idle = async () => ({ status: 'done' });
    adapter.baseline = async (record) => {
      await intake.reset(record.baselineAt!);
    };
    await run();
    const after = (await intake.read())!;
    assert.equal(after.baselineAt, 100);
    assert.equal(after.checkpoint, undefined);
    assert.equal(after.discovery, undefined);
  });
});
