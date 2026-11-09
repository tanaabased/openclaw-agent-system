import assert from 'node:assert/strict';

import waitForAgentRun, { reportNativeRunDiagnostics } from '../scripts/wait-for-agent-run.ts';

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
  it('should retain native startup errors and log truncation information before any model request', async () => {
    const reports: unknown[] = [];
    const nativeLogs = {
      lines: ['startup failed: session storage unavailable; credential=[REDACTED]'],
      truncated: true,
      cursor: 1024,
    };
    await reportNativeRunDiagnostics('startup-run', {
      async request(method, params) {
        assert.equal(method, 'logs.tail');
        assert.deepEqual(params, {});
        return nativeLogs;
      },
      report: (value) => reports.push(value),
    });
    assert.deepEqual(reports, [
      { runId: 'startup-run', nativeLogs: { truncated: true, cursor: 1024 } },
      { runId: 'startup-run', nativeLogLine: nativeLogs.lines[0] },
    ]);
  });

  it('should report unavailable native logs without replacing the original run failure', async () => {
    const reports: unknown[] = [];
    const original = new Error('native startup failed');
    await assert.rejects(
      async () => {
        try {
          throw original;
        } catch (error) {
          await reportNativeRunDiagnostics('startup-run', {
            async request() {
              throw new Error('gateway unavailable');
            },
            report: (value) => reports.push(value),
          });
          throw error;
        }
      },
      (error) => error === original,
    );
    assert.deepEqual(reports, [{ runId: 'startup-run', nativeLogsUnavailable: true }]);
  });

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

describe('extended ci agent-run observation', () => {
  it('should observe exact native work completing after five minutes without extending native polls', async () => {
    let now = 0;
    const runId = 'late-native-run';
    const budgets: number[] = [];
    await waitForAgentRun({
      runId,
      timeoutMs: 600_000,
      now: () => now,
      request(timeout) {
        budgets.push(timeout);
        now += timeout;
        return { runId, status: now > 300_000 ? 'ok' : 'timeout' };
      },
      report() {},
      async sleep(ms) {
        now += ms;
      },
    });
    assert.ok(now > 300_000 && now < 600_000);
    assert.ok(budgets.every((budget) => budget <= 30_000));
  });
});
