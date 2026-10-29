import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub Actions only.');
const [jobId, runId] = process.argv.slice(2);
assert.ok(jobId && runId);

function command(args) {
  const result = spawnSync('openclaw', args, {
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  // dashboard and browser responses may contain a one-time pairing URL; never print them.
  assert.equal(result.status, 0, `native ${args[0]} command failed`);
  return JSON.parse(result.stdout);
}

const browser = (args) => command(['browser', '--json', ...args]);
const dashboard = command(['dashboard', '--json']);
const url = new URL(dashboard.browserUrl);
url.pathname = `${url.pathname.replace(/\/$/u, '')}/cron`;
url.searchParams.set('job', jobId);
url.searchParams.set('run', runId);
const tab = browser(['open', url.href]);
assert.ok(typeof tab.targetId === 'string');
const target = ['--target-id', tab.targetId];
const visibleRun = `() => {
  const entry = document.querySelector('.cron-run-entry--highlighted');
  return Boolean(entry && entry.getClientRects().length &&
    entry.innerText.includes('stdout-fixture-marker') &&
    entry.innerText.includes('stderr-fixture-marker'));
}`;

for (const reload of [false, true]) {
  if (reload) {
    url.hash = '';
    browser(['navigate', url.href, ...target]);
  }
  browser(['wait', '--fn', visibleRun, '--timeout-ms', '60000', ...target]);
  const observed = browser([
    'evaluate',
    '--fn',
    `() => document.querySelector('.cron-run-entry--highlighted').innerText`,
    ...target,
  ]);
  assert.equal(typeof observed.result, 'string');
  assert.ok(observed.result.includes('stdout-fixture-marker'));
  assert.ok(observed.result.includes('stderr-fixture-marker'));
  assert.match(observed.result, /(?:exitCode["\s:]*17|code 17)/u);
  assert.match(observed.result, /error|failed/iu);
}
process.stdout.write(`verified rendered output after reload for native run ${runId}\n`);
