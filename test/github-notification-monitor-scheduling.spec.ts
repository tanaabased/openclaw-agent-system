import assert from 'node:assert/strict';

import { githubNotificationMonitorStatus } from '../channels/github/intake/monitor/status.ts';
import { githubWorkItemKey } from '../channels/github/provider/work-item.ts';
import createGitHubNotificationSchedulingFixture, {
  schedulingIssueA,
  schedulingIssueB,
  schedulingSelector,
} from './github-notification-scheduling-fixture.ts';

const itemKeyA = githubWorkItemKey(schedulingIssueA.repositoryNodeId, schedulingIssueA.number);
const itemKeyB = githubWorkItemKey(schedulingIssueB.repositoryNodeId, schedulingIssueB.number);

describe('channels/github/intake/monitor/service scheduling', () => {
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
