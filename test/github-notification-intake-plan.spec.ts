import assert from 'node:assert/strict';

import planGitHubNotificationIntake from '../channels/github/intake/intake-plan.ts';
import type { GitHubNotificationIntakeState } from '../channels/github/intake/monitor/state.ts';

const admitted: GitHubNotificationIntakeState = {
  assignmentEventId: 'EV_assignment',
  stage: 'admitted',
};
const authority = { authorized: true };

describe('channels/github/intake/intake-plan', () => {
  it('should prepare a lifecycle that owns no worktree', () => {
    assert.deepEqual(planGitHubNotificationIntake(admitted, { authority }, false), {
      kind: 'mark-prepared',
    });
  });

  it('should prepare or adopt a lifecycle-owned worktree', () => {
    assert.deepEqual(planGitHubNotificationIntake(admitted, { authority }, true), {
      kind: 'prepare-worktree',
    });
    const worktree = { branch: 'agent/tanaabot/issue-7', path: '/workspace/issue-7' };
    assert.deepEqual(planGitHubNotificationIntake(admitted, { authority, worktree }, true), {
      kind: 'mark-prepared',
      worktree,
    });
  });

  it('should stop prepared intake and retire revoked authority', () => {
    assert.deepEqual(
      planGitHubNotificationIntake({ ...admitted, stage: 'prepared' }, { authority }, false),
      { kind: 'none' },
    );
    assert.deepEqual(
      planGitHubNotificationIntake(
        admitted,
        { authority: { authorized: false, reasonCode: 'item-unassigned' } },
        true,
      ),
      { kind: 'retire', reasonCode: 'item-unassigned' },
    );
  });

  it('should preserve explicit retirement reasons', () => {
    assert.deepEqual(
      planGitHubNotificationIntake(
        admitted,
        {
          authority,
          retirementReasonCode: 'item-closed',
          retirementRequested: true,
        },
        true,
      ),
      { kind: 'retire', reasonCode: 'item-closed' },
    );
  });
});
