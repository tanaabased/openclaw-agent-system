import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ci-only bounded observation through public gateway rpc; no private scheduler reads.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub Actions only.');
const [action, id] = process.argv.slice(2);
async function rpc(method: string, params: object) {
  const child = Bun.spawn(
    ['openclaw', 'gateway', 'call', method, '--params', JSON.stringify(params), '--json'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Gateway inspection failed: ${errors.slice(-1000)}`);
  return JSON.parse(output);
}
if (action === 'wait') {
  for (let attempt = 0; attempt < 90; attempt++) {
    const page = await rpc('cron.list', { includeDisabled: true, limit: 200 });
    const job = page.jobs.find((entry: { name: string }) => entry.name === `Agent System: ${id}`);
    if (job?.state?.lastRunAtMs && !job.state.runningAtMs) {
      const expected = ['policy', 'missing', 'timeout', 'cancel', 'stale', 'disabled'].includes(id!)
        ? 'error'
        : 'ok';
      assert.equal(job.state.lastRunStatus, expected);
      process.stdout.write(`${id}: ${expected}\n`);
      process.exit(0);
    }
    await Bun.sleep(2000);
  }
  throw new Error('Scheduled occurrence did not finish before the observation deadline.');
} else if (action === 'cleanup') {
  const workspace = join(process.env.TMPDIR!, 'automation-agent');
  const authority = (await readFile(join(workspace, `${id}.authority`), 'utf8')).trim();
  assert.match(authority, /^[a-f0-9]+$/u);
  const { homedir } = await import('node:os');
  await assert.rejects(
    lstat(join(homedir(), '.config/tanaab/agent-system/runtime', `${authority}.sock`)),
    { code: 'ENOENT' },
  );
  if (id === 'timeout' || id === 'cancel') {
    const socket = (
      await readFile(join(process.env.TMPDIR!, 'automation-ssh.socket'), 'utf8')
    ).trim();
    await assert.rejects(lstat(socket), { code: 'ENOENT' });
    const pid = Number(
      (await readFile(join(process.env.TMPDIR!, 'automation-ssh.pid'), 'utf8')).trim(),
    );
    assert.throws(() => process.kill(pid, 0));
  }
} else throw new Error('Unknown observation action.');
