import assert from 'node:assert/strict';

import decodeGitHubNotificationMonitorState from '../channels/github/utils/monitor-state-codec.ts';
import {
  legacyNotificationMonitorState,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

describe('channels/github/utils/monitor-state-codec', () => {
  it('should accept current value-free state and reject unknown fields', () => {
    const state = notificationMonitorState();

    assert.deepEqual(decodeGitHubNotificationMonitorState(state, state.agentId), {
      state,
      status: 'ready',
    });
    assert.equal(
      decodeGitHubNotificationMonitorState({ ...state, token: 'must-not-persist' }, state.agentId),
      undefined,
    );
  });

  it('should accept retirement while its prior delivery stage is still being reconciled', () => {
    const state = notificationMonitorState();
    state.items[Object.keys(state.items)[0]!]!.disposition = 'retired';
    state.items[Object.keys(state.items)[0]!]!.reasonCode = 'item-unassigned';

    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
  });

  it('should accept a session-recording checkpoint', () => {
    const state = notificationMonitorState();
    const item = state.items[Object.keys(state.items)[0]!]!;
    item.delivery = {
      ...item.delivery!,
      stage: 'session-recording',
      worktreeBranch: 'issue-7-branch',
      worktreePath: '/workspace/worktrees/issue-7',
    };

    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
  });

  it('should accept old delivery state without retroactive acknowledgment and new receipts', () => {
    const previous = notificationMonitorState();
    const previousItem = previous.items[Object.keys(previous.items)[0]!]!;
    delete previousItem.delivery!.acknowledgment;
    assert.equal(decodeGitHubNotificationMonitorState(previous, previous.agentId)?.status, 'ready');

    const published = notificationMonitorState();
    const publishedItem = published.items[Object.keys(published.items)[0]!]!;
    publishedItem.delivery!.acknowledgment = { commentId: 91, status: 'published' };
    assert.equal(
      decodeGitHubNotificationMonitorState(published, published.agentId)?.status,
      'ready',
    );
  });

  it('should explicitly migrate valid phase one state to a safe baseline', () => {
    const decoded = decodeGitHubNotificationMonitorState(
      legacyNotificationMonitorState(),
      'tanaabot',
    );

    assert.equal(decoded?.status, 'migrated-v1');
    assert.deepEqual(decoded?.state.baselineItemNodeIds, ['I_item']);
    assert.deepEqual(decoded?.state.items, {});
    assert.equal(decoded?.state.diagnosticCode, 'github-notification-state-migrated-v1');
  });
});
