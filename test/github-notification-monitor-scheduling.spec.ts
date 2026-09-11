import assert from 'node:assert/strict';
import { GitHubNotificationModelTurnCoordinatorError } from '../channels/github/conversation/model-turn-coordinator.ts';

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
  it('should retain a reply-turn conflict in refresh status and execution diagnostics', async () => {
    const fixture = await createGitHubNotificationSchedulingFixture();
    const running = fixture.createMonitor().runOnce({ agentId: fixture.agentId });
    try {
      await fixture.started;
      fixture.release.reject(
        new GitHubNotificationModelTurnCoordinatorError(
          'github-notification-reply-turn-already-active',
        ),
      );
      const [result] = await running;
      assert.equal(result?.status, 'failed');
      assert.equal(result?.code, 'github-notification-reply-turn-already-active');
      assert.ok(
        fixture.warnings.some((message) =>
          message.includes('github-notification-reply-turn-already-active'),
        ),
      );
      assert.ok(
        fixture.warnings.every(
          (message) => !message.includes('assignment-session-recording-failed'),
        ),
      );
    } finally {
      fixture.release.resolve();
      await running;
      await fixture.dispose();
    }
  });
  it('should keep a comment and assignment response under the same issue lease', async () => {
    const entered = Promise.withResolvers<void>();
    const releaseComment = Promise.withResolvers<void>();
    const fixture = await createGitHubNotificationSchedulingFixture({
      async reconcileComment(_agentId, itemKey) {
        if (itemKey === itemKeyA) {
          entered.resolve();
          await releaseComment.promise;
        }
      },
    });
    fixture.expose(schedulingIssueB);
    fixture.release.resolve();
    const running = fixture.createMonitor().runOnce({ agentId: fixture.agentId });
    try {
      await Promise.race([
        Promise.all([entered.promise, fixture.startedB]),
        running.then(() => assert.fail('the refresh ended before the comment hold')),
      ]);
      assert.deepEqual(fixture.sessionCalls, [schedulingIssueB.number]);
      const [contender] = await fixture.createMonitor().runOnce({
        agentId: fixture.agentId,
        bypassInterval: true,
        selector: schedulingSelector(schedulingIssueA),
      });
      assert.equal(contender?.code, 'github-notification-execution-busy');
      assert.deepEqual(fixture.sessionCalls, [schedulingIssueB.number]);
      releaseComment.resolve();
      assert.equal((await running)[0]?.status, 'completed');
      assert.deepEqual(fixture.sessionCalls, [schedulingIssueB.number, schedulingIssueA.number]);
    } finally {
      releaseComment.resolve();
      await running;
      await fixture.dispose();
    }
  });

  it('should begin both issues in one cli refresh and await every started worker', async () => {
    const fixture = await createGitHubNotificationSchedulingFixture();
    fixture.expose(schedulingIssueB);
    let completed = false;
    const running = fixture
      .createMonitor()
      .runOnce({
        agentId: fixture.agentId,
        executionSurface: 'cli-one-shot',
      })
      .then((result) => {
        completed = true;
        return result;
      });
    try {
      await Promise.race([
        Promise.all([fixture.started, fixture.startedB]),
        running.then(() => assert.fail('the refresh ended before both issues started')),
      ]);
      assert.equal(completed, false);
      assert.deepEqual([...fixture.sessionCalls].sort(), [
        schedulingIssueA.number,
        schedulingIssueB.number,
      ]);
      const state = await fixture.readState();
      assert.equal(state?.items[itemKeyA]?.intake?.stage, 'prepared');
      assert.equal(state?.items[itemKeyB]?.intake?.stage, 'prepared');
      fixture.release.resolve();
      assert.equal((await running)[0]?.status, 'completed');
    } finally {
      fixture.release.resolve();
      await running;
      await fixture.dispose();
    }
  });

  it('should checkpoint one failed preparation while completing an independent issue', async () => {
    const fixture = await createGitHubNotificationSchedulingFixture({
      async prepareWorktree(itemDatabaseId) {
        if (itemDatabaseId === schedulingIssueA.itemDatabaseId)
          throw new Error('controlled worktree failure');
      },
    });
    fixture.expose(schedulingIssueB);
    try {
      const [result] = await fixture.createMonitor().runOnce({ agentId: fixture.agentId });
      assert.equal(result?.status, 'failed');
      assert.equal(result?.code, 'github-notification-worktree-preparation-failed');
      const state = await fixture.readState();
      assert.equal(state?.items[itemKeyA]?.intake?.stage, 'admitted');
      assert.equal(
        state?.items[itemKeyA]?.intake?.failureCode,
        'github-notification-worktree-preparation-failed',
      );
      assert.equal(state?.items[itemKeyB]?.intake?.stage, 'prepared');
      assert.equal(state?.items[itemKeyB]?.intake?.failureCode, undefined);
      assert.equal(state?.failureCount, 0);
      assert.deepEqual(fixture.sessionCalls, [schedulingIssueB.number]);
    } finally {
      await fixture.dispose();
    }
  });

  it('should supervise independent gateway workers through polling, shutdown, and restart', async () => {
    const fixture = await createGitHubNotificationSchedulingFixture({ holdIssueB: true });
    const controller = new AbortController();
    const nextTick = Promise.withResolvers<void>();
    const polled = Promise.withResolvers<void>();
    let cycles = 0;
    let ended = false;
    const monitor = fixture.createMonitor(undefined, async () => {
      if (cycles === 1) await nextTick.promise;
      else {
        await fixture.startedB;
        fixture.advance(300_000);
      }
    });
    const running = monitor
      .runAccount(fixture.agentId, controller.signal, () => {
        cycles += 1;
        if (cycles === 3) {
          controller.abort();
          polled.resolve();
        }
      })
      .then(() => {
        ended = true;
      });
    try {
      await Promise.race([
        fixture.started,
        running.then(() => assert.fail('the account ended before starting execution')),
      ]);
      fixture.expose(schedulingIssueB);
      fixture.advance(300_000);
      nextTick.resolve();
      await polled.promise;
      const during = await fixture.readState();
      assert.equal(during?.items[itemKeyB]?.intake?.stage, 'prepared');
      assert.equal(during?.items[itemKeyA]?.intake?.stage, 'prepared');
      assert.deepEqual(fixture.sessionCalls, [schedulingIssueA.number, schedulingIssueB.number]);
      assert.equal(fixture.sessionSignals.length, 2);
      assert.equal(
        fixture.sessionSignals.every((signal) => signal.aborted),
        true,
      );
      assert.equal(ended, false);

      fixture.release.resolve();
      const [releasedA] = await fixture.createMonitor().runOnce({
        agentId: fixture.agentId,
        bypassInterval: true,
        selector: schedulingSelector(schedulingIssueA),
        waitForLeaseMs: 1_000,
      });
      assert.equal(releasedA?.status, 'completed');
      assert.equal(ended, false);
      fixture.releaseB.resolve();
      await running;
      const [recovered] = await fixture.createMonitor().runOnce({
        agentId: fixture.agentId,
        bypassInterval: true,
        selector: schedulingSelector(schedulingIssueB),
      });
      assert.equal(recovered?.status, 'completed');
      assert.equal((await fixture.readState())?.items[itemKeyB]?.intake?.stage, 'prepared');
      assert.deepEqual(fixture.worktreePreparations, [
        schedulingIssueA.itemDatabaseId,
        schedulingIssueB.itemDatabaseId,
      ]);
    } finally {
      controller.abort();
      nextTick.resolve();
      fixture.release.resolve();
      fixture.releaseB.resolve();
      await running;
      await fixture.dispose();
    }
  });

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
    it(`should execute another issue and its comments before a held session ${outcome}`, async () => {
      const commentCalls: string[] = [];
      const fixture = await createGitHubNotificationSchedulingFixture({
        async reconcileComment(_agentId, itemKey) {
          commentCalls.push(itemKey);
        },
      });
      const active = fixture.createMonitor().runOnce({ agentId: fixture.agentId });
      try {
        await Promise.race([
          fixture.started,
          active.then(() => assert.fail('the cycle ended before reaching the held session')),
        ]);
        fixture.expose(schedulingIssueB);
        const before = await fixture.readState();
        commentCalls.length = 0;
        assert.equal(before?.items[itemKeyA]?.intake?.stage, 'prepared');
        const refresh = fixture.createMonitor();
        const options = {
          agentId: fixture.agentId,
          bypassInterval: true,
          executionSurface: 'cli-one-shot' as const,
          selector: schedulingSelector(schedulingIssueB),
        };
        const [completed] = await refresh.runOnce(options);

        assert.equal(completed?.status, 'completed');
        const during = await fixture.readState();
        assert.deepEqual(during?.items[itemKeyA], before?.items[itemKeyA]);
        assert.equal(during?.items[itemKeyB]?.intake?.stage, 'prepared');
        assert.equal(
          githubNotificationMonitorStatus(fixture.agentId, during, options.selector).items[0]
            ?.disposition,
          'approved',
        );
        assert.equal(fixture.requests.includes('/repos/tanaabased/example/issues/13'), true);
        assert.deepEqual(fixture.sessionCalls, [schedulingIssueA.number, schedulingIssueB.number]);
        assert.deepEqual(commentCalls, [itemKeyB]);
        const [blocked] = await refresh.runOnce({
          ...options,
          selector: schedulingSelector(schedulingIssueA),
        });
        assert.equal(blocked?.code, 'github-notification-execution-busy');
        assert.equal(blocked?.status, 'skipped');
        assert.deepEqual(commentCalls, [itemKeyB]);
        assert.deepEqual(fixture.sessionCalls, [schedulingIssueA.number, schedulingIssueB.number]);

        if (outcome === 'failed') fixture.release.reject(new Error('controlled session failure'));
        else fixture.release.resolve();
        await active;

        const [admitted] = await refresh.runOnce(options);
        assert.equal(admitted?.status, 'completed');
        assert.equal(admitted?.approved, 0);
        const after = await fixture.readState();
        assert.deepEqual(after?.items[itemKeyA]?.intake, before?.items[itemKeyA]?.intake);
        assert.equal(after?.items[itemKeyA]?.disposition, before?.items[itemKeyA]?.disposition);
        assert.equal(after?.items[itemKeyB]?.disposition, 'approved');
        assert.equal(after?.items[itemKeyB]?.intake?.stage, 'prepared');
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
        signal: controller.signal,
        waitForLeaseMs: 120_000,
      });
      await Promise.race([
        Promise.all([fixture.contended, fixture.startedB]),
        waiting.then(() => assert.fail('the refresh ended before attempting the held lease')),
      ]);
      // expire the caller's budget at a known contention point without a wall-clock sleep.
      controller.abort();
      const [result] = await waiting;

      assert.equal(result?.code, 'github-notification-cycle-aborted');
      assert.equal(result?.status, 'skipped');
      const after = await fixture.readState();
      assert.deepEqual(after?.items[itemKeyA]?.intake, before?.items[itemKeyA]?.intake);
      assert.equal(after?.items[itemKeyA]?.disposition, before?.items[itemKeyA]?.disposition);
      assert.equal(after?.items[itemKeyB]?.intake?.stage, 'prepared');
      assert.deepEqual(fixture.sessionCalls, [schedulingIssueA.number, schedulingIssueB.number]);
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
