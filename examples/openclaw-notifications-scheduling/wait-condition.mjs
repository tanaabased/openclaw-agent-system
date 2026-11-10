import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { reportAutomationFailure } from '../../scripts/wait-for-automation-run.mjs';

/** observe the exact due-time condition; retain redacted evidence before cleanup on failure. */
export async function waitForQuietCondition(
  nativeId,
  due,
  {
    run = spawnSync,
    now = Date.now,
    sleep = (ms) => setTimeout(ms),
    report = reportAutomationFailure,
  } = {},
) {
  assert.ok(nativeId && Number.isSafeInteger(due) && due > 0);
  const deadline = due + 120_000;
  let observation;
  try {
    while (now() < deadline) {
      const readBudget = Math.min(10_000, deadline - now());
      if (readBudget <= 0) break;
      const result = run('openclaw', ['cron', 'get', nativeId, '--json'], {
        encoding: 'utf8',
        timeout: readBudget,
      });
      assert.equal(result.status, 0, 'native condition observation failed');
      const job = JSON.parse(result.stdout);
      assert.equal(job.id, nativeId);
      const state = job.state;
      assert.ok(state && typeof state === 'object', 'native condition state is invalid');
      observation = {
        lastTriggerEvalAtMs: state.lastTriggerEvalAtMs,
        lastTriggerFireAtMs: state.lastTriggerFireAtMs,
        triggerState: state.triggerState,
        lastRunStatus: state.lastRunStatus,
        lastErrorReason: state.lastErrorReason,
      };
      if ((state.lastTriggerEvalAtMs ?? 0) >= due) {
        assert.equal(state.triggerState?.status, 'ready');
        assert.equal(state.triggerState?.outcome, 'unchanged');
        assert.equal(state.triggerState?.more, false);
        assert.equal(state.triggerState?.code, undefined);
        assert.ok(
          (state.lastTriggerFireAtMs ?? 0) < due,
          'quiet condition must not start the payload',
        );
        return;
      }
      await sleep(Math.min(2000, Math.max(0, deadline - now())));
    }
    throw new Error('scheduled condition did not finish before the observation deadline');
  } catch (error) {
    report(nativeId, undefined, {
      evidence: ['scheduled condition observation: ' + JSON.stringify({ due, state: observation })],
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub Actions only.');
  const [nativeId, dueText] = process.argv.slice(2);
  await waitForQuietCondition(nativeId, Number(dueText));
  process.stdout.write('Scheduled condition completed quietly; no payload started.\n');
}
