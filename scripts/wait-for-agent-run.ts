import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** a wait timeout is an observation, not a completed or cancelled agent run. */
export default async function waitForAgentRun(input: {
  runId: string;
  timeoutMs: number;
  request(timeoutMs: number): unknown;
  report(receipt: unknown): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}): Promise<void> {
  assert.ok(input.runId.trim(), 'a native run id is required');
  assert.ok(Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0, 'invalid wait deadline');
  const deadline = input.now() + input.timeoutMs;
  while (input.now() < deadline) {
    const receipt = input.request(Math.min(30_000, deadline - input.now()));
    input.report(receipt);
    assert.ok(receipt && typeof receipt === 'object', 'invalid agent wait receipt');
    const result = receipt as Record<string, unknown>;
    assert.equal(result.runId, input.runId, 'agent wait returned a different run');
    if (result.status === 'ok') return;
    assert.ok(
      (result.status === 'timeout' || result.status === 'pending') &&
        result.endedAt === undefined &&
        result.stopReason === undefined &&
        result.error === undefined &&
        result.summary === undefined &&
        result.terminalReceipt === undefined,
      'native run failed; inspect the agent wait receipt above',
    );
    await input.sleep(Math.min(2000, Math.max(0, deadline - input.now())));
  }
  throw new Error(`${input.runId}: wait deadline exceeded; the native run may still be active`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions only.');
  const [runId = '', timeout = '300000'] = process.argv.slice(2);
  await waitForAgentRun({
    runId,
    timeoutMs: Number(timeout),
    request(timeoutMs) {
      const result = spawnSync(
        'openclaw',
        [
          'gateway',
          'call',
          'agent.wait',
          '--params',
          JSON.stringify({ runId, timeoutMs }),
          '--timeout',
          String(timeoutMs + 5000),
          '--json',
        ],
        { encoding: 'utf8', timeout: timeoutMs + 10000 },
      );
      assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    },
    report: (receipt) => process.stdout.write(JSON.stringify(receipt) + '\n'),
    sleep: setTimeout,
    now: Date.now,
  });
}
