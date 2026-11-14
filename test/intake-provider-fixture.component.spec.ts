import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('examples/openclaw-issue-intake provider fixture', () => {
  it('should narrow real assignment search without changing other requests, pagination, input or failure status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'intake-provider-'));
    const fixture = join(root, 'gh');
    const executable = join(root, 'real-gh');
    try {
      await copyFile('examples/openclaw-issue-intake/provider-fixture.mjs', fixture);
      await writeFile(
        executable,
        `#!${process.execPath}\nlet input=''; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({args:process.argv.slice(2),input})); process.exit(Number(process.env.FIXTURE_EXIT_CODE ?? 0));`,
        { mode: 0o755 },
      );
      await writeFile(
        join(root, 'control.json'),
        JSON.stringify({ ci: true, executable, title: 'Agent System intake flow 12345-2' }),
      );
      const run = (args: string[], exitCode = 0) =>
        spawnSync(process.execPath, [fixture, ...args], {
          env: { ...process.env, FIXTURE_EXIT_CODE: String(exitCode) },
          input: 'original stdin',
          encoding: 'utf8',
        });
      const query = 'q=assignee:tanaabot state:open updated:>=2026-11-14T00:00:00Z is:issue';
      const search = ['api', '--method', 'GET', '/search/issues', '-f', query, '-F', 'page=2'];
      const result = run(search);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        args: [
          ...search.slice(0, 5),
          `${query} repo:tanaabased/big-test-bucket in:title "Agent System intake flow 12345-2"`,
          ...search.slice(6),
        ],
        input: 'original stdin',
      });
      const comments = ['api', '--method', 'POST', '/repos/owner/repo/issues/1/comments'];
      const forwarded = run(comments, 7);
      assert.equal(forwarded.status, 7, forwarded.stderr);
      assert.deepEqual(JSON.parse(forwarded.stdout), { args: comments, input: 'original stdin' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
