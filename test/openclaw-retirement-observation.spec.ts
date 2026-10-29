import assert from 'node:assert/strict';
import observeRetirementSession, {
  observeRetiringSession,
} from '../agent/openclaw-retirement-observation.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import retainDispatchHistory from '../agent/retain-dispatch-history.ts';

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
  it('should observe compact retirement receipts and still reject changed native identities', async () => {
    const f = fixture();
    f.record.intakeId = 'admitted';
    f.record.sourceThreadId = 'coordinator';
    f.record.retired = { at: 2, by: 'coordinator' };
    f.record.retirement = {
      reason: 'issue-closed',
      at: 1,
      checkedAt: 2,
      eligibleAt: 1,
      intakeId: 'admitted',
      archivedAt: 2,
      worktreeRemovedAt: 2,
    };
    const compact = retainDispatchHistory(f.record)!;
    assert.equal(compact.request, undefined);
    assert.equal((await observeRetiringSession(f.request, compact, 'owner'))?.idle, true);
    f.history.sessionInfo = { hasActiveRun: true };
    assert.equal((await observeRetiringSession(f.request, compact, 'owner'))?.idle, false);
    f.row.sessionId = 'replacement';
    await assert.rejects(observeRetiringSession(f.request, compact, 'owner'), /identity-changed/u);
    const missing = await observeRetirementSession(
      async () => ({ session: null }),
      compact,
      'owner',
      'coordinator',
    );
    assert.equal(missing?.unavailableSession, 'not-found');
    assert.equal(missing?.idle, false);
    compact.nativeInactive = false;
    assert.equal(await observeRetiringSession(f.request, compact, 'owner'), undefined);
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
    await assert.rejects(
      observeRetirementSession(async () => ({ session: null }), f.record, 'owner', 'other'),
      /dispatch-session-response-invalid-sessions-describe-session-null/u,
    );
  });
});
