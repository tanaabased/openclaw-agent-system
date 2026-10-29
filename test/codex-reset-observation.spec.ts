import assert from 'node:assert/strict';
import observeResetThread from '../agent/codex-reset-observation.ts';
import retainDispatchHistory from '../agent/retain-dispatch-history.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import { CodexThreadRpcError, type CodexThreadRequest } from '../agent/codex-thread-client.ts';

function fixture() {
  const source = {
    id: 'record',
    intakeId: 'admission',
    sourceThreadId: 'coordinator',
    threadId: 'child',
    worktree: '/work/issue',
    request: { prompt: 'old creation prompt' },
    retired: { at: 2, by: 'coordinator' },
    retirement: {
      reason: 'issue-closed',
      at: 1,
      checkedAt: 2,
      eligibleAt: 1,
      intakeId: 'admission',
      archivedAt: 2,
      worktreeRemovedAt: 2,
    },
  } as DispatchRecord;
  const entry = retainDispatchHistory(source)!;
  const thread: Record<string, unknown> = {
    id: 'child',
    cwd: '/work/issue',
    archived: true,
    status: { type: 'notLoaded' },
  };
  const turn: Record<string, unknown> = { status: 'completed', completedAt: 3 };
  const request: CodexThreadRequest = async (method, params) => {
    assert.equal(params.threadId, 'child');
    if (method === 'thread/read') return { thread };
    assert.equal(method, 'thread/turns/list');
    return { data: [turn] };
  };
  return { entry, thread, turn, request };
}

describe('agent/codex reset observation', () => {
  it('should inspect compact native identity and current activity without the old prompt', async () => {
    const f = fixture();
    assert.equal(f.entry.request, undefined);
    const before = structuredClone(f.entry);
    const observed = await observeResetThread(f.request, f.entry);
    assert.equal(observed?.archived, true);
    assert.equal(observed?.turnEnded, true);
    f.thread.status = { type: 'active' };
    f.turn.status = 'inProgress';
    delete f.turn.completedAt;
    assert.equal((await observeResetThread(f.request, f.entry))?.turnEnded, false);
    assert.equal((await observeResetThread(f.request, f.entry))?.status, 'active');
    assert.deepEqual(f.entry, before);
  });

  it('should reject changed custody and unverified retirement before accepting native state', async () => {
    for (const key of ['id', 'cwd', 'status']) {
      const f = fixture();
      f.thread[key] = 'changed';
      await assert.rejects(observeResetThread(f.request, f.entry), /native-identity-changed/u);
    }
    const f = fixture();
    delete f.entry.retirement!.worktreeRemovedAt;
    await assert.rejects(
      observeResetThread(async () => {
        throw new Error('unexpected native read');
      }, f.entry),
      /native-identity-unresolved/u,
    );
  });

  it('should distinguish missing native history from arbitrary read failures', async () => {
    const f = fixture();
    assert.equal(
      await observeResetThread(async () => {
        throw new CodexThreadRpcError(-32600, 'no rollout found for thread id child');
      }, f.entry),
      undefined,
    );
    await assert.rejects(
      observeResetThread(async () => {
        throw new Error('transport-unavailable');
      }, f.entry),
      /transport-unavailable/u,
    );
  });
});
