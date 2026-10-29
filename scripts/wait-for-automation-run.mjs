import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

function runCommand(command, args, input, timeoutMs = 30_000) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024,
    input,
  });
}

/**
 * collect ci-only failure evidence without changing the failed run's outcome.
 * @param {string} nativeId
 * @param {string} runId
 * @param {{run?: (command: string, args: string[], input?: string) => {status: number | null, stdout: string}, write?: (text: string) => void}} options
 */
export function reportAutomationFailure(
  nativeId,
  runId,
  { run = runCommand, write = (text) => process.stderr.write(text) } = {},
) {
  const evidence = [];
  try {
    assert.ok(typeof nativeId === 'string' && nativeId.trim());
    const result = run('openclaw', [
      'gateway',
      'call',
      'cron.runs',
      '--params',
      JSON.stringify({ id: nativeId, runId, limit: 1, offset: 0 }),
      '--json',
    ]);
    assert.equal(result.status, 0);
    const page = JSON.parse(result.stdout);
    const entry = page.entries?.find((item) => item.jobId === nativeId && item.runId === runId);
    assert.ok(entry, 'the exact native record is unavailable');
    evidence.push(
      'native cron failure: ' +
        JSON.stringify({
          ts: entry.ts,
          jobId: entry.jobId,
          runId: entry.runId,
          status: entry.status,
          completionStatus: entry.completionStatus,
          error: entry.error,
          errorReason: entry.errorReason,
          diagnostics: entry.diagnostics,
          durationMs: entry.durationMs,
          deliveryError: entry.deliveryError,
        }),
    );
  } catch {
    evidence.push('native cron failure: exact record lookup failed; no substitute run used');
  }
  try {
    const log = run('openclaw-gateway', ['log-path']);
    assert.equal(log.status, 0);
    const tail = run('tail', ['-n', '120', log.stdout.trim()]);
    assert.equal(tail.status, 0);
    evidence.push('gateway diagnostic tail:\n' + tail.stdout);
  } catch {
    evidence.push('gateway diagnostic tail: unavailable');
  }
  // never print raw provider errors or logs if the ci redactor is unavailable.
  try {
    const helper = run('/bin/sh', ['-c', 'command -v openclaw-gateway']);
    assert.equal(helper.status, 0);
    const redactor = join(dirname(helper.stdout.trim()), 'lib', 'redact-stream.mjs');
    const redacted = run(process.execPath, [redactor], evidence.join('\n'));
    assert.equal(redacted.status, 0);
    write(redacted.stdout.slice(0, 16_000) + '\n');
    if (redacted.stdout.length > 16_000) write('[automation diagnostics truncated]\n');
  } catch {
    write('automation diagnostics withheld: CI redactor unavailable\n');
  }
}

export function assertAutomationRun(
  page,
  runId,
  id,
  report = reportAutomationFailure,
  expected = 'ok',
) {
  const entry = page.entries[0];
  if (!entry) return false;
  assert.equal(entry.runId, runId);
  if (entry.execution !== expected) report(page.nativeId, runId);
  assert.equal(entry.execution, expected, `${id}: native execution failed`);
  return true;
}

/** require the intended command failure before inspecting its retained output. */
export function assertFailedCommandRun(
  page,
  nativeId,
  runId,
  exitCode,
  report = reportAutomationFailure,
) {
  try {
    const entry = page.entries?.find((item) => item.jobId === nativeId && item.runId === runId);
    assert.ok(entry, 'the exact failed command record is unavailable');
    assert.equal(entry.status, 'error');
    assert.ok(
      entry.diagnostics?.entries?.some((item) => item.exitCode === exitCode),
      `expected command exit ${exitCode}; scheduler failure is not command execution proof`,
    );
    assert.ok(
      typeof entry.summary === 'string' && entry.summary.length > 0,
      'the failed command has no retained output summary',
    );
  } catch (error) {
    report(nativeId, runId);
    throw error;
  }
}

/** poll only the accepted run; a timed-out read never resubmits its execution. */
export async function waitForAutomationRun(
  id,
  runId,
  expected = 'ok',
  {
    run = runCommand,
    now = Date.now,
    sleep = (ms) => setTimeout(ms),
    report = reportAutomationFailure,
    maxWaitMs = 600_000,
  } = {},
) {
  const deadline = now() + maxWaitMs;
  let nativeId;
  let timedOutReads = 0;
  try {
    while (true) {
      const readBudget = Math.min(30_000, deadline - now());
      if (readBudget <= 0) break;
      const result = run(
        'openclaw',
        ['agent-system', 'automations', 'runs', id, '--run-id', runId, '--limit', '1', '--json'],
        undefined,
        readBudget,
      );
      if (result.error?.code === 'ETIMEDOUT') {
        timedOutReads++;
      } else {
        assert.equal(result.status, 0, result.error?.message ?? result.stderr);
        const page = JSON.parse(result.stdout);
        nativeId = page.nativeId;
        if (assertAutomationRun(page, runId, id, () => {}, expected)) return;
      }
      const remaining = deadline - now();
      if (remaining > 0) await sleep(Math.min(2000, remaining));
    }
    throw new Error(
      `${id}: the exact native run did not finish within ${maxWaitMs}ms (${timedOutReads} status reads timed out)`,
    );
  } catch (error) {
    report(nativeId, runId);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub Actions only.');
  const [id, runId, expected = 'ok'] = process.argv.slice(2);
  assert.ok(id && runId, 'an automation id and native run id are required');
  assert.ok(['ok', 'error'].includes(expected), 'expected execution must be ok or error');
  await waitForAutomationRun(id, runId, expected);
  process.stdout.write(`${id}: native run completed\n`);
}
