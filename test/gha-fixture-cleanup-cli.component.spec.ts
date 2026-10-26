import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { ghaFixtureCleanupCli } from '../scripts/gha-fixture-cleanup.ts';
import fixture from './gha-fixture-cleanup-fixture.ts';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    output: {
      writeStdout(value: string) {
        stdout += value;
      },
      writeStderr(value: string) {
        stderr += value;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}
const selectors = ['--run-id', '100', '--attempt', '2'];

describe('gha fixture cleanup cli', () => {
  it('runs the ci json path without installed packages or the presentation modules', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gha-fixture-cli-'));
    try {
      await mkdir(join(directory, 'scripts'));
      await mkdir(join(directory, 'test'));
      await copyFile(
        new URL('../scripts/gha-fixture-cleanup.ts', import.meta.url),
        join(directory, 'scripts/gha-fixture-cleanup.ts'),
      );
      await copyFile(
        new URL('./gha-fixture-cleanup-fixture.ts', import.meta.url),
        join(directory, 'test/gha-fixture-cleanup-fixture.ts'),
      );
      await writeFile(
        join(directory, 'check.ts'),
        `import { ghaFixtureCleanupCli } from './scripts/gha-fixture-cleanup.ts';\nimport fixture from './test/gha-fixture-cleanup-fixture.ts';\nprocess.exitCode = await ghaFixtureCleanupCli(['--run-id','100','--attempt','2','--json'], {GH_TOKEN:'fixture'}, {api:fixture().api});\n`,
      );
      const result = spawnSync('bun', ['check.ts'], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).ok, true);
      assert.equal(result.stderr, '');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('runs version and help without credentials or a github actions environment', async () => {
    const metadata = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    for (const flag of ['--version', '--help']) {
      const result = spawnSync('bun', ['scripts/gha-fixture-cleanup.ts', flag], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_ACTIONS: '',
          GH_TOKEN: 'never-print-this-credential',
          NO_COLOR: '1',
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout.includes('never-print-this-credential'), false);
      if (flag === '--version') assert.equal(result.stdout.trim(), metadata.version);
      else assert.ok(result.stdout.includes('--run-id') && result.stdout.includes('--token'));
    }
  });

  it('uses the same cli for local preview and json automation with pure stdout', async () => {
    for (const json of [false, true]) {
      const state = fixture();
      const streams = capture();
      const code = await ghaFixtureCleanupCli(
        [...selectors, '--dry-run', ...(json ? ['--json'] : [])],
        { GH_TOKEN: 'token', NO_COLOR: '1' },
        { api: state.api, output: streams.output },
      );
      assert.equal(code, 0);
      assert.equal(streams.stderr(), '');
      assert.equal(
        state.calls.some((call) => /^(PATCH|DELETE)/u.test(call)),
        false,
      );
      if (json) {
        const value = JSON.parse(streams.stdout());
        assert.equal(value.dryRun, true);
        assert.equal(value.runId, 100);
      } else
        assert.ok(
          streams.stdout().includes('preview') && streams.stdout().includes('would-remove'),
        );
    }
  });

  it('preserves exit status and keeps credentials and raw errors out of both output modes', async () => {
    const secret = 'neverprintthiscredential';
    for (const json of [false, true]) {
      const streams = capture();
      const code = await ghaFixtureCleanupCli(
        [...selectors, ...(json ? ['--json'] : [])],
        { GH_TOKEN: secret, NO_COLOR: '1' },
        {
          api: async () => {
            throw new Error(secret);
          },
          output: streams.output,
        },
      );
      assert.equal(code, 1);
      assert.equal((streams.stdout() + streams.stderr()).includes(secret), false);
      if (json) {
        assert.equal(JSON.parse(streams.stdout()).code, 'cleanup-failed');
        assert.equal(streams.stderr(), '');
      } else {
        assert.equal(streams.stdout(), '');
        assert.equal(streams.stderr().match(/messages/gu)?.length, 1);
      }
    }
  });

  it('uses the shared color controls without changing help content', async () => {
    const plain = capture();
    const color = capture();
    const suppressed = capture();
    await ghaFixtureCleanupCli(['--help'], { NO_COLOR: '1' }, { output: plain.output });
    await ghaFixtureCleanupCli(['--help'], { FORCE_COLOR: '3' }, { output: color.output });
    await ghaFixtureCleanupCli(
      ['--help'],
      { NO_COLOR: '1', FORCE_COLOR: '3' },
      { output: suppressed.output },
    );
    assert.equal(stripVTControlCharacters(color.stdout()), plain.stdout());
    assert.equal(suppressed.stdout(), plain.stdout());
  });

  it('rejects missing tokens and invalid arguments without making requests', async () => {
    for (const args of [
      [...selectors, '--json'],
      ['--json', '--bad-option', 'credential-value'],
    ]) {
      const streams = capture();
      const code = await ghaFixtureCleanupCli(
        args,
        {},
        { api: async () => assert.fail('must not request'), output: streams.output },
      );
      assert.equal(code, 1);
      assert.equal(JSON.parse(streams.stdout()).ok, false);
      assert.equal(streams.stderr(), '');
      assert.equal(streams.stdout().includes('credential-value'), false);
    }
  });
});
