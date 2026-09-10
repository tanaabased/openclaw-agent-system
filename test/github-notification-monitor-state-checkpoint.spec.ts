import assert from 'node:assert/strict';

import {
  checkpointGitHubNotificationPoll,
  patchGitHubNotificationItem,
} from '../channels/github/intake/monitor/state-checkpoint.ts';
import {
  notificationItemKey as itemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

const prepared = {
  stage: 'prepared' as const,
  worktreeBranch: 'issue-12',
  worktreePath: '/workspace/worktrees/issue-12',
};
const cleanup = {
  reasonCode: 'item-closed',
  session: 'missing' as const,
  status: 'completed' as const,
  worktree: 'removed' as const,
};

function pollResult() {
  const state = notificationMonitorState();
  state.items[itemKey]!.lastObservedAt += 1;
  state.items['R_repo:13'] = { ...state.items[itemKey]!, number: 13, itemNodeId: 'I_other' };
  state.searchBoundary = '2026-09-10T12:00:00.000Z';
  state.lastSuccessfulPollAt = 2_000;
  state.nextPollAt = 3_000;
  state.processedEventNodeIds.push('EV_other');
  return state;
}

describe('channels/github/intake/monitor/state-checkpoint', () => {
  for (const first of ['poll', 'execution']) {
    it(`should retain admissions and execution progress when ${first} checkpoints first`, () => {
      const before = notificationMonitorState();
      const polled = pollResult();
      const patch = { intake: { ...prepared, failureCode: 'github-notification-intake-failed' } };
      const latest =
        first === 'poll'
          ? patchGitHubNotificationItem(
              checkpointGitHubNotificationPoll(before, before, polled),
              before,
              itemKey,
              patch,
            )
          : checkpointGitHubNotificationPoll(
              patchGitHubNotificationItem(before, before, itemKey, patch),
              before,
              polled,
            );

      assert.deepEqual(latest.items['R_repo:13'], polled.items['R_repo:13']);
      assert.equal(latest.searchBoundary, polled.searchBoundary);
      assert.equal(latest.nextPollAt, polled.nextPollAt);
      assert.deepEqual(latest.processedEventNodeIds, polled.processedEventNodeIds);
      assert.deepEqual(latest.items[itemKey]?.intake, {
        ...before.items[itemKey]!.intake,
        ...patch.intake,
      });
      assert.deepEqual(before, notificationMonitorState());
    });
  }

  for (const first of ['retirement', 'preparation']) {
    it(`should retain retirement and worktree facts when ${first} checkpoints first`, () => {
      const before = notificationMonitorState();
      const retired = pollResult();
      retired.items[itemKey]!.disposition = 'retired';
      retired.items[itemKey]!.reasonCode = 'item-closed';
      retired.items[itemKey]!.intake = {
        ...before.items[itemKey]!.intake!,
        providerRetirementVerifiedAt: 2_000,
        stage: 'retired',
      };
      const latest =
        first === 'retirement'
          ? patchGitHubNotificationItem(retired, before, itemKey, { intake: prepared })
          : checkpointGitHubNotificationPoll(
              patchGitHubNotificationItem(before, before, itemKey, { intake: prepared }),
              before,
              retired,
            );

      assert.equal(latest.items[itemKey]?.disposition, 'retired');
      assert.equal(latest.items[itemKey]?.reasonCode, 'item-closed');
      assert.deepEqual(latest.items[itemKey]?.intake, {
        ...before.items[itemKey]!.intake,
        ...prepared,
        providerRetirementVerifiedAt: 2_000,
        stage: 'retired',
      });
    });
  }

  it('should preserve retirement, cleanup and failure facts when an older open poll finishes', () => {
    const before = notificationMonitorState();
    const retired = patchGitHubNotificationItem(before, before, itemKey, {
      disposition: 'retired',
      reasonCode: 'pull-request-merged',
      intake: {
        ...prepared,
        cleanup,
        failureCode: 'github-notification-cleanup-failed',
        providerRetirementVerifiedAt: 2_000,
        stage: 'retired',
      },
    });
    const latest = checkpointGitHubNotificationPoll(retired, before, pollResult());
    assert.deepEqual(latest.items[itemKey]?.intake, retired.items[itemKey]?.intake);
    assert.equal(latest.items[itemKey]?.disposition, 'retired');
    assert.equal(latest.items[itemKey]?.reasonCode, 'pull-request-merged');
  });

  it('should replace an assignment without carrying its old execution facts into the new one', () => {
    const before = notificationMonitorState();
    const latest = patchGitHubNotificationItem(before, before, itemKey, { intake: prepared });
    const reassigned = pollResult();
    reassigned.items[itemKey]!.assignmentEventNodeId = 'EV_reassigned';
    reassigned.items[itemKey]!.intake!.assignmentEventId = 'EV_reassigned';
    const current = checkpointGitHubNotificationPoll(latest, before, reassigned);
    assert.deepEqual(current.items[itemKey], reassigned.items[itemKey]);
    for (const intake of [
      prepared,
      { cleanup },
      { failureCode: 'github-notification-intake-failed' },
    ]) {
      assert.throws(() => patchGitHubNotificationItem(current, before, itemKey, { intake }), {
        code: 'github-notification-state-checkpoint-stale',
      });
    }
  });

  it('should reject stale checkpoints after removal or a scope change', () => {
    const before = notificationMonitorState();
    const missingItem = { ...before, items: {} };
    for (const current of [
      undefined,
      missingItem,
      { ...before, accountNodeId: 'U_other' },
      { ...before, workspaceDir: '/another-workspace' },
      { ...before, baselineAt: 50 },
    ]) {
      assert.throws(
        () => patchGitHubNotificationItem(current, before, itemKey, { intake: prepared }),
        {
          code: 'github-notification-state-checkpoint-stale',
        },
      );
      assert.throws(() => checkpointGitHubNotificationPoll(current, before, pollResult()), {
        code: 'github-notification-state-checkpoint-stale',
      });
    }
  });

  it('should retain the existing account reset behavior while rejecting late old-account work', () => {
    const before = notificationMonitorState();
    const reset = { ...before, accountNodeId: 'U_new', baselineAt: 10, items: {} };
    const current = checkpointGitHubNotificationPoll(before, before, reset);
    assert.deepEqual(current, reset);
    assert.throws(
      () => patchGitHubNotificationItem(current, before, itemKey, { intake: prepared }),
      {
        code: 'github-notification-state-checkpoint-stale',
      },
    );
  });
});
