import assert from 'node:assert/strict';

import refreshNotifications from '../scripts/refresh-notifications.ts';

const busy = { status: 'skipped', code: 'github-notification-refresh-already-running' };
const queued = {
  status: 'queued',
  code: 'github-notification-refresh-queued',
  runId: 'native-run',
};

function fixture(receipts: unknown[], timeoutMs = 5000) {
  let now = 0;
  const reports: unknown[] = [];
  const timeouts: number[] = [];
  const sleeps: number[] = [];
  return {
    reports,
    timeouts,
    sleeps,
    run: () =>
      refreshNotifications({
        request(timeout) {
          timeouts.push(timeout);
          return receipts.shift();
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
  it('should preserve contention receipts and return only the newly queued native run', async () => {
    const f = fixture([busy, queued]);
    assert.equal(await f.run(), 'native-run');
    assert.deepEqual(f.reports, [busy, queued]);
    assert.deepEqual(f.sleeps, [2000]);
    assert.deepEqual(f.timeouts, [5000, 3000]);
  });

  it('should time out repeated contention within the remaining deadline', async () => {
    const f = fixture([busy, busy], 2500);
    await assert.rejects(f.run(), /timed out/);
    assert.deepEqual(f.timeouts, [2500, 500]);
    assert.deepEqual(f.sleeps, [2000, 500]);
    assert.deepEqual(f.reports, [busy, busy]);
  });

  it('should preserve and reject failed skipped or incomplete receipts without retrying', async () => {
    for (const receipt of [
      { status: 'failed', code: 'automation-gateway-unavailable' },
      { status: 'skipped', code: 'github-notification-refresh-disabled' },
      { status: 'failed', code: busy.code },
      { status: 'queued' },
      { status: 'queued', runId: ' ' },
      undefined,
    ]) {
      const f = fixture([receipt]);
      await assert.rejects(f.run());
      assert.deepEqual(f.reports, [receipt]);
      assert.deepEqual(f.timeouts, [5000]);
      assert.deepEqual(f.sleeps, []);
    }
  });
});
