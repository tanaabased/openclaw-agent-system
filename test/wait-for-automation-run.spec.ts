import assert from 'node:assert/strict';

import {
  assertAutomationRun,
  assertFailedCommandRun,
  waitForAutomationRun,
  reportAutomationFailure,
} from '../scripts/wait-for-automation-run.mjs';

describe('scripts/wait-for-automation-run', () => {
  it('should retry timed-out status reads for the same run without submitting work', async () => {
    let elapsed = 0;
    const calls: string[][] = [];
    await waitForAutomationRun('maintenance', 'run-1', 'ok', {
      now: () => elapsed,
      sleep: async (ms: number) => {
        elapsed += ms;
      },
      run: ((_command: string, args: string[], _input: unknown, timeout: number) => {
        calls.push(args);
        assert.equal(timeout, 30_000);
        if (calls.length === 1) {
          elapsed += timeout;
          return { status: null, error: { code: 'ETIMEDOUT' } };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            nativeId: 'job-1',
            entries: calls.length === 2 ? [] : [{ runId: 'run-1', execution: 'ok' }],
          }),
        };
      }) as never,
      report: () => assert.fail('successful polling should not report a failure'),
    });
    assert.equal(calls.length, 3);
    assert.ok(calls.every((args) => args[2] === 'runs' && args[5] === 'run-1'));
  });

  it('should bound status reads by one deadline and diagnose exhaustion without retrying work', async () => {
    let elapsed = 0;
    const timeouts: number[] = [];
    const reports: unknown[] = [];
    await assert.rejects(
      waitForAutomationRun('maintenance', 'run-1', 'ok', {
        maxWaitMs: 35_000,
        now: () => elapsed,
        sleep: async (ms: number) => {
          elapsed += ms;
        },
        run: ((_command: string, _args: string[], _input: unknown, timeout: number) => {
          timeouts.push(timeout);
          elapsed += timeout;
          return { status: null, error: { code: 'ETIMEDOUT' } };
        }) as never,
        report: (nativeId: string, runId: string) => {
          reports.push({ nativeId, runId });
        },
      }),
      /2 status reads timed out/,
    );
    assert.deepEqual(timeouts, [30_000, 3000]);
    assert.equal(elapsed, 35_000);
    assert.deepEqual(reports, [{ nativeId: undefined, runId: 'run-1' }]);
  });

  it('should stop polling on a command error, malformed response, wrong run or failed execution', async () => {
    for (const result of [
      { status: 1, stderr: 'permission denied' },
      { status: null, error: { code: 'ENOENT', message: 'missing executable' } },
      { status: 0, stdout: 'not json' },
      { status: 0, stdout: JSON.stringify({ entries: [{ runId: 'other', execution: 'ok' }] }) },
      { status: 0, stdout: JSON.stringify({ entries: [{ runId: 'run-1', execution: 'error' }] }) },
    ]) {
      let calls = 0;
      let reports = 0;
      await assert.rejects(
        waitForAutomationRun('maintenance', 'run-1', 'ok', {
          run: (() => {
            calls++;
            return result;
          }) as never,
          sleep: async () => assert.fail('terminal failures must not poll again'),
          report: () => {
            reports++;
          },
        }),
      );
      assert.equal(calls, 1);
      assert.equal(reports, 1);
    }
  });

  it('should distinguish the intended command exit from a scheduler error or missing output', () => {
    const entry = {
      jobId: 'job-1',
      runId: 'run-1',
      status: 'error',
      summary: 'retained output',
      diagnostics: { entries: [{ exitCode: 17 }] },
    };
    assertFailedCommandRun({ entries: [entry] }, 'job-1', 'run-1', 17, () =>
      assert.fail('verified command failure needs no diagnostic'),
    );
    for (const changed of [
      { ...entry, jobId: 'other' },
      { ...entry, runId: 'other' },
      { ...entry, status: 'ok' },
      { ...entry, summary: null },
      { ...entry, diagnostics: { entries: [{ exitCode: 1 }] } },
      { ...entry, diagnostics: undefined, error: 'SQLite host admission timed out' },
    ]) {
      const reports: unknown[] = [];
      assert.throws(() =>
        assertFailedCommandRun(
          { entries: [changed] },
          'job-1',
          'run-1',
          17,
          (nativeId: string, runId: string) => reports.push({ nativeId, runId }),
        ),
      );
      assert.deepEqual(reports, [{ nativeId: 'job-1', runId: 'run-1' }]);
    }
  });

  it('should require the exact expected failure without accepting success or another run', () => {
    const page = { entries: [{ runId: 'requested-run', execution: 'error' }] };
    assert.equal(
      assertAutomationRun(
        page,
        'requested-run',
        'failure',
        () => assert.fail('unexpected diagnostic'),
        'error',
      ),
      true,
    );
    assert.throws(() => assertAutomationRun(page, 'another-run', 'failure', () => {}, 'error'));
    assert.throws(() =>
      assertAutomationRun(
        { entries: [{ runId: 'requested-run', execution: 'ok' }] },
        'requested-run',
        'failure',
        () => {},
        'error',
      ),
    );
  });
  it('should diagnose the exact failed run before preserving the execution assertion', () => {
    const reports: unknown[] = [];
    const report = (nativeId: string, runId: string) => reports.push({ nativeId, runId });
    const page = {
      nativeId: 'native-job',
      entries: [{ runId: 'requested-run', execution: 'error' }],
    };
    assert.throws(
      () => assertAutomationRun(page, 'requested-run', 'identity', report),
      /native execution failed/,
    );
    assert.deepEqual(reports, [{ nativeId: 'native-job', runId: 'requested-run' }]);
    assert.equal(assertAutomationRun({ entries: [] }, 'requested-run', 'identity', report), false);
    assert.equal(
      assertAutomationRun(
        { entries: [{ runId: 'requested-run', execution: 'ok' }] },
        'requested-run',
        'identity',
        report,
      ),
      true,
    );
    assert.throws(() => assertAutomationRun(page, 'different-run', 'identity', report));
    assert.equal(reports.length, 1);
  });

  it('should fetch native error evidence by job and run and redact all emitted diagnostics', () => {
    const calls: { command: string; args: string[] }[] = [];
    const output: string[] = [];
    const entry = {
      jobId: 'native-job',
      runId: 'requested-run',
      status: 'error',
      error: 'command failed: sensitive-value',
      diagnostics: { phase: 'execute', detail: 'sensitive-value' },
      summary: 'model output must not be included',
    };
    reportAutomationFailure('native-job', 'requested-run', {
      run(command: string, args: string[], input?: string) {
        calls.push({ command, args });
        let stdout;
        if (command === 'openclaw') {
          assert.equal(args[2], 'cron.runs');
          assert.deepEqual(JSON.parse(args[4]!), {
            id: 'native-job',
            runId: 'requested-run',
            limit: 1,
            offset: 0,
          });
          stdout = JSON.stringify({ entries: [entry] });
        } else if (command === 'openclaw-gateway') stdout = '/tmp/gateway.log\n';
        else if (command === 'tail') stdout = 'gateway command failure: sensitive-value';
        else if (command === '/bin/sh') stdout = '/ci/helpers/openclaw-gateway\n';
        else {
          assert.equal(command, process.execPath);
          assert.deepEqual(args, ['/ci/helpers/lib/redact-stream.mjs']);
          assert.ok(input?.includes('command failed: sensitive-value'));
          assert.ok(input?.includes('gateway command failure: sensitive-value'));
          assert.ok(!input?.includes(entry.summary));
          stdout = input!.replaceAll('sensitive-value', '[REDACTED]');
        }
        return { status: 0, stdout };
      },
      write: (text: string) => output.push(text),
    });
    assert.equal(calls.filter(({ command }) => command === 'openclaw').length, 1);
    assert.ok(output.join('').includes('command failed: [REDACTED]'));
    assert.ok(output.join('').includes('gateway command failure: [REDACTED]'));
    assert.ok(!output.join('').includes('sensitive-value'));
  });

  it('should never substitute a different run or leak raw output when redaction fails', () => {
    for (const redactionFails of [false, true]) {
      const output: string[] = [];
      reportAutomationFailure('native-job', 'requested-run', {
        run(command: string, _args: string[], input?: string) {
          if (command === 'openclaw')
            return {
              status: 0,
              stdout: JSON.stringify({
                entries: [{ jobId: 'native-job', runId: 'other-run', error: 'secret' }],
              }),
            };
          if (command === '/bin/sh') return { status: 0, stdout: '/ci/openclaw-gateway' };
          if (command === process.execPath)
            return { status: redactionFails ? 1 : 0, stdout: input ?? '' };
          return { status: 1, stdout: 'secret' };
        },
        write: (text: string) => output.push(text),
      });
      assert.ok(!output.join('').includes('secret'));
      assert.ok(output.join('').includes(redactionFails ? 'withheld' : 'no substitute run'));
    }
  });

  it('should bound diagnostic output after redaction', () => {
    const output: string[] = [];
    reportAutomationFailure('native-job', 'requested-run', {
      run(command: string) {
        return { status: 0, stdout: command === process.execPath ? 'x'.repeat(20_000) : '' };
      },
      write: (text: string) => output.push(text),
    });
    assert.ok(output.join('').length < 16_100);
    assert.ok(output.join('').includes('truncated'));
  });
});
