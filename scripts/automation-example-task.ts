import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ci-only bounded observation through public gateway rpc; no private scheduler reads.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub Actions only.');
const [action, id, runId] = process.argv.slice(2);
const workspace = join(process.env.TMPDIR!, 'automation-agent');
const stages = ['started', 'git', 'github', 'agent-selection', 'workspace', 'done'];
async function stage() {
  const value = await readFile(join(workspace, `${id}.stage`), 'utf8').catch(() => '');
  return stages.includes(value.trim()) ? value.trim() : 'not-recorded';
}
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
if (action === 'wait-run') {
  assert.ok(runId);
  for (let attempt = 0; attempt < 90; attempt++) {
    const child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn(
      ['openclaw', 'agent-system', 'automations', 'runs', id!, '--run-id', runId!, '--json'],
      { cwd: workspace, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    );
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    assert.equal(code, 0, errors);
    const page = JSON.parse(output);
    if (page.entries.length) {
      assert.equal(page.entries[0].runId, runId);
      assert.equal(page.entries[0].execution, 'ok');
      process.stdout.write('native run completed\n');
      process.exit(0);
    }
    await Bun.sleep(2000);
  }
  throw new Error('The exact native occurrence did not finish.');
} else if (action === 'wait') {
  for (let attempt = 0; attempt < 90; attempt++) {
    const page = await rpc('cron.list', { includeDisabled: true, limit: 200 });
    const job = page.jobs.find((entry: { name: string }) => entry.name === `Agent System: ${id}`);
    if (job?.state?.lastRunAtMs && !job.state.runningAtMs) {
      const expected = ['policy', 'missing', 'timeout', 'cancel', 'stale', 'disabled'].includes(id!)
        ? 'error'
        : 'ok';
      assert.equal(
        job.state.lastRunStatus,
        expected,
        `${id}: unexpected native status; fixture stage=${await stage()}`,
      );
      if (id === 'timeout') {
        assert.match(String(job.state.lastError), /timed out/iu, 'expected native timeout');
      }
      if (id === 'cancel') {
        const runs = await rpc('cron.runs', { id: job.id, limit: 1 });
        assert.ok(
          runs.entries?.some((run: { summary?: string }) =>
            run.summary?.includes('"code":"automation-cancelled"'),
          ),
          'expected runner cancellation acknowledgement',
        );
      }
      process.stdout.write(`${id}: ${expected}\n`);
      process.exit(0);
    }
    await Bun.sleep(2000);
  }
  throw new Error(`Scheduled occurrence did not finish; fixture stage=${await stage()}.`);
} else if (action === 'cleanup') {
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
