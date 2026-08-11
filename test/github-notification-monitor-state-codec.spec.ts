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
