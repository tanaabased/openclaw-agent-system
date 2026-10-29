import assert from 'node:assert/strict';

import {
  assertAutomationRun,
  reportAutomationFailure,
} from '../scripts/wait-for-automation-run.mjs';

describe('scripts/wait-for-automation-run', () => {
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
