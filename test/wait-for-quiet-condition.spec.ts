import assert from 'node:assert/strict';

import { waitForQuietCondition } from '../examples/openclaw-notifications-scheduling/wait-condition.mjs';

const quiet = {
  lastTriggerEvalAtMs: 2000,
  triggerState: { status: 'ready', outcome: 'unchanged', more: false },
};

describe('examples/openclaw-notifications-scheduling/wait-condition', () => {
  it('should observe the due-time quiet condition without submitting a payload', async () => {
    let now = 1000;
    let reads = 0;
    await waitForQuietCondition('native', 2000, {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      run: ((command: string, args: string[]) => {
        assert.equal(command, 'openclaw');
        assert.deepEqual(args, ['cron', 'get', 'native', '--json']);
        reads++;
        return {
          status: 0,
          stdout: JSON.stringify({
            id: 'native',
            state: reads === 1 ? { ...quiet, lastTriggerEvalAtMs: 1999 } : quiet,
          }),
        };
      }) as never,
      report: () => assert.fail('successful observation must not report failure'),
    });
    assert.equal(reads, 2);
  });

  it('should retain missing or failed condition evidence without hiding the failed assertion', async () => {
    for (const state of [
      { lastTriggerEvalAtMs: 2000, lastRunStatus: 'error' },
      {
        ...quiet,
        triggerState: {
          status: 'ready',
          outcome: 'failed',
          more: true,
          code: 'dispatch-check-budget-exhausted',
          diagnostic: { phase: 'assignment-search', elapsedMs: 20000 },
        },
      },
      { ...quiet, lastTriggerFireAtMs: 2000 },
    ]) {
      const reports: unknown[] = [];
      await assert.rejects(
        waitForQuietCondition('native', 2000, {
          now: () => 2000,
          run: (() => ({
            status: 0,
            stdout: JSON.stringify({ id: 'native', state, payload: 'must not be retained' }),
          })) as never,
          report: (
            nativeId: string,
            runId: string | undefined,
            options: { evidence?: string[] } = {},
          ) => reports.push({ nativeId, runId, evidence: options.evidence }),
        }),
        assert.AssertionError,
      );
      assert.equal(reports.length, 1);
      const report = reports[0] as { nativeId: string; runId?: string; evidence: string[] };
      assert.equal(report.nativeId, 'native');
      assert.equal(report.runId, undefined);
      const observation = JSON.parse(report.evidence[0]!.split(': ').slice(1).join(': '));
      assert.deepEqual(observation, { due: 2000, state });
      assert.ok(!JSON.stringify(reports).includes('must not be retained'));
    }
  });

  it('should bound missing evaluations and report the last observation', async () => {
    let now = 121000;
    let reported = false;
    await assert.rejects(
      waitForQuietCondition('native', 2000, {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
        run: (() => ({
          status: 0,
          stdout: JSON.stringify({ id: 'native', state: {} }),
        })) as never,
        report: () => {
          reported = true;
        },
      }),
      /observation deadline/,
    );
    assert.equal(now, 122000);
    assert.equal(reported, true);
  });
});
