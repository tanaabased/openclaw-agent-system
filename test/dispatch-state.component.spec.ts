import { withDispatchTask } from '../agent/dispatch-task-scope.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import codexCommit from '../agent/codex-commit.ts';

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

    createdAt: 1,
    manifestDigest: 'manifest',
  } satisfies OpenClawDispatchRecord;
}
function prepared(): OpenClawDispatchRecord {
  return {
    ...pending(),

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
    assert.deepEqual(state.records[0], prepared());
  });

  it('should preserve recorded blockers without repairing workflow state on read', async () => {
    const store = new CodexDispatchStore(root, scope);
    const original = {
      ...pending(),
      threadId: 'native-chat',
      worktree: '/worktree',
      blocker: 'native-approval-denied',
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

  it('should reject duplicate task identities and unverified creation bindings without replacing evidence', async () => {
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
        records[0] = { ...prepared(), worktree: '/different' };
      },
      (records: OpenClawDispatchRecord[]) => {
        records[0] = prepared();
        records[0].sessionCreation!.verified = true;
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
      {
        version: 4,
        scope: 'c'.repeat(64),
        records: [],
      },
      {
        version: 4,
        scope,
        resetGeneration: 'current',
        records: [{ ...pending(), clientThreadId: 'codex' }],
      },
      {
        version: 4,
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

  for (const runtime of ['codex', 'openclaw'] as const) {
    const makeStore = (root: string) =>
      runtime === 'codex'
        ? new CodexDispatchStore(root, scope)
        : new OpenClawDispatchStore(root, scope);
    const healthy = () => ({ ...pending(), threadId: 'healthy-chat', worktree: '/healthy' });
    const damaged = () => ({
      ...pending('d'.repeat(64)),
      threadId: 'damaged-chat',
      worktree: '/damaged',
      createdAt: 'invalid',
      feedback: { unresolved: { destination: 'original', attempted: true } },
    });
    const write = async (store: ReturnType<typeof makeStore>, records: unknown[], extra = {}) => {
      const raw = { version: 4, scope, resetGeneration: 'initial', records, ...extra };
      await store.file.write(JSON.stringify(raw));
      return raw;
    };
    const task = <T>(session: string, run: () => T) => withDispatchTask(runtime, session, run);

    it(`should isolate a healthy ${runtime} task and preserve damaged records and uncertain effects`, async () => {
      const store = makeStore(root);
      const raw = await write(store, [healthy(), damaged()]);
      await assert.rejects(store.read(), /dispatch-state-invalid/);
      await task('healthy-chat', async () => {
        assert.deepEqual((await store.read()).records, [healthy()]);
        await store.transaction(async (state, save) => {
          state.records[0]!.context = 'verified progress';
          await save();
          state.records[0]!.routingNote = 'second checkpoint';
          await save();
        });
      });
      const saved = JSON.parse(await readFile(store.path, 'utf8'));
      assert.deepEqual(saved.records[1], raw.records[1]);
      assert.equal(saved.records[0].context, 'verified progress');
      assert.equal(saved.records[0].routingNote, 'second checkpoint');
      await assert.rejects(
        task('damaged-chat', () => store.read()),
        /dispatch-task-record-invalid/,
      );
      await assert.rejects(
        task('unknown-chat', () => store.read()),
        /dispatch-task-ownership-unresolved/,
      );
    });

    it(`should retain shared and unresolved ${runtime} ownership protections`, async () => {
      const store = makeStore(root);
      for (const other of [
        { ...damaged(), worktree: '/healthy' },
        { ...damaged(), worktree: '/unrelated/../healthy' },
        { ...damaged(), worktree: '/healthy/nested' },
        { ...damaged(), threadId: 'healthy-chat' },
        { ...damaged(), issueKey: healthy().issueKey },
        { ...damaged(), id: undefined },
        { ...damaged(), issueKey: undefined },
        { ...damaged(), predecessorId: healthy().id },
        { ...damaged(), worktree: 12 },
      ]) {
        await write(store, [healthy(), other]);
        const before = await readFile(store.path, 'utf8');
        await assert.rejects(
          task('healthy-chat', () => store.transaction(async (_state, save) => save())),
          /dispatch-(?:state-invalid|task-ownership-unresolved)/,
        );
        assert.equal(await readFile(store.path, 'utf8'), before);
      }
      await write(store, [healthy(), damaged()], { scope: 'e'.repeat(64) });
      await assert.rejects(
        task('healthy-chat', () => store.read()),
        /dispatch-state-invalid/,
      );
      await store.file.write('{unreadable');
      await assert.rejects(
        task('healthy-chat', () => store.read()),
        /dispatch-state-invalid/,
      );
    });

    it(`should protect ${runtime} branch and pull request ownership before effects`, async () => {
      const store = makeStore(root);
      const issueBranch =
        runtime === 'codex'
          ? { issueBranch: { attemptId: healthy().id, name: 'shared-branch', phase: 'ready' } }
          : { adoptedLocalBranch: 'shared-branch' };
      const otherBranch =
        runtime === 'codex'
          ? { issueBranch: { attemptId: damaged().id, name: 'shared-branch', phase: 'ready' } }
          : { adoptedLocalBranch: 'shared-branch' };
      for (const [owner, other] of [
        [
          { ...healthy(), ...issueBranch },
          { ...damaged(), ...otherBranch },
        ],
        [
          { ...healthy(), pullRequestLink: { pullRequestNodeId: 'same-pr', pullRequestNumber: 7 } },
          { ...damaged(), pullRequestLink: { pullRequestNodeId: 'same-pr', pullRequestNumber: 7 } },
        ],
      ]) {
        await write(store, [owner, other]);
        const before = await readFile(store.path, 'utf8');
        await assert.rejects(
          task('healthy-chat', () =>
            store.transaction(async () => {
              assert.fail('unsafe operation entered');
            }),
          ),
          /dispatch-task-ownership-unresolved/,
        );
        assert.equal(await readFile(store.path, 'utf8'), before);
      }
    });

    it(`should prohibit unrelated ${runtime} mutations through an isolated view`, async () => {
      const store = makeStore(root);
      await write(store, [healthy(), damaged()]);
      const before = await readFile(store.path, 'utf8');
      for (const change of [
        (state: { records: unknown[]; discoveryCheckedAt?: number }) => {
          state.records = [];
        },
        (state: { records: unknown[]; discoveryCheckedAt?: number }) => {
          state.records.push(pending('f'.repeat(64)));
        },
        (state: { records: unknown[]; discoveryCheckedAt?: number }) => {
          state.discoveryCheckedAt = 100;
        },
      ]) {
        await assert.rejects(
          task('healthy-chat', () =>
            store.transaction(async (state, save) => {
              change(state);
              await save();
            }),
          ),
          /dispatch-task-isolation-required/,
        );
        assert.equal(await readFile(store.path, 'utf8'), before);
      }
      await assert.rejects(
        task('healthy-chat', () =>
          store.transaction(async (state, save) => {
            state.records[0]!.worktree = '/damaged';
            await save();
          }),
        ),
        /dispatch-task-ownership-unresolved/,
      );
      assert.equal(await readFile(store.path, 'utf8'), before);
    });

    it(`should preserve concurrent ${runtime} opaque updates and reject stale owner writes`, async () => {
      const store = makeStore(root);
      const raw = await write(store, [healthy(), damaged()]);
      await task('healthy-chat', () =>
        store.transaction(async (state, save) => {
          state.records[0]!.routingNote = 'progress';
          raw.records[1] = {
            ...damaged(),
            feedback: { unresolved: { destination: 'new evidence', attempted: true } },
          };
          await store.file.write(JSON.stringify(raw));
          await save();
        }),
      );
      const saved = JSON.parse(await readFile(store.path, 'utf8'));
      assert.deepEqual(saved.records[1], raw.records[1]);
      await assert.rejects(
        task('healthy-chat', () =>
          store.transaction(async (state, save) => {
            state.records[0]!.context = 'stale';
            await task('healthy-chat', () =>
              makeStore(root).transaction(async (other, commit) => {
                other.records[0]!.context = 'fresh';
                await commit();
              }),
            );
            await save();
          }),
        ),
        /private-state-snapshot-conflict/,
      );
      assert.equal(JSON.parse(await readFile(store.path, 'utf8')).records[0].context, 'fresh');
    });
  }

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

  it('should cancel transaction acquisition while an independent writer still holds its lease', async () => {
    const store = new CodexDispatchStore(root, scope);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = store.exclusive(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const other = new CodexDispatchStore(root, scope);
    const pending = other.transaction(async () => assert.fail('cancelled transaction entered'), {
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled transaction'));
    try {
      await assert.rejects(pending, /cancelled transaction/);
    } finally {
      release.resolve();
      await held;
    }
    await other.exclusive(async () => {});
  });

  it('should refresh durable checkpoints without treating omitted optional fields as competing edits', async () => {
    const store = new CodexDispatchStore(root, scope);
    await store.exclusive(async (state, save) => {
      state.records.push(pending());
      await save();
    });
    await store.transaction(
      async (state, save) => {
        state.records[0]!.context = undefined;
        state.records[0]!.routingNote = 'updated';
        await save();
        await save();
        state.records[0]!.routingNote = 'next checkpoint';
        await save();
      },
      codexCommit(1, pending().id),
    );
    const saved = (await store.read()).records[0]!;
    assert.equal(saved.routingNote, 'next checkpoint');
    assert.equal(Object.hasOwn(saved, 'context'), false);
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
