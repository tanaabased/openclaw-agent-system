import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import dispatchCapacity from '../agent/dispatch-capacity.ts';
import OpenClawDispatchStore, {
  type OpenClawDispatchRecord,
} from '../agent/openclaw-dispatch-state.ts';

function pending(id = 'a'.repeat(64)) {
  return {
    id,
    intakeId: id,
    issueKey: id,
    sourceThreadId: 'agent:receiver:automation:intake',
    phase: 'routing',
    createdAt: 1,
    manifestDigest: 'manifest',
  } satisfies OpenClawDispatchRecord;
}
function prepared(): OpenClawDispatchRecord {
  return {
    ...pending(),
    phase: 'creating',
    context: '{}',
    routing: '{}',
    routingNote: 'selected',
    worktree: '/worktree',
    request: {
      runtime: 'subagent',
      visible: true,
      cleanup: 'keep',
      cwd: '/worktree',
      label: '#1: ASSESS',
      task: 'Assess only',
      model: 'provider/model',
    },
  };
}

describe('agent/shared dispatch state', () => {
  let root: string;
  const scope = 'b'.repeat(64);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shared-dispatch-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should share journal semantics without sharing mutable runtime files', async () => {
    const codex = new CodexDispatchStore(root, scope);
    const openclaw = new OpenClawDispatchStore(root, scope);
    for (const store of [codex, openclaw]) {
      await store.exclusive(async (state, save) => {
        state.records.push(pending());
        await save();
      });
    }
    assert.notEqual(codex.path, openclaw.path);
    assert.deepEqual(await codex.read(), await openclaw.read());
    assert.equal((await new OpenClawDispatchStore(root, scope).read()).records.length, 1);
    assert.equal((await new OpenClawDispatchStore(root, 'c'.repeat(64)).read()).records.length, 0);
  });

  it('should retain an uncertain creation and its occupied slot across restart', async () => {
    const store = new OpenClawDispatchStore(root, scope);
    await store.exclusive(async (state, save) => {
      state.records.push(prepared());
      await save();
    });
    const restarted = new OpenClawDispatchStore(root, scope);
    const state = await restarted.read();
    assert.equal(state.records[0]!.phase, 'creating');
    assert.deepEqual(dispatchCapacity(state.records, 1), { occupied: 1, available: 0 });
    state.records[0]!.phase = 'blocked';
    assert.equal(dispatchCapacity(state.records, 1).available, 0);
    state.records[0]!.phase = 'complete';
    assert.equal(dispatchCapacity(state.records, 1).available, 1);
    assert.throws(() => dispatchCapacity([], 0), /dispatch-capacity-invalid/);
  });

  it('should reject duplicate identities and invalid transitions before replacing valid evidence', async () => {
    const store = new OpenClawDispatchStore(root, scope);
    await store.exclusive(async (state, save) => {
      state.records.push(pending());
      await save();
    });
    const before = await readFile(store.path, 'utf8');
    for (const mutate of [
      (records: OpenClawDispatchRecord[]) => {
        records.push(pending());
      },
      (records: OpenClawDispatchRecord[]) => {
        records.push({ ...pending('d'.repeat(64)), issueKey: records[0]!.issueKey });
      },
      (records: OpenClawDispatchRecord[]) => {
        records[0]!.phase = 'creating';
      },
      (records: OpenClawDispatchRecord[]) => {
        records[0] = { ...prepared(), worktree: '/different' };
      },
      (records: OpenClawDispatchRecord[]) => {
        records[0] = { ...prepared(), phase: 'assessing' };
      },
    ]) {
      await assert.rejects(
        store.exclusive(async (state, save) => {
          mutate(state.records);
          await save();
        }),
        /dispatch-state-invalid/,
      );
      assert.equal(await readFile(store.path, 'utf8'), before);
    }
  });

  it('should reject foreign schemas and scope rather than reset their evidence', async () => {
    const store = new OpenClawDispatchStore(root, scope);
    for (const value of [
      { version: 1, scope: 'c'.repeat(64), records: [] },
      { version: 1, scope, records: [{ ...pending(), clientThreadId: 'codex' }] },
      { version: 1, scope, records: [{ ...prepared(), native: { sessionKey: 'different' } }] },
    ]) {
      const contents = JSON.stringify(value);
      await store.file.write(contents);
      await assert.rejects(store.read(), /dispatch-state-invalid/);
      assert.equal(await readFile(store.path, 'utf8'), contents);
    }
  });

  it('should serialize competing writers and preserve the first creation intent', async () => {
    const store = new OpenClawDispatchStore(root, scope);
    await store.exclusive(async (state, save) => {
      state.records.push(prepared());
      await save();
      await assert.rejects(
        new OpenClawDispatchStore(root, scope).exclusive(async () =>
          assert.fail('second writer entered'),
        ),
        { code: 'private-state-file-lock-busy' },
      );
    });
    assert.equal((await store.read()).records.length, 1);
  });
});
