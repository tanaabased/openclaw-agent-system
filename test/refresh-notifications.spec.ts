import assert from 'node:assert/strict';

import refreshNotifications from '../scripts/refresh-notifications.ts';

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
