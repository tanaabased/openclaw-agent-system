import assert from 'node:assert/strict';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import observeRetirementSession, {
  observeRetiringSession,
} from '../agent/tasks/retirement/openclaw-retirement-observation.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

function fixture() {
  const record = {
    threadId: 'agent:owner:subagent:old',
    worktree: '/work/issue',
    request: { key: 'agent:owner:subagent:old', agentId: 'owner', cwd: '/work/issue' },
    sessionCreation: { attempted: true, sessionId: 'child' },
  } as OpenClawDispatchRecord;
  const row: Record<string, unknown> = {
    key: record.threadId,
    agentId: 'owner',
    sessionId: 'child',
    spawnedCwd: record.worktree,
    archived: true,
  };
  const history: Record<string, unknown> = {
    sessionId: 'child',
    messages: [],
    sessionInfo: { hasActiveRun: false },
    pendingInputs: { total: 0 },
  };
  const request: DispatchRequest = async (method) => {
    if (method === 'sessions.describe') return { session: row };
    if (method === 'chat.history') return history;
    throw new Error('unexpected mutation');
  };
  return { record, row, history, request };
}

describe('agent/openclaw retirement observation', () => {
  it('should ignore terminal input history without requiring historical messages', async () => {
    const f = fixture();
    delete f.history.messages;
    f.history.pendingInputs = {
      total: 2,
      queuedCount: 0,
      items: [
        { id: 'a', state: 'cancelled' },
        { id: 'b', state: 'interrupted' },
      ],
    };
    assert.equal((await observeRetiringSession(f.request, f.record, 'owner'))?.idle, true);
    f.history.messages = ['unavailable presentation'];
    assert.equal((await observeRetiringSession(f.request, f.record, 'owner'))?.idle, true);
  });
  it('should inspect every pending page and protect unresolved or live queued work', async () => {
    for (const state of ['cancelled', 'queued', 'unknown']) {
      const f = fixture();
      const cursors: unknown[] = [];
      const request: DispatchRequest = async (method, params) => {
        if (method !== 'chat.history') return f.request(method, params);
        cursors.push(params.pendingBefore);
        return {
          ...f.history,
          pendingInputs: params.pendingBefore
            ? { total: 2, queuedCount: 0, items: [{ id: 'b', state }] }
            : {
                total: 2,
                queuedCount: 0,
                items: [{ id: 'a', state: 'interrupted' }],
                nextBefore: 10,
              },
        };
      };
      if (state === 'unknown')
        await assert.rejects(
          observeRetiringSession(request, f.record, 'owner'),
          /pending-inputs-unresolved/,
        );
      else
        assert.equal(
          (await observeRetiringSession(request, f.record, 'owner'))?.idle,
          state === 'cancelled',
        );
      assert.deepEqual(cursors, [undefined, 10]);
    }
    const f = fixture();
    f.history.pendingInputs = { total: 0, items: [], queuedCount: 1 };
    assert.equal((await observeRetiringSession(f.request, f.record, 'owner'))?.idle, false);
  });
  it('should reject incomplete, changing, duplicate and malformed pending custody', async () => {
    for (const pending of [
      { total: 1, items: [] },
      { total: 1 },
      { total: -1, items: [] },
      { total: 0, items: [], queuedCount: '0' },
      {
        total: 2,
        items: [
          { id: 'a', state: 'cancelled' },
          { id: 'a', state: 'interrupted' },
        ],
      },
    ]) {
      const f = fixture();
      f.history.pendingInputs = pending;
      await assert.rejects(
        observeRetiringSession(f.request, f.record, 'owner'),
        /pending-inputs-unresolved/,
      );
    }
    for (const changed of ['identity', 'total', 'cursor']) {
      const f = fixture();
      const request: DispatchRequest = async (method, params) =>
        method !== 'chat.history'
          ? f.request(method, params)
          : {
              ...f.history,
              sessionId: params.pendingBefore && changed === 'identity' ? 'replacement' : 'child',
              pendingInputs: params.pendingBefore
                ? {
                    total: changed === 'total' ? 3 : 2,
                    items: [{ id: 'b', state: 'cancelled' }],
                    ...(changed === 'cursor' ? { nextBefore: 10 } : {}),
                  }
                : { total: 2, items: [{ id: 'a', state: 'cancelled' }], nextBefore: 10 },
            };
      await assert.rejects(
        observeRetiringSession(request, f.record, 'owner'),
        /unavailable|unresolved/,
      );
    }
  });
  it('should verify current native receipts without replacing them', async () => {
    const f = fixture();
    const before = structuredClone(f.record);
    const observed = await observeRetiringSession(f.request, f.record, 'owner');
    assert.equal(observed?.archived, true);
    assert.equal(observed?.idle, true);
    assert.deepEqual(f.record, before);
  });
  it('should reject ambiguous receipts and changed native ownership', async () => {
    for (const field of ['key', 'sessionId', 'agentId', 'spawnedCwd']) {
      const f = fixture();
      f.row[field] = 'different';
      await assert.rejects(
        observeRetiringSession(f.request, f.record, 'owner'),
        /retirement-session-identity-changed/,
      );
    }
    const f = fixture();
    delete f.record.sessionCreation;
    await assert.rejects(
      observeRetiringSession(f.request, f.record, 'owner'),
      /retirement-session-identity-unresolved/,
    );
  });
  it('should identify malformed native fields without copying their contents', async () => {
    for (const [field, name] of [
      ['sessionInfo', 'session-info'],
      ['pendingInputs', 'pending-inputs'],
    ]) {
      for (const [value, type] of [
        [undefined, 'missing'],
        [null, 'null'],
        [[], 'array'],
        ['private text', 'string'],
      ] as const) {
        const f = fixture();
        f.history[field!] = value;
        await assert.rejects(observeRetiringSession(f.request, f.record, 'owner'), {
          message: `dispatch-session-response-invalid-chat-history-${name}-${type}`,
        });
      }
    }
  });
  it('should share missing-session recovery without claiming archival or idleness', async () => {
    const f = fixture();
    f.record.sourceThreadId = 'coordinator';
    const observed = await observeRetirementSession(
      async () => ({ session: null }),
      f.record,
      'owner',
      'coordinator',
    );
    assert.deepEqual(observed, {
      row: undefined,
      archived: false,
      idle: false,
      unavailableSession: 'not-found',
    });
    assert.deepEqual(
      await observeRetirementSession(
        async () => ({ session: null }),
        f.record,
        'owner',
        'replacement',
      ),
      observed,
    );
  });
});
