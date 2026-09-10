import assert from 'node:assert/strict';

import { githubNotificationMonitorStatus } from '../channels/github/intake/monitor/status.ts';
import { patchGitHubNotificationItem } from '../channels/github/intake/monitor/state-checkpoint.ts';
import { githubWorkItemKey } from '../channels/github/provider/work-item.ts';
import createGitHubNotificationSchedulingFixture, {
  schedulingIssueA,
  schedulingIssueB,
  schedulingSelector,
} from './github-notification-scheduling-fixture.ts';

const itemKeyA = githubWorkItemKey(schedulingIssueA.repositoryNodeId, schedulingIssueA.number);
const itemKeyB = githubWorkItemKey(schedulingIssueB.repositoryNodeId, schedulingIssueB.number);

describe('channels/github/intake/monitor/service scheduling', () => {
  it('should retain retirement checkpointed after a poll snapshot while admitting another issue', async () => {
    const fixture = await createGitHubNotificationSchedulingFixture();
    fixture.release.resolve();
    fixture.expose(schedulingIssueB);
    const retiredIntake = {
      ...schedulingIssueA.intake!,
      cleanup: {
        reasonCode: 'pull-request-merged',
        session: 'missing' as const,
        status: 'completed' as const,
        worktree: 'removed' as const,
      },
      providerRetirementVerifiedAt: 3_500,
      stage: 'retired' as const,
      worktreeBranch: 'issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    try {
      const monitor = fixture.createMonitor(async (store) => {
        const before = await store.read(fixture.agentId);
        assert.ok(before);
        await store.update(fixture.agentId, (current) =>
          patchGitHubNotificationItem(current, before, itemKeyA, {
            disposition: 'retired',
            intake: retiredIntake,
            reasonCode: 'pull-request-merged',
          }),
        );
      });
      const [result] = await monitor.runOnce({ agentId: fixture.agentId });

      assert.equal(result?.status, 'completed');
      const state = await fixture.readState();
      assert.deepEqual(state?.items[itemKeyA]?.intake, retiredIntake);
      assert.equal(state?.items[itemKeyA]?.disposition, 'retired');
      assert.equal(state?.items[itemKeyB]?.intake?.stage, 'prepared');
      assert.deepEqual(fixture.sessionCalls, [schedulingIssueB.number]);
    } finally {
      await fixture.dispose();
    }
  });

  for (const outcome of ['completed', 'failed'] as const) {
    it(`should recover a later assignment after a held session ${outcome}`, async () => {
      const fixture = await createGitHubNotificationSchedulingFixture();
      const active = fixture.createMonitor().runOnce({ agentId: fixture.agentId });
      try {
        await Promise.race([
          fixture.started,
          active.then(() => assert.fail('the cycle ended before reaching the held session')),
        ]);
        fixture.expose(schedulingIssueB);
        const before = await fixture.readState();
        assert.equal(before?.items[itemKeyA]?.intake?.stage, 'prepared');
        const refresh = fixture.createMonitor();
        const options = {
          agentId: fixture.agentId,
          bypassInterval: true,
          executionSurface: 'cli-one-shot' as const,
          selector: schedulingSelector(schedulingIssueB),
        };
        const [blocked] = await refresh.runOnce(options);

        // #71 baseline: the desired regression will require admission before releasing a.
        assert.equal(blocked?.code, 'github-notification-cycle-busy');
        assert.equal(blocked?.status, 'skipped');
        assert.deepEqual(await fixture.readState(), before);
        assert.deepEqual(
          githubNotificationMonitorStatus(fixture.agentId, before, options.selector).items,
          [],
        );
        assert.equal(fixture.requests.includes('/repos/tanaabased/example/issues/13'), false);
        assert.deepEqual(fixture.sessionCalls, [schedulingIssueA.number]);

        if (outcome === 'failed') fixture.release.reject(new Error('controlled session failure'));
        else fixture.release.resolve();
        await active;

        const [admitted] = await refresh.runOnce(options);
        assert.equal(admitted?.status, 'completed');
        assert.equal(admitted?.approved, 1);
        const after = await fixture.readState();
        assert.deepEqual(after?.items[itemKeyA], before?.items[itemKeyA]);
        assert.equal(after?.items[itemKeyB]?.disposition, 'approved');
        assert.equal(after?.items[itemKeyB]?.intake?.stage, 'prepared');
        assert.deepEqual(fixture.sessionCalls, [schedulingIssueA.number, schedulingIssueB.number]);
        assert.equal(
          fixture.warnings.some((message) =>
            message.includes('github-notification-assignment-session-recording-failed'),
          ),
          outcome === 'failed',
        );

        await refresh.runOnce(options);
        assert.deepEqual(fixture.worktreePreparations, [
          schedulingIssueA.itemDatabaseId,
          schedulingIssueB.itemDatabaseId,
        ]);
      } finally {
        fixture.release.resolve();
        await active;
        await fixture.dispose();
      }
    });
  }

  it('should end a bounded refresh without disturbing the held session or its state', async () => {
    const fixture = await createGitHubNotificationSchedulingFixture();
    const active = fixture.createMonitor().runOnce({ agentId: fixture.agentId });
    const controller = new AbortController();
    let waiting: ReturnType<ReturnType<typeof fixture.createMonitor>['runOnce']> | undefined;
    try {
      await Promise.race([
        fixture.started,
        active.then(() => assert.fail('the cycle ended before reaching the held session')),
      ]);
      fixture.expose(schedulingIssueB);
      const before = await fixture.readState();
      waiting = fixture.createMonitor().runOnce({
        agentId: fixture.agentId,
        bypassInterval: true,
        executionSurface: 'cli-one-shot',
        selector: schedulingSelector(schedulingIssueB),
        signal: controller.signal,
        waitForLeaseMs: 120_000,
      });
      await Promise.race([
        fixture.contended,
        waiting.then(() => assert.fail('the refresh ended before attempting the held lease')),
      ]);
      // expire the caller's budget at a known contention point without a wall-clock sleep.
      controller.abort();
      const [result] = await waiting;

      assert.equal(result?.code, 'github-notification-cycle-aborted');
      assert.equal(result?.status, 'skipped');
      assert.deepEqual(await fixture.readState(), before);
      assert.deepEqual(fixture.sessionCalls, [schedulingIssueA.number]);
      fixture.release.resolve();
      assert.equal((await active)[0]?.status, 'completed');
    } finally {
      controller.abort();
      fixture.release.resolve();
      await Promise.allSettled([active, ...(waiting ? [waiting] : [])]);
      await fixture.dispose();
    }
  });
});
