import assert from 'node:assert/strict';

import { planGitHubNotificationDelivery } from '../channels/github/utils/delivery-plan.ts';
import type { GitHubNotificationDeliveryState } from '../channels/github/utils/monitor-state.ts';

const admitted: GitHubNotificationDeliveryState = {
  assignmentEventId: 'EV_assignment',
  schemaVersion: 1,
  stage: 'admitted',
  workId: 'issue-7',
};
const worktree = { branch: 'issue-7-branch', path: '/workspace/worktrees/issue-7' };
const authority = { authorized: true };

describe('channels/github/utils/delivery-plan', () => {
  it('should retire local delivery state when authority is revoked', () => {
    assert.deepEqual(
      planGitHubNotificationDelivery(admitted, {
        authority: { authorized: false, reasonCode: 'item-unassigned' },
      }),
      { kind: 'retire', reasonCode: 'item-unassigned' },
    );
  });

  it('should reconcile the worktree before recording the channel session', () => {
    assert.deepEqual(planGitHubNotificationDelivery(admitted, { authority }), {
      kind: 'prepare-worktree',
    });
    assert.deepEqual(planGitHubNotificationDelivery(admitted, { authority, worktree }), {
      kind: 'checkpoint-worktree',
      worktree,
    });
    const worktreeReady: GitHubNotificationDeliveryState = {
      ...admitted,
      stage: 'worktree-ready',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    };
    assert.deepEqual(planGitHubNotificationDelivery(worktreeReady, { authority, worktree }), {
      kind: 'record-session',
    });
  });

  it('should treat active delivery as complete without inspecting a session', () => {
    assert.deepEqual(
      planGitHubNotificationDelivery({ ...admitted, stage: 'active' }, { authority }),
      { kind: 'none' },
    );
  });

  it('should retry a deterministic session record', () => {
    assert.deepEqual(
      planGitHubNotificationDelivery(
        {
          ...admitted,
          stage: 'session-recording',
          worktreeBranch: worktree.branch,
          worktreePath: worktree.path,
        },
        { authority, worktree },
      ),
      { kind: 'record-session' },
    );
  });

  it('should preserve the retired terminal state', () => {
    assert.deepEqual(
      planGitHubNotificationDelivery({ ...admitted, stage: 'retired' }, { authority }),
      { kind: 'none' },
    );
  });
});
