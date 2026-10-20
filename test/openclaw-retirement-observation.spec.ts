import assert from 'node:assert/strict';
import { observeRetiringSession } from '../agent/openclaw-assignment-lifecycle.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

function fixture() {
  const record = {
    threadId: 'agent:owner:subagent:old',
    worktree: '/work/issue',
    request: { runtime: 'subagent', cwd: '/work/issue' },
    creationCall: { sessionId: 'parent', runId: 'creation-run', toolCallId: 'create' },
    native: {
      sessionKey: 'agent:owner:subagent:old',
      sessionId: 'child',
      runId: 'run',
      sourceSessionId: 'parent',
      toolCallId: 'create',
    },
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
  it('should verify historical native receipts without replacing them', async () => {
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
    delete f.record.native;
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
});
