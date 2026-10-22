import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
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
      key: 'agent:receiver:issue:one',
      idempotencyKey: 'creation',
      agentId: 'receiver',
      cwd: '/worktree',
      label: '#1: ASSESS',
      category: 'issues',
      model: 'provider/model',
      thinkingLevel: 'high',
    },
    sessionCreation: {
      attempted: true,
      sourceSessionId: 'source',
      sourceRunId: 'run',
      sourceToolCallId: 'call',
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

  it('should preserve native-run bounds across restart and reject malformed passes', async () => {
    const store = new OpenClawDispatchStore(root, scope);
    const pass = {
      sessionKey: pending().sourceThreadId,
      sessionId: 'coordinator',
      runId: 'run-1',
      limit: 3,
      allowance: 2,
      candidates: [pending().intakeId],
      recovery: [],
      selected: [pending().id],
    };
    await store.exclusive(async (state, save) => {
      state.records.push(pending());
      state.openclawPasses = [pass];
      await save();
    });
    assert.deepEqual((await new OpenClawDispatchStore(root, scope).read()).openclawPasses, [pass]);
    const before = await readFile(store.path, 'utf8');
    for (const passes of [
      [pass, pass],
      [{ ...pass, allowance: 4 }],
      [{ ...pass, allowance: 0 }],
      [{ ...pass, selected: [pending().id, pending().id] }],
      [{ ...pass, selected: ['d'.repeat(64)] }],
      [{ ...pass, recovery: ['d'.repeat(64)] }],
    ]) {
      await assert.rejects(
        store.exclusive(async (state, save) => {
          state.openclawPasses = passes;
          await save();
        }),
        /dispatch-state-invalid/,
      );
      assert.equal(await readFile(store.path, 'utf8'), before);
    }
    const codex = new CodexDispatchStore(root, scope);
    await codex.file.write(before);
    await assert.rejects(codex.read(), /dispatch-state-invalid/);
  });

  it('should retain an uncertain creation across restart', async () => {
    const store = new OpenClawDispatchStore(root, scope);
    await store.exclusive(async (state, save) => {
      state.records.push(prepared());
      await save();
    });
    const restarted = new OpenClawDispatchStore(root, scope);
    const state = await restarted.read();
    assert.equal(state.records[0]!.phase, 'creating');
  });

  it('should preserve recorded blockers without repairing workflow state on read', async () => {
    const store = new CodexDispatchStore(root, scope);
    const original = {
      ...pending(),
      threadId: 'native-chat',
      worktree: '/worktree',
      phase: 'blocked' as const,
      result: {
        version: 1 as const,
        outcome: 'operator-setup-blocker' as const,
        code: 'dispatch-policy-changed',
        summary: 'Configuration changed.',
        remediation: 'Old repair.',
        evidence: [],
        progress: { completed: [], remaining: [] },
      },
      context: '{}',
      routing: '{}',
      routingNote: 'selected',
      effective: { status: 'verified' as const },
      reservationVersion: 1 as const,
      project: {
        id: 'project',
        path: '/repo',
        commonDir: '/common',
        ref: 'main',
        commit: 'a'.repeat(40),
      },
      request: {
        title: 'issue',
        prompt: 'assess',
        model: 'model',
        thinking: 'high',
        target: {
          type: 'project' as const,
          projectId: 'project',
          environment: {
            type: 'worktree' as const,
            startingState: { type: 'branch' as const, branchName: 'main' },
          },
        },
      },
    };
    await store.exclusive(async (state, save) => {
      state.records.push(original);
      await save();
    });
    const before = await readFile(store.path, 'utf8');
    const restarted = new CodexDispatchStore(root, scope);
    const recovered = (await restarted.read()).records[0]!;
    assert.equal(recovered.phase, 'blocked');
    assert.deepEqual(recovered.result, original.result);
    assert.deepEqual(recovered.request, original.request);
    assert.equal(recovered.threadId, original.threadId);
    assert.equal(recovered.worktree, original.worktree);
    assert.equal(await readFile(store.path, 'utf8'), before);
    await restarted.exclusive(async (_state, save) => {
      await save();
    });
    assert.deepEqual((await new CodexDispatchStore(root, scope).read()).records[0], recovered);
    assert.equal(await readFile(store.path, 'utf8'), before);
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
      {
        version: 1,
        scope,
        resetGeneration: 'current',
        records: [{ ...pending(), clientThreadId: 'codex' }],
      },
      {
        version: 1,
        scope,
        resetGeneration: 'current',
        records: [{ ...prepared(), native: { sessionKey: 'different' } }],
      },
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

  it('should merge independent writers without holding the journal during external work', async () => {
    const store = new OpenClawDispatchStore(root, scope);
    await store.exclusive(async (state, save) => {
      state.records.push(pending());
      await save();
    });
    await store.transaction(async (state, save) => {
      const retained = state.records[0]!;
      retained.context = 'outer observation';
      await new OpenClawDispatchStore(root, scope).transaction(async (other, commit) => {
        other.records[0]!.routingNote = 'inner observation';
        other.records.push(pending('c'.repeat(64)));
        await commit();
      });
      await save();
      assert.equal(state.records[0], retained);
      assert.equal(retained.routingNote, 'inner observation');
      assert.equal(state.records.length, 2);
    });
    assert.equal((await store.read()).records[0]!.context, 'outer observation');
  });

  it('should reject an identical concurrent reservation before either caller can duplicate its side effect', async () => {
    const store = new OpenClawDispatchStore(root, scope);
    await store.exclusive(async (state, save) => {
      state.records.push(pending());
      await save();
    });
    let effects = 0;
    await assert.rejects(
      store.transaction(async (state, save) => {
        Object.assign(state.records[0]!, prepared());
        await new OpenClawDispatchStore(root, scope).transaction(async (other, commit) => {
          Object.assign(other.records[0]!, prepared());
          await commit();
          effects++;
        });
        await save();
        effects++;
      }),
      /private-state-snapshot-conflict/,
    );
    assert.equal(effects, 1);
    assert.deepEqual((await store.read()).records[0], prepared());
  });

  it('should preserve changed authority and conflicting results instead of saving a stale snapshot', async () => {
    const store = new OpenClawDispatchStore(root, scope);
    await store.exclusive(async (state, save) => {
      state.records.push(pending());
      await save();
    });
    for (const change of [{ manifestDigest: 'revised' }, { context: 'new evidence' }]) {
      await assert.rejects(
        store.transaction(async (state, save) => {
          state.records[0]!.context = 'stale evidence';
          await store.exclusive(async (fresh, commit) => {
            Object.assign(fresh.records[0]!, change);
            await commit();
          });
          await save();
        }),
        /private-state-snapshot-conflict/,
      );
      assert.notEqual((await store.read()).records[0]!.context, 'stale evidence');
    }
  });
});
