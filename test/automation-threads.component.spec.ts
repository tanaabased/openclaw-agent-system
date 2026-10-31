import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';

import { AutomationError, nativeObject } from '../agent/automation-gateway.ts';
import AutomationThreads, {
  automationThreadSelection,
  AutomationThreadSettingsError,
  type AutomationThread,
  type AutomationThreadSettings,
} from '../agent/automation-threads.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';
import automationThreadGateway from '../agent/automation-thread-gateway.ts';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import { sessionDispatchRequest } from '../credentials/session-dispatch-client.ts';

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
    const native = new Map<string, AutomationThread>();
    let creates = 0;
    const adapter = {
      async lookup(id: string) {
        return native.get(id) ?? null;
      },
      async create(
        record: { nativeId?: string },
        saveId: (id: string) => Promise<void>,
        fresh: boolean,
        settings?: AutomationThreadSettings,
      ) {
        if (!fresh && !record.nativeId) throw new Error('ambiguous');
        const id = record.nativeId ?? `native-${++creates}`;
        await saveId(id);
        native.set(id, { id, ...settings });
        return id;
      },
      async updateSettings(current: AutomationThread, settings: AutomationThreadSettings) {
        native.set(current.id, { ...current, ...settings });
      },
      async setGroup(id: string, group: string) {
        native.set(id, { ...native.get(id), id, group });
      },
      async rename(id: string, name: string) {
        native.set(id, { ...native.get(id), id, name });
      },
    };
    const store = new AutomationThreads({ root, scope: runtime, runtime }, adapter);
    return { store, adapter, native, creates: () => creates };
  }
  it('should share and reuse one chat for commands and prompts with the same explicit id', async () => {
    const f = fixture('openclaw');
    const declarations = jobs({ id: 'reports', name: 'UPDATES' }, ['first', 'second', 'prompt']);
    for (const job of declarations.slice(0, 2))
      job.payload = { kind: 'command', run: { kind: 'exec', executable: 'true', args: [] } };
    for (const job of declarations) job.group = 'REPORTS';
    const first = await f.store.resolve(declarations, true);
    assert.equal(new Set([...first.values()].map(({ id }) => id)).size, 1);
    assert.equal(f.creates(), 1);
    const reused = await f.store.resolve(declarations, true);
    assert.deepEqual(
      [...reused.values()].map(({ id }) => id),
      [...first.values()].map(({ id }) => id),
    );
    assert.ok([...reused.values()].every(({ outcome }) => outcome === 'reused'));
    assert.equal(f.creates(), 1);
    declarations[1]!.group = 'OTHER';
    await assert.rejects(f.store.resolve(declarations, true));
    assert.equal(f.creates(), 1);
    assert.equal([...f.native.values()][0]!.group, 'REPORTS');
    assert.equal(automationThreadSelection(declarations[0]!, 'codex'), undefined);
  });

  for (const runtime of ['codex'] as const)
    it(`should retain affected identity and full settings without inspection writes in ${runtime}`, async () => {
      const f = fixture(runtime);
      const declarations = jobs('Activity', ['first', 'affected']);
      for (const job of declarations)
        job.overrides[runtime] = { model: 'selected', effort: 'high' };
      const bindings = await f.store.resolve(declarations, true);
      const id = bindings.get('affected')!.id;
      const before = await readFile(f.store.path, 'utf8');
      assert.deepEqual((await f.store.resolve(declarations)).get('affected')!.settings, {
        requested: { model: 'selected', effort: 'high' },
        observed: { model: 'selected', effort: 'high' },
      });
      for (const dimension of ['model', 'effort'] as const) {
        f.native.get(id)![dimension] = 'different';
        await assert.rejects(f.store.resolve(declarations), (error: unknown) => {
          assert.ok(error instanceof AutomationThreadSettingsError);
          assert.equal(error.automationId, 'affected');
          assert.equal(error.code, 'automation-thread-model-drift');
          assert.deepEqual(error.settings, {
            requested: { model: 'selected', effort: 'high' },
            observed: { model: 'selected', effort: 'high', [dimension]: 'different' },
          });
          return true;
        });
        assert.equal(f.native.get(id)![dimension], 'different');
        f.native.get(id)![dimension] = dimension === 'model' ? 'selected' : 'high';
      }
      f.native.get(id)!.name = 'Renamed';
      await assert.rejects(f.store.resolve(declarations), (error: unknown) => {
        assert.ok(error instanceof AutomationError);
        assert.equal(error.automationId, 'affected');
        assert.equal(error.code, 'automation-thread-name-drift');
        return true;
      });
      f.store.adapter.validateSettings = async (_settings, current) => {
        if (current?.id === id) throw new AutomationError('automation-model-unsupported');
      };
      await assert.rejects(f.store.resolve(declarations), (error: unknown) => {
        assert.ok(error instanceof AutomationThreadSettingsError);
        assert.equal(error.automationId, 'affected');
        assert.equal(error.code, 'automation-model-unsupported');
        assert.equal(error.settings.requested.model, 'selected');
        assert.equal(error.settings.observed.effort, 'high');
        return true;
      });
      delete f.store.adapter.validateSettings;
      f.adapter.lookup = async (target) => {
        if (target === id) throw new Error('private provider error');
        return f.native.get(target) ?? null;
      };
      await assert.rejects(f.store.resolve(declarations), (error: unknown) => {
        assert.ok(error instanceof AutomationError);
        assert.equal(error.automationId, 'affected');
        assert.equal(error.code, 'automation-thread-inspection-failed');
        assert.equal(error.message.includes('private provider'), false);
        return true;
      });
      assert.equal(await readFile(f.store.path, 'utf8'), before);
      assert.equal(f.creates(), 2);
    });
  for (const runtime of ['openclaw', 'codex'] as const)
    it(`should preserve a failed create receipt without retrying and attribute only openclaw diagnostics in ${runtime}`, async () => {
      const f = fixture(runtime);
      let calls = 0;
      const diagnostic = {
        method: 'sessions.create' as const,
        category: 'rejected' as const,
        gatewayCode: 'INVALID_REQUEST' as const,
        reason: 'unclassified' as const,
        closeCode: null,
        requestDispatched: null,
      };
      f.adapter.create = async (_record, saveId) => {
        calls++;
        await saveId('retained-native-id');
        throw new AutomationError('automation-gateway-rejected', diagnostic);
      };
      await assert.rejects(f.store.resolve(jobs('Intake', ['intake']), true), (error: unknown) => {
        assert.ok(error instanceof AutomationError);
        assert.equal(error.code, 'automation-gateway-rejected');
        assert.deepEqual(
          error.diagnostic,
          runtime === 'openclaw' ? { ...diagnostic, automationId: 'intake' } : diagnostic,
        );
        return true;
      });
      assert.equal(calls, 1);
      const ledger = await f.store.read();
      assert.equal(ledger.records[0]?.nativeId, 'retained-native-id');
      assert.equal(ledger.records[0]?.phase, 'materializing');
    });
  it('should reconcile a declared group, detect drift read-only and preserve native identity', async () => {
    const f = fixture('openclaw');
    const declarations = jobs('Intake', ['intake']);
    declarations[0]!.group = ' operations ';
    const id = (await f.store.resolve(declarations, true)).get('intake')!.id;
    assert.equal(f.native.get(id)!.group, 'OPERATIONS');
    f.native.get(id)!.group = 'Other';
    await assert.rejects(f.store.resolve(declarations), rejects('automation-thread-group-drift'));
    assert.equal(f.native.get(id)!.group, 'Other');
    assert.equal((await f.store.resolve(declarations, true)).get('intake')!.id, id);
    assert.equal(f.native.get(id)!.group, 'OPERATIONS');
    assert.equal(f.creates(), 1);
  });
  it('should retain the chat when placement is unsupported or native readback has not changed', async () => {
    const f = fixture('openclaw');
    const declarations = jobs('Activity', ['activity']);
    const id = (await f.store.resolve(declarations, true)).get('activity')!.id;
    declarations[0]!.group = 'operations';
    const setGroup = f.store.adapter.setGroup;
    delete f.store.adapter.setGroup;
    await assert.rejects(
      f.store.resolve(declarations, true),
      rejects('automation-thread-group-unsupported'),
    );
    f.store.adapter.setGroup = async () => {};
    await assert.rejects(
      f.store.resolve(declarations, true),
      rejects('automation-thread-readback-diverged'),
    );
    assert.equal(f.native.get(id)!.group, 'AGENT SYSTEM');
    f.store.adapter.setGroup = setGroup;
    assert.equal((await f.store.resolve(declarations, true)).get('activity')!.id, id);
    assert.equal(f.creates(), 1);
  });
  for (const runtime of ['openclaw', 'codex'] as const)
    it(`should move the same ${runtime} chat and reject conflicting native aliases before mutation`, async () => {
      const f = fixture(runtime);
      const declarations = jobs('Activity', ['activity']);
      const id = (await f.store.resolve(declarations, true)).get('activity')!.id;
      assert.equal(f.native.get(id)!.group, 'AGENT SYSTEM');
      declarations[0]!.group = ' operations ';
      await assert.rejects(f.store.resolve(declarations), rejects('automation-thread-group-drift'));
      assert.equal((await f.store.resolve(declarations, true)).get('activity')!.id, id);
      assert.equal(f.native.get(id)!.group, 'OPERATIONS');
      const alias = structuredClone(declarations[0]!);
      alias.id = 'alias';
      alias.enabled = false;
      alias.group = 'Other';
      alias.overrides[runtime] = { target: { thread: id } };
      await assert.rejects(
        f.store.resolve([...declarations, alias], true),
        rejects('automation-thread-group-conflict'),
      );
      assert.equal(f.native.get(id)!.group, 'OPERATIONS');
      assert.equal(f.creates(), 1);
    });

  it('should create with selected settings and detect drift without changing or replacing the chat', async () => {
    const f = fixture('codex');
    const declarations = jobs('Intake', ['intake']);
    declarations[0]!.overrides.codex = { model: 'gpt-6-luna', effort: 'medium' };
    const id = (await f.store.resolve(declarations, true)).get('intake')!.id;
    assert.deepEqual(f.native.get(id), {
      id,
      name: 'Intake',
      group: 'AGENT SYSTEM',
      model: 'gpt-6-luna',
      effort: 'medium',
    });
    assert.equal((await f.store.resolve(declarations, true)).get('intake')!.id, id);
    declarations[0]!.overrides.codex.effort = 'high';
    await assert.rejects(f.store.resolve(declarations), rejects('automation-thread-model-drift'));
    assert.equal(f.native.get(id)?.effort, 'medium');
    assert.equal((await f.store.resolve(declarations, true)).get('intake')!.id, id);
    assert.equal(f.native.get(id)?.effort, 'high');
    assert.equal(f.creates(), 1);
  });
  for (const runtime of ['codex'] as const) {
    for (const pending of ['busy', 'unsupported'] as const)
      it(`should recover ${pending} and lost acknowledgements without replacing the ${runtime} chat`, async () => {
        const f = fixture(runtime);
        const declarations = jobs('Activity', ['activity']);
        declarations[0]!.overrides[runtime] = { model: 'selected', effort: 'medium' };
        const id = (await f.store.resolve(declarations, true)).get('activity')!.id;
        declarations[0]!.overrides[runtime]!.effort = 'high';
        let writes = 0;
        f.adapter.updateSettings = async () => {
          throw new AutomationError(`automation-thread-settings-${pending}`);
        };
        await assert.rejects(
          f.store.resolve(declarations, true),
          rejects(`automation-thread-settings-${pending}`),
        );
        const saved = await readFile(f.store.path, 'utf8');
        await assert.rejects(
          f.store.resolve(declarations),
          rejects(`automation-thread-settings-${pending}`),
        );
        assert.equal(await readFile(f.store.path, 'utf8'), saved);
        f.adapter.updateSettings = async (current, settings) => {
          writes++;
          f.native.set(current.id, { ...current, ...settings });
          throw new Error('lost acknowledgement');
        };
        assert.equal((await f.store.resolve(declarations, true)).get('activity')!.id, id);
        await f.store.resolve(declarations, true);
        assert.equal(writes, 1);
        assert.equal(f.creates(), 1);
      });
    for (const state of ['denied', 'uncertain'] as const)
      it(`should retain ${state} ${runtime} updates and never replay them`, async () => {
        const f = fixture(runtime);
        const declarations = jobs('Activity', ['activity']);
        declarations[0]!.overrides[runtime] = { effort: 'medium' };
        const id = (await f.store.resolve(declarations, true)).get('activity')!.id;
        declarations[0]!.overrides[runtime]!.effort = 'high';
        let writes = 0;
        f.adapter.updateSettings = async () => {
          writes++;
          if (state === 'denied') throw new AutomationError('automation-thread-settings-denied');
          throw new Error('connection lost');
        };
        await assert.rejects(
          f.store.resolve(declarations, true),
          rejects(`automation-thread-settings-${state}`),
        );
        const before = await readFile(f.store.path, 'utf8');
        await assert.rejects(
          f.store.resolve(declarations),
          rejects(`automation-thread-settings-${state}`),
        );
        assert.equal(await readFile(f.store.path, 'utf8'), before);
        await assert.rejects(
          f.store.resolve(declarations, true),
          rejects(`automation-thread-settings-${state}`),
        );
        assert.equal(writes, 1);
        const changed = structuredClone(declarations);
        changed[0]!.overrides[runtime]!.effort = 'low';
        await assert.rejects(f.store.resolve(changed), (error: unknown) => {
          assert.equal(
            (error as { settings: { requested: { effort: string } } }).settings.requested.effort,
            'high',
          );
          return rejects(`automation-thread-settings-${state}`)(error);
        });
        if (state === 'uncertain') {
          changed[0]!.overrides[runtime]!.effort = 'medium';
          await assert.rejects(
            f.store.resolve(changed, true),
            rejects('automation-thread-settings-uncertain'),
          );
          assert.equal(await readFile(f.store.path, 'utf8'), before);
          assert.equal(writes, 1);
        }
        f.native.get(id)!.effort = 'high';
        await f.store.resolve(declarations, true);
        assert.equal(writes, 1);
        assert.equal(f.creates(), 1);
      });
    it(`should settle a withdrawn denied update without changing the ${runtime} chat`, async () => {
      const f = fixture(runtime);
      const declarations = jobs('Activity', ['activity']);
      declarations[0]!.overrides[runtime] = { model: 'original', effort: 'medium' };
      const id = (await f.store.resolve(declarations, true)).get('activity')!.id;
      f.native.get(id)!.incarnation = 'original-session';
      declarations[0]!.overrides[runtime] = { model: 'requested', effort: 'high' };
      let writes = 0;
      f.adapter.updateSettings = async () => {
        writes++;
        throw new AutomationError('automation-thread-settings-denied');
      };
      await assert.rejects(
        f.store.resolve(declarations, true),
        rejects('automation-thread-settings-denied'),
      );
      const saved = await readFile(f.store.path, 'utf8');
      declarations[0]!.overrides[runtime] = { model: 'original', effort: 'medium' };
      await assert.rejects(
        f.store.resolve(declarations),
        rejects('automation-thread-sync-required'),
      );
      assert.equal(await readFile(f.store.path, 'utf8'), saved);
      f.native.get(id)!.incarnation = 'replacement-session';
      await assert.rejects(
        f.store.resolve(declarations, true),
        rejects('automation-thread-settings-conflict'),
      );
      assert.equal(await readFile(f.store.path, 'utf8'), saved);
      f.native.get(id)!.incarnation = 'original-session';
      const before = structuredClone(f.native.get(id));
      assert.equal((await f.store.resolve(declarations, true)).get('activity')!.id, id);
      assert.equal((await f.store.resolve(declarations)).get('activity')!.id, id);
      assert.deepEqual(f.native.get(id), before);
      assert.equal(writes, 1);
      assert.equal(f.creates(), 1);
      assert.equal(
        JSON.parse(await readFile(f.store.path, 'utf8')).records[0].settingsUpdate,
        undefined,
      );
    });
  }
  it('should reject incompatible settings for a shared chat before creating it', async () => {
    const f = fixture('openclaw');
    const declarations = jobs({ id: 'shared' });
    declarations[0]!.overrides.openclaw = { effort: 'medium' };
    declarations[1]!.overrides.openclaw = { effort: 'high' };
    await assert.rejects(
      f.store.resolve(declarations, true),
      rejects('automation-thread-settings-conflict'),
    );
    assert.equal(f.creates(), 0);
  });
  it('should register openclaw chats without model validation or settings observations', async () => {
    const f = fixture('openclaw');
    const declarations = jobs('Reports', ['report']);
    declarations[0]!.overrides.openclaw = { model: 'unavailable', effort: 'high' };
    let writes = 0;
    f.store.adapter.validateSettings = async () => {
      throw new Error('live model validation');
    };
    f.adapter.updateSettings = async () => {
      writes++;
    };
    const id = (await f.store.resolve(declarations, true)).get('report')!.id;
    assert.equal(f.native.get(id)!.model, undefined);
    assert.equal((await f.store.resolve(declarations)).get('report')!.settings, undefined);
    f.native.get(id)!.model = 'different';
    await f.store.resolve(declarations, true);
    assert.equal(writes, 0);
    assert.equal(f.creates(), 1);
  });
  it('should select through the native adapter after registration and reconcile a committed lost acknowledgement', async () => {
    const workspaceDir = await realpath(root);
    const native = new Map<string, Record<string, unknown>>();
    let available = false;
    let selections = 0;
    const request = sessionDispatchRequest(async (method, params) => {
      const key = String(params.key);
      if (method === 'sessions.resolve')
        return native.has(key) ? { ok: true, key, agentId: 'a' } : { ok: false };
      if (method === 'sessions.list') return { sessions: [...native.values()] };
      if (method === 'sessions.create') {
        assert.equal(params.model, undefined);
        assert.equal(params.thinkingLevel, undefined);
        native.set(key, {
          key,
          sessionId: 'same-session',
          lifecycleRevision: 'revision',
          workspaceDir,
        });
        return { ok: true };
      }
      assert.equal(method, 'sessions.patch');
      const row = native.get(key)!;
      if (params.model) {
        selections++;
        assert.equal(params.expectedSessionId, 'same-session');
        assert.equal(params.expectedLifecycleRevision, 'revision');
        if (!available)
          throw new GatewayClientRequestError({
            code: 'INVALID_REQUEST',
            message:
              'A runtime is not available for test/requested. Refresh the model catalog and choose again.',
          });
        row.model = params.model;
        row.thinkingLevel = params.thinkingLevel;
        throw new Error('lost acknowledgement after commit');
      }
      if (params.autoLabel) row.displayName = params.autoLabel;
      if (params.category) row.category = params.category;
      return { ok: true };
    }, {});
    const adapter = automationThreadGateway(
      async (method, params) => {
        const result = await request(method, params);
        assert.ok(nativeObject(result));
        return result;
      },
      { agentId: 'a', workspaceDir, scope: 'native' },
    );
    const store = new AutomationThreads({ root, scope: 'native', runtime: 'openclaw' }, adapter);
    const declarations = jobs('Reports', ['report']);
    declarations[0]!.overrides.openclaw = { model: 'test/requested', effort: 'high' };
    const id = (await store.resolve(declarations, true)).get('report')!.id;
    await assert.rejects(
      store.selectSettings(declarations),
      rejects('automation-model-unavailable'),
    );
    assert.equal((await store.read()).records[0]!.settingsUpdate, undefined);
    assert.equal((await store.resolve(declarations)).get('report')!.settings, undefined);
    available = true;
    await store.selectSettings(declarations);
    await store.selectSettings(declarations);
    assert.equal(native.get(id)!.model, 'test/requested');
    assert.equal(native.get(id)!.thinkingLevel, 'high');
    assert.equal(selections, 2);
    assert.equal(native.size, 1);
  });
  for (const phase of ['denied', 'uncertain', 'busy', 'unsupported', 'unavailable'] as const)
    it(`should retain openclaw execution selection recovery for ${phase} without install drift`, async () => {
      const f = fixture('openclaw');
      const declarations = jobs('Reports', ['report']);
      declarations[0]!.overrides.openclaw = { model: 'requested', effort: 'high' };
      const id = (await f.store.resolve(declarations, true)).get('report')!.id;
      f.native.get(id)!.incarnation = 'session';
      let writes = 0;
      const code =
        phase === 'unavailable'
          ? 'automation-model-unavailable'
          : `automation-thread-settings-${phase}`;
      f.adapter.updateSettings = async () => {
        writes++;
        if (phase === 'uncertain') throw new Error('lost response');
        throw new AutomationError(code);
      };
      await assert.rejects(f.store.selectSettings(declarations), rejects(code));
      const saved = await readFile(f.store.path, 'utf8');
      assert.equal((await f.store.resolve(declarations)).get('report')!.settings, undefined);
      await f.store.resolve(declarations, true);
      assert.equal(await readFile(f.store.path, 'utf8'), saved);
      if (phase === 'denied' || phase === 'uncertain') {
        await assert.rejects(f.store.selectSettings(declarations), rejects(code));
        assert.equal(writes, 1);
      }
      f.adapter.updateSettings = async (current, settings) => {
        writes++;
        f.native.set(current.id, { ...current, ...settings });
        throw new Error('lost acknowledgement after commit');
      };
      if (phase === 'denied' || phase === 'uncertain') {
        f.native.get(id)!.model = 'requested';
        f.native.get(id)!.effort = 'high';
      }
      await f.store.selectSettings(declarations);
      await f.store.selectSettings(declarations);
      assert.equal(writes, phase === 'denied' || phase === 'uncertain' ? 1 : 2);
      assert.equal(f.creates(), 1);
    });
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
  it('should reconcile native aliases once and reject differing model settings before writes', async () => {
    const f = fixture('openclaw');
    const declarations = jobs({ id: 'canonical' }, ['one']);
    declarations.push(...jobs({ id: 'alias' }, ['two']));
    for (const job of declarations)
      job.overrides.openclaw = { model: 'openai/selected', effort: 'high' };
    f.native.set('canonical', {
      id: 'canonical',
      group: 'AGENT SYSTEM',
      model: 'openai/selected',
      effort: 'medium',
    });
    f.adapter.lookup = async () => structuredClone(f.native.get('canonical')!);
    let updates = 0;
    f.adapter.updateSettings = async (current, settings) => {
      assert.equal(current.effort, f.native.get(current.id)!.effort);
      updates++;
      f.native.set(current.id, { ...current, ...settings });
    };
    declarations[1]!.overrides.openclaw!.effort = 'low';
    await assert.rejects(
      f.store.resolve(declarations, true),
      rejects('automation-thread-settings-conflict'),
    );
    assert.equal(updates, 0);
    declarations[1]!.overrides.openclaw!.effort = 'high';
    await f.store.resolve(declarations, true);
    const resolved = await f.store.selectSettings(declarations);
    assert.equal(resolved.get('one')!.id, resolved.get('two')!.id);
    assert.equal(updates, 1);
    await f.store.selectSettings(declarations);
    assert.equal(updates, 1);
  });

  it('should fence uncertain settings to the same incarnation before any other mutation', async () => {
    const f = fixture('openclaw');
    const declarations = jobs({ name: 'Activity' }, ['github-issue-assignment']);
    declarations[0]!.overrides.openclaw = { model: 'openai/selected', effort: 'medium' };
    const id = (await f.store.resolve(declarations, true)).get('github-issue-assignment')!.id;
    await f.store.selectSettings(declarations);
    f.native.get(id)!.incarnation = 'original';
    declarations[0]!.overrides.openclaw!.effort = 'high';
    f.adapter.updateSettings = async () => {
      throw new Error('lost response');
    };
    await assert.rejects(
      f.store.selectSettings(declarations),
      rejects('automation-thread-settings-uncertain'),
    );
    let writes = 0;
    f.adapter.rename = async () => {
      writes++;
    };
    f.adapter.setGroup = async () => {
      writes++;
    };
    f.adapter.updateSettings = async () => {
      writes++;
    };
    for (const replacement of [
      { ...f.native.get(id)!, incarnation: 'replacement', name: 'Other', group: 'OTHER' },
      { ...f.native.get(id)!, archived: true },
      undefined,
    ]) {
      if (replacement) f.native.set(id, replacement);
      else f.native.delete(id);
      await assert.rejects(
        f.store.selectSettings(declarations),
        rejects('automation-thread-settings-conflict'),
      );
    }
    assert.equal(writes, 0);
    assert.equal(f.creates(), 1);
  });

  it('should reject unavailable new selections before journaling or creating any chat', async () => {
    const f = fixture('codex');
    const declarations = jobs('Activity');
    for (const job of declarations) job.overrides.codex = { model: 'selected' };
    declarations[1]!.overrides.codex!.model = 'unavailable';
    f.store.adapter.validateSettings = async (settings) => {
      if (settings.model === 'unavailable')
        throw new AutomationError('automation-model-unsupported');
    };
    await assert.rejects(
      f.store.resolve(declarations, true),
      rejects('automation-model-unsupported'),
    );
    assert.equal(f.creates(), 0);
    await assert.rejects(readFile(f.store.path), { code: 'ENOENT' });
    declarations[1]!.overrides.codex!.model = 'selected';
    assert.equal((await f.store.resolve(declarations, true)).size, 2);
    assert.equal(f.creates(), 2);
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
  for (const runtime of ['openclaw', 'codex'] as const) {
    for (const unavailable of ['archived', 'missing'] as const) {
      it(`should report ${unavailable} ${runtime} intake read-only and replace it once on install`, async () => {
        const f = fixture(runtime);
        const declarations = jobs('Issue assignments', ['github-issue-assignment']);
        const old = (await f.store.resolve(declarations, true)).get('github-issue-assignment')!.id;
        if (unavailable === 'archived') f.native.get(old)!.archived = true;
        else f.native.delete(old);
        const before = await readFile(f.store.path, 'utf8');
        await assert.rejects(
          f.store.resolve(declarations),
          rejects('automation-thread-replacement-required'),
        );
        assert.equal(await readFile(f.store.path, 'utf8'), before);
        const current = (await f.store.resolve(declarations, true)).get(
          'github-issue-assignment',
        )!.id;
        assert.notEqual(current, old);
        assert.equal(
          (await f.store.resolve(declarations, true)).get('github-issue-assignment')!.id,
          current,
        );
        assert.equal(f.creates(), 2);
        if (unavailable === 'archived') assert.equal(f.native.get(old)!.archived, true);
      });
    }
  }

  it('should never replace an archived unrelated job or explicit native target', async () => {
    const f = fixture('codex');
    const declarations = jobs('Other', ['other']);
    const id = (await f.store.resolve(declarations, true)).get('other')!.id;
    f.native.get(id)!.archived = true;
    await assert.rejects(
      f.store.resolve(declarations, true),
      rejects('automation-thread-unavailable'),
    );
    declarations[0]!.id = 'github-issue-assignment';
    declarations[0]!.overrides.codex = { target: { thread: id } };
    await assert.rejects(
      f.store.resolve(declarations, true),
      rejects('automation-thread-unavailable'),
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
