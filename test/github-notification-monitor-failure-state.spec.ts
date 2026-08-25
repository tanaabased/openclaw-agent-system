import assert from 'node:assert/strict';

import createGitHubNotificationFailureState from '../channels/github/intake/monitor/failure-state.ts';
import { notificationMonitorState } from './github-notification-fixtures.ts';

describe('channels/github/intake/monitor/failure-state', () => {
  it('should create deterministic first-failure backoff without mutating prior state', () => {
    const current = notificationMonitorState();
    const original = structuredClone(current);

    const failed = createGitHubNotificationFailureState({
      agentId: 'tanaabot',
      code: 'github-notification-request-failed',
      current,
      now: 1_000,
      random: () => 0.5,
      workspaceDir: '/workspace',
    });

    assert.deepEqual(current, original);
    assert.equal(failed.diagnosticCode, 'github-notification-request-failed');
    assert.equal(failed.failureCount, 1);
    assert.equal(failed.lastPollAt, 1_000);
    assert.equal(failed.nextPollAt, 31_000);
  });

  it('should honor a later provider retry boundary', () => {
    const failed = createGitHubNotificationFailureState({
      agentId: 'tanaabot',
      code: 'github-notification-rate-limited',
      current: undefined,
      now: 1_000,
      random: () => 0.5,
      retryAt: 90_000,
      workspaceDir: '/workspace',
    });

    assert.equal(failed.nextPollAt, 90_000);
  });

  it('should cap exponential failure backoff at one hour', () => {
    const current = notificationMonitorState();
    current.failureCount = 20;

    const failed = createGitHubNotificationFailureState({
      agentId: 'tanaabot',
      code: 'github-notification-request-failed',
      current,
      now: 1_000,
      random: () => 0.5,
      workspaceDir: '/workspace',
    });

    assert.equal(failed.nextPollAt, 3_601_000);
  });
});
