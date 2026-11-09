import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub Actions only.');
const [nativeId, dueText] = process.argv.slice(2);
const due = Number(dueText);
assert.ok(nativeId && Number.isSafeInteger(due) && due > 0);
const deadline = due + 120_000;
let observed = false;
while (Date.now() < deadline) {
  const result = spawnSync('openclaw', ['cron', 'get', nativeId, '--json'], {
    encoding: 'utf8',
    timeout: Math.min(10_000, deadline - Date.now()),
  });
  assert.equal(result.status, 0, 'native condition observation failed');
  const job = JSON.parse(result.stdout);
  assert.equal(job.id, nativeId);
  if ((job.state.lastTriggerEvalAtMs ?? 0) >= due) {
    assert.equal(job.state.triggerState?.status, 'ready');
    assert.equal(job.state.triggerState?.outcome, 'unchanged');
    assert.equal(job.state.triggerState?.more, false);
    assert.equal(job.state.triggerState?.code, undefined);
    assert.ok(
      (job.state.lastTriggerFireAtMs ?? 0) < due,
      'quiet condition must not start the payload',
    );
    observed = true;
    break;
  }
  await setTimeout(Math.min(2000, Math.max(0, deadline - Date.now())));
}
assert.ok(observed, 'scheduled condition did not finish before the observation deadline');
process.stdout.write('Scheduled condition completed quietly; no payload started.\n');
