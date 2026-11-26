import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { notificationCli } from '../../scripts/refresh-notifications.ts';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions only.');
const [number, state] = process.argv.slice(2);
assert.match(number ?? '', /^[1-9]\d*$/u);
assert.ok(state === 'CHANGES_REQUESTED' || state === 'APPROVED');
const job = 'github-review-request';
const route = 'repos/tanaabased/big-test-bucket/pulls/' + number;
const deadline = Date.now() + 600_000;
const remaining = () => Math.max(1, deadline - Date.now());
const gh = (...args: string[]) =>
  notificationCli(['agent-system', 'tool', 'gh', '--', ...args], remaining());
const head = gh('api', route).head.sha;
while (Date.now() < deadline) {
  const reviews = gh('api', route + '/reviews').filter(
    (review: { user: { login: string }; commit_id: string; state: string }) =>
      review.user.login === 'emoriwan' && review.commit_id === head && review.state === state,
  );
  if (reviews.length) {
    assert.equal(reviews.length, 1, 'one formal review per head');
    process.stdout.write(JSON.stringify(reviews[0]) + '\n');
    break;
  }
  const run = notificationCli(['agent-system', 'automations', 'run', job, '--json'], remaining());
  assert.equal(run.status, 'queued');
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../scripts/wait-for-automation-run.mjs', import.meta.url)),
      job,
      run.runId,
    ],
    { timeout: remaining(), stdio: ['ignore', 2, 2] },
  );
  await setTimeout(Math.min(5000, remaining()));
}
assert.ok(Date.now() < deadline, 'timed out waiting for the reviewer on ' + head);
