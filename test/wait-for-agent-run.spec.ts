import assert from 'node:assert/strict';

import waitForAgentRun from '../scripts/wait-for-agent-run.ts';

function fixture(receipts: unknown[], timeoutMs = 5000) {
  let now = 0;
  const reports: unknown[] = [];
  const timeouts: number[] = [];
  return {
    reports,
    timeouts,
    run: () =>
      waitForAgentRun({
        runId: 'publish',
        timeoutMs,
        request(timeout) {
          timeouts.push(timeout);
          return receipts.shift();
        },
        report: (receipt) => reports.push(receipt),
        async sleep(ms) {
          now += ms;
        },
        now: () => now,
      }),
  };
}

describe('scripts/wait-for-agent-run', () => {
  it('should keep waiting after observation timeouts and preserve the terminal receipt', async () => {
    const receipts = [
      { runId: 'publish', status: 'pending' },
      { runId: 'publish', status: 'timeout' },
      { runId: 'publish', status: 'ok', endedAt: 123 },
    ];
    const f = fixture([...receipts]);
    await f.run();
    assert.deepEqual(f.reports, receipts);
    assert.deepEqual(f.timeouts, [5000, 3000, 1000]);
  });

  it('should bound unfinished runs without claiming completion or cancellation', async () => {
    const pending = { runId: 'publish', status: 'timeout' };
    const f = fixture([pending, pending], 2500);
    await assert.rejects(f.run(), /native run may still be active/);
    assert.deepEqual(f.timeouts, [2500, 500]);
    assert.deepEqual(f.reports, [pending, pending]);
  });

  it('should stop on terminal errors cancellations malformed receipts or a different run', async () => {
    for (const receipt of [
      { runId: 'publish', status: 'error', error: 'provider failed' },
      { runId: 'publish', status: 'timeout', endedAt: 123 },
      { runId: 'publish', status: 'timeout', summary: 'aborted' },
      { runId: 'publish', status: 'timeout', stopReason: 'cancelled' },
      { runId: 'other', status: 'ok' },
      { runId: 'publish', status: 'unknown' },
      undefined,
    ]) {
      const f = fixture([receipt]);
      await assert.rejects(f.run());
      assert.deepEqual(f.reports, [receipt]);
      assert.equal(f.timeouts.length, 1);
    }
  });
});
