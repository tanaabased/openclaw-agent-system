import assert from 'node:assert/strict';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { NotificationResetRecord } from '../agent/notification-reset-state.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import observeResetUnresolved from '../agent/openclaw-reset-unresolved.ts';

describe('agent/openclaw-reset-unresolved', () => {
  const fixture = () => ({
    entry: {
      id: 'intent',
      worktree: '/managed/issue',
      request: { key: 'issue', agentId: 'owner', cwd: '/managed/issue' },
    } as OpenClawDispatchRecord,
    reset: {
      resources: [
        {
          id: 'checkout',
          kind: 'worktree',
          description: '/managed/issue',
          identity: 'intent',
          details: [],
          state: 'pending',
        },
      ],
    } as Pick<NotificationResetRecord, 'resources' | 'warnings'>,
  });
  it('should release an unresolved current creation intent when the native checkout inventory is empty', async () => {
    const { entry, reset } = fixture();
    const request: DispatchRequest = async (method, params) => {
      if (method === 'sessions.describe') return { session: null };
      assert.equal(method, 'sessions.list');
      assert.equal(params.workspaceDir, '/managed/issue');
      assert.equal(params.archived, 'all');
      return { sessions: [] };
    };
    assert.equal(await observeResetUnresolved(request, reset, entry, 'emori'), true);
    assert.equal(reset.resources[0]!.state, 'pending');
    assert.equal(reset.warnings, undefined);
  });
  it('should wait for active native turns and preserve unowned sessions and their checkout', async () => {
    const { entry, reset } = fixture();
    let active = true;
    const request: DispatchRequest = async (method) => {
      if (method === 'sessions.describe') return { session: null };
      if (method === 'sessions.list') return { sessions: [{ key: 'native', agentId: 'emori' }] };
      assert.equal(method, 'chat.history');
      return { sessionInfo: { hasActiveRun: active }, pendingInputs: { total: 0 } };
    };
    assert.equal(await observeResetUnresolved(request, reset, entry, 'emori'), false);
    active = false;
    assert.equal(await observeResetUnresolved(request, reset, entry, 'emori'), true);
    assert.equal(reset.resources[0]!.state, 'preserved');
    assert.equal(reset.warnings?.length, 1);
    assert.match(reset.warnings![0]!, /notification-reset-unresolved-session-preserved/u);
  });
  it('should inspect an exact modern session even if it has moved out of the old checkout', async () => {
    const { entry, reset } = fixture();
    entry.request = { ...entry.request, key: 'native' } as OpenClawDispatchRecord['request'];
    const request: DispatchRequest = async (method) => {
      if (method === 'sessions.describe') return { session: { key: 'native', agentId: 'emori' } };
      if (method === 'sessions.list') return { sessions: [] };
      assert.equal(method, 'chat.history');
      return { sessionInfo: { hasActiveRun: false }, pendingInputs: { total: 1 } };
    };
    assert.equal(await observeResetUnresolved(request, reset, entry, 'emori'), false);
    assert.equal(reset.resources[0]!.state, 'preserved');
  });
  it('should not mistake unavailable native inventory for absence', async () => {
    const { entry, reset } = fixture();
    await assert.rejects(
      observeResetUnresolved(async () => ({}), reset, entry, 'emori'),
      /notification-reset-session-inventory-unavailable/u,
    );
    await assert.rejects(
      observeResetUnresolved(
        async () => {
          throw new Error('denied');
        },
        reset,
        entry,
        'emori',
      ),
      /denied/u,
    );
  });
});
