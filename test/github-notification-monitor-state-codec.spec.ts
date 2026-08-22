import assert from 'node:assert/strict';

import decodeGitHubNotificationMonitorState from '../channels/github/intake/monitor/state-codec.ts';
import {
  approvedPullRequestNotificationItem,
  notificationItemKey,
  notificationMonitorState,
  notificationPullRequestItemKey,
} from './github-notification-fixtures.ts';

describe('channels/github/intake/monitor/state-codec', () => {
  it('should accept strict schema-four intake state', () => {
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

  it('should validate prepared and retired lifecycle checkpoints', () => {
    const state = notificationMonitorState();
    const item = state.items[notificationItemKey]!;
    item.intake = {
      ...item.intake!,
      stage: 'prepared',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');

    item.disposition = 'retired';
    item.intake.stage = 'retired';
    item.reasonCode = 'item-closed';
    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
  });

  it('should reject mismatched lifecycle and worktree facts', () => {
    const issue = notificationMonitorState();
    issue.items[notificationItemKey]!.lifecycleId = 'pull-request';
    assert.equal(decodeGitHubNotificationMonitorState(issue, issue.agentId), undefined);

    const pullRequest = notificationMonitorState();
    pullRequest.items = {
      [notificationPullRequestItemKey]: approvedPullRequestNotificationItem(),
    };
    pullRequest.items[notificationPullRequestItemKey]!.intake = {
      assignmentEventId: 'EV_pull_request_assignment',
      stage: 'prepared',
      worktreeBranch: 'unexpected',
      worktreePath: '/workspace/unexpected',
    };
    assert.equal(decodeGitHubNotificationMonitorState(pullRequest, pullRequest.agentId), undefined);
  });

  it('should project schema-three delivery facts into compact intake state', () => {
    const current = notificationMonitorState();
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 3;
    const items = legacy.items as Record<string, Record<string, unknown>>;
    const item = items[notificationItemKey]!;
    delete item.lifecycleId;
    delete item.intake;
    item.commentTracking = {
      baselineAt: 2,
      revisions: { ignored: { body: 'legacy provider data is not projected' } },
    };
    item.delivery = {
      activation: { status: 'planned' },
      assignmentEventId: 'EV_assignment',
      mode: 'plan',
      schemaVersion: 1,
      sessionKey: 'agent:tanaabot:legacy',
      stage: 'active',
      workId: 'issue-7',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };

    const decoded = decodeGitHubNotificationMonitorState(legacy, current.agentId)?.state;

    assert.equal(decoded?.schemaVersion, 4);
    assert.deepEqual(decoded?.items[notificationItemKey]?.intake, {
      assignmentEventId: 'EV_assignment',
      stage: 'prepared',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    });
    assert.equal(decoded?.items[notificationItemKey]?.lifecycleId, 'issue');
    assert.equal('commentTracking' in (decoded?.items[notificationItemKey] ?? {}), false);
  });

  it('should reject unsupported and malformed persisted state', () => {
    const schemaTwo = { ...notificationMonitorState(), schemaVersion: 2 };
    assert.equal(decodeGitHubNotificationMonitorState(schemaTwo, 'tanaabot'), undefined);

    const invalid = notificationMonitorState();
    invalid.items[notificationItemKey]!.intake!.failureCode = 'provider failure with prose';
    assert.equal(decodeGitHubNotificationMonitorState(invalid, invalid.agentId), undefined);
    assert.equal(
      decodeGitHubNotificationMonitorState(notificationMonitorState(), 'other'),
      undefined,
    );
  });
});
