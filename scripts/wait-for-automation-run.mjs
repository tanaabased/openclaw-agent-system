import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub Actions only.');
const [id, runId] = process.argv.slice(2);
assert.ok(id && runId, 'an automation id and native run id are required');

for (let attempt = 0; attempt < 90; attempt++) {
  const result = spawnSync(
    'openclaw',
    ['agent-system', 'automations', 'runs', id, '--run-id', runId, '--limit', '1', '--json'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const page = JSON.parse(result.stdout);
  const entry = page.entries[0];
  if (entry) {
    assert.equal(entry.runId, runId);
    assert.equal(entry.execution, 'ok', `${id}: native execution failed`);
    process.stdout.write(`${id}: native run completed\n`);
    process.exit(0);
  }
  await setTimeout(2000);
}
throw new Error(`${id}: the exact native run did not finish`);
