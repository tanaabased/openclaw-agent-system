import assert from 'node:assert/strict';

import GitHubNotificationStatusService from '../channels/github/lib/status-service.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

describe('channels/github/lib/status-service', () => {
  it('should wait for an asynchronous durable checkpoint without refreshing', async () => {
    let now = 0;
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    const service = new GitHubNotificationStatusService({
      clock: () => now,
      monitorService: {
        async runOnce() {
          throw new Error('refresh must not run');
        },
      },
      sleep: async (milliseconds) => {
        now += milliseconds;
        const item = state.items[notificationItemKey]!;
        item.delivery = {
          ...item.delivery!,
          acknowledgment: { commentId: 92, status: 'published' },
          activation: { status: 'planned' },
          sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
          stage: 'active',
          worktreeBranch: 'agent/tanaabot/issue-7',
          worktreePath: '/workspace/worktrees/issue-7',
        };
      },
      stateStore: {
        async read() {
          return structuredClone(state);
        },
      },
    });

    const result = await service.wait({
      agentId: 'tanaabot',
      refresh: false,
      selector: { itemType: 'issue', number: 12, repository: 'tanaabased/example' },
      target: 'planning-complete',
      timeoutMs: 5_000,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.code, 'github-notification-planning-complete');
  });

  it('should drive refresh-owned transitions only when explicitly selected', async () => {
    const state = notificationMonitorState();
    state.lastSuccessfulPollAt = 2;
    let refreshes = 0;
    const service = new GitHubNotificationStatusService({
      monitorService: {
        async runOnce(options) {
          refreshes += 1;
          assert.equal(options && !('aborted' in options) && options.signal?.aborted, false);
          const item = state.items[notificationItemKey]!;
          item.disposition = 'rejected';
          item.reasonCode = 'assignment-actor-not-approved';
          delete item.delivery;
          return [
            {
              agentId:
                options && !('aborted' in options) ? (options.agentId ?? 'tanaabot') : 'tanaabot',
              code: 'github-notification-poll-complete',
              status: 'completed' as const,
            },
          ];
        },
      },
      stateStore: {
        async read() {
          return structuredClone(state);
        },
      },
    });

    const result = await service.wait({
      agentId: 'tanaabot',
      refresh: true,
      selector: { itemType: 'issue', number: 12, repository: 'tanaabased/example' },
      target: 'assignment-rejected',
      timeoutMs: 5_000,
    });

    assert.equal(refreshes, 1);
    assert.equal(result.status, 'completed');
  });

  it('should return the last redacted observation when a wait times out', async () => {
    let now = 0;
    const service = new GitHubNotificationStatusService({
      clock: () => now,
      monitorService: {
        async runOnce() {
          return [];
        },
      },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      stateStore: {
        async read() {
          return undefined;
        },
      },
    });

    const result = await service.wait({
      agentId: 'tanaabot',
      refresh: false,
      selector: { itemType: 'issue', number: 12, repository: 'tanaabased/example' },
      target: 'active',
      timeoutMs: 2_000,
    });

    assert.equal(result.status, 'timed-out');
    assert.equal(result.code, 'github-notification-wait-timeout');
    assert.equal(result.observation.items.length, 0);
  });

  it('should not run another refresh after the wait deadline', async () => {
    let now = 0;
    let refreshes = 0;
    const service = new GitHubNotificationStatusService({
      clock: () => now,
      monitorService: {
        async runOnce() {
          refreshes += 1;
          return [
            {
              agentId: 'tanaabot',
              code: 'github-notification-poll-complete',
              status: 'completed' as const,
            },
          ];
        },
      },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      stateStore: {
        async read() {
          return undefined;
        },
      },
    });

    const result = await service.wait({
      agentId: 'tanaabot',
      refresh: true,
      selector: { itemType: 'issue', number: 12, repository: 'tanaabased/example' },
      target: 'active',
      timeoutMs: 1_000,
    });

    assert.equal(result.status, 'timed-out');
    assert.equal(refreshes, 1);
  });
});
