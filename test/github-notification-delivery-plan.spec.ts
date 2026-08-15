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

  it('should reconcile the worktree and stop at the intake boundary', () => {
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
      kind: 'none',
    });
  });

  it('should stop pull-request intake without preparing a worktree', () => {
    assert.deepEqual(planGitHubNotificationDelivery(admitted, { authority }, false), {
      kind: 'none',
    });
  });

  it('should treat active delivery as complete without inspecting a session', () => {
    assert.deepEqual(
      planGitHubNotificationDelivery({ ...admitted, stage: 'active' }, { authority }),
      { kind: 'none' },
    );
  });

  it('should prioritize requested retirement over active delivery', () => {
    assert.deepEqual(
      planGitHubNotificationDelivery(
        { ...admitted, stage: 'active' },
        {
          authority,
          retirementReasonCode: 'item-closed',
          retirementRequested: true,
        },
      ),
      { kind: 'retire', reasonCode: 'item-closed' },
    );
  });

  it('should accept legacy post-intake checkpoints as complete', () => {
    for (const stage of ['session-recording', 'received'] as const) {
      assert.deepEqual(
        planGitHubNotificationDelivery(
          {
            ...admitted,
            stage,
            worktreeBranch: worktree.branch,
            worktreePath: worktree.path,
          },
          { authority, worktree },
        ),
        { kind: 'none' },
      );
    }
  });

  it('should preserve the retired terminal state', () => {
    assert.deepEqual(
      planGitHubNotificationDelivery({ ...admitted, stage: 'retired' }, { authority }),
      { kind: 'none' },
    );
  });
});
