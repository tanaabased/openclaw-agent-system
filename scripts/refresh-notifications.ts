import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** wait only for scheduler contention; other refresh outcomes stop the scenario. */
export default async function refreshNotifications(input: {
  request(timeoutMs: number): unknown;
  report(receipt: unknown): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  timeoutMs: number;
}): Promise<string> {
  const deadline = input.now() + input.timeoutMs;
  while (true) {
    const remainingMs = deadline - input.now();
    if (remainingMs <= 0) break;
    const receipt = input.request(Math.min(30_000, remainingMs));
    input.report(receipt);
    assert.ok(receipt && typeof receipt === 'object', 'invalid notification refresh receipt');
    const result = receipt as Record<string, unknown>;
    if (result.status === 'queued') {
      assert.ok(
        typeof result.runId === 'string' && result.runId.trim(),
        'queued notification refresh requires a native run id',
      );
      return result.runId;
    }
    assert.ok(
      result.status === 'skipped' && result.code === 'github-notification-refresh-already-running',
      'notification refresh failed; inspect the receipt above',
    );
    await input.sleep(Math.min(2000, Math.max(0, deadline - input.now())));
  }
  throw new Error('notification refresh timed out waiting for the active native run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions only.');
  const runId = await refreshNotifications({
    request(timeoutMs) {
      const result = spawnSync('openclaw', ['agent-system', 'notifications', 'refresh', '--json'], {
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    },
    report: (receipt) => process.stderr.write(JSON.stringify(receipt) + '\n'),
    sleep: setTimeout,
    now: Date.now,
    timeoutMs: 180_000,
  });
  process.stdout.write(runId + '\n');
}
