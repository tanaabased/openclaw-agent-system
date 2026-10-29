import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

function runCommand(command, args, input) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub Actions only.');
  const [id, runId, expected = 'ok'] = process.argv.slice(2);
  assert.ok(id && runId, 'an automation id and native run id are required');
  assert.ok(['ok', 'error'].includes(expected), 'expected execution must be ok or error');

  for (let attempt = 0; attempt < 90; attempt++) {
    const result = runCommand('openclaw', [
      'agent-system',
      'automations',
      'runs',
      id,
      '--run-id',
      runId,
      '--limit',
      '1',
      '--json',
    ]);
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    if (
      assertAutomationRun(JSON.parse(result.stdout), runId, id, reportAutomationFailure, expected)
    ) {
      process.stdout.write(`${id}: native run completed\n`);
      process.exit(0);
    }
    await setTimeout(2000);
  }
  throw new Error(`${id}: the exact native run did not finish`);
}
