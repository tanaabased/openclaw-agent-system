import assert from 'node:assert/strict';
import type { spawnSync } from 'node:child_process';

import refreshNotifications, { notificationCli } from '../scripts/refresh-notifications.ts';

const completed = { status: 'completed', code: 'github-notification-intake-completed' };
function fixture(receipts: unknown[], readiness: boolean[] = [true], timeoutMs = 5000) {
  let now = 0;
  let dispatches = 0;
  const reports: unknown[] = [];
  const sleeps: number[] = [];
  return {
    reports,
    sleeps,
    get dispatches() {
      return dispatches;
    },
    run: () =>
      refreshNotifications({
        request: () => receipts.shift(),
        ready: () => readiness.shift() ?? false,
        async dispatch() {
          dispatches++;
          return { runId: 'native-run' };
        },
        report: (receipt) => reports.push(receipt),
        async sleep(ms) {
          sleeps.push(ms);
          now += ms;
        },
        now: () => now,
        timeoutMs,
      }),
  };
}

describe('scripts/refresh-notifications', () => {
  it('should advance retained work once only after the selected fixture is admitted', async () => {
    const f = fixture([completed, completed], [false, true]);
    assert.equal(await f.run(), 'native-run');
    assert.equal(f.dispatches, 1);
    assert.deepEqual(f.sleeps, [2000]);
    assert.deepEqual(f.reports, [completed, completed, { runId: 'native-run' }]);
  });

  it('should time out missing admission without dispatching other work', async () => {
    const f = fixture([completed, completed], [false, false], 2500);
    await assert.rejects(f.run(), /timed out/);
    assert.equal(f.dispatches, 0);
    assert.deepEqual(f.sleeps, [2000, 500]);
  });

  it('should reject failed or queued refreshes rather than silently invoking a broad workflow', async () => {
    for (const receipt of [
      undefined,
      { status: 'failed' },
      { status: 'queued', runId: 'broad-run' },
      { status: 'skipped' },
    ]) {
      const f = fixture([receipt]);
      await assert.rejects(f.run());
      assert.equal(f.dispatches, 0);
      assert.deepEqual(f.sleeps, []);
    }
  });
});

describe('notification refresh nested allowances', () => {
  it('should allow a slow successful refresh and recalculate before dependent reads and dispatch', async () => {
    let now = 0;
    const budgets: number[] = [];
    await refreshNotifications({
      timeoutMs: 180_000,
      now: () => now,
      request(timeout) {
        budgets.push(timeout);
        now += 45_000;
        return completed;
      },
      ready(timeout) {
        budgets.push(timeout);
        now += 10_000;
        return true;
      },
      async dispatch(timeout) {
        budgets.push(timeout);
        return { runId: 'exact-run' };
      },
      report() {},
      async sleep() {
        assert.fail('no retry');
      },
    });
    assert.deepEqual(budgets, [180_000, 135_000, 125_000]);
  });

  it('should not start a dependent observation or replay a refresh after its deadline', async () => {
    let now = 0;
    let calls = 0;
    await assert.rejects(
      refreshNotifications({
        timeoutMs: 180_000,
        now: () => now,
        request() {
          calls++;
          now = 180_000;
          return completed;
        },
        ready() {
          assert.fail('expired');
        },
        async dispatch() {
          assert.fail('expired');
        },
        report() {},
        async sleep() {
          assert.fail('expired');
        },
      }),
      /timed out/,
    );
    assert.equal(calls, 1);
  });

  it('should leave process startup and cleanup room beyond the explicit native timeout', () => {
    let watchdog = 0;
    notificationCli(
      ['agent-system', 'notifications', 'refresh', '--timeout', '180', '--json'],
      180_000,
      false,
      ((_command: string, argv: string[], options: { timeout: number }) => {
        assert.ok(argv.includes('180'));
        watchdog = options.timeout;
        return { status: 0, stdout: JSON.stringify(completed), stderr: '' };
      }) as typeof spawnSync,
    );
    assert.ok(watchdog > 180_000);
  });
});
