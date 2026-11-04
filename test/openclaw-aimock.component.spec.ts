import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const command = 'scripts/openclaw-aimock';
const environment = { ...process.env, NO_COLOR: '1' };

describe('scripts/openclaw-aimock', () => {
  it('should document one strict mock provider lifecycle', async () => {
    const { stdout } = await execFileAsync(command, ['--help'], { env: environment });

    assert.match(stdout, /Usage: openclaw-aimock <prepare\|evidence\|stop>/u);
    assert.match(stdout, /--scenario <id>/u);
    assert.match(stdout, /--expected-evidence <path>/u);
    assert.match(stdout, /OPENCLAW_AIMOCK_MODEL/u);
  });

  it('should reject an unknown action before touching runtime state', async () => {
    await assert.rejects(
      execFileAsync(command, ['unknown'], { env: environment }),
      (error: unknown) => {
        assert.match(
          (error as { stderr?: string }).stderr ?? '',
          /an action of prepare, evidence, or stop is required/u,
        );
        return true;
      },
    );
  });

  it('should remain independent of an available live-model credential', async () => {
    const source = await readFile(command, 'utf8');

    assert.doesNotMatch(source, /OPENAI_API_KEY/u);
    assert.match(source, /aimock-server\.ts/u);
    assert.match(source, /strictMissCount == 0/u);
  });

  it('should disable automatic utility traffic in strict mock setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aimock-config-'));
    const calls = join(root, 'calls.jsonl');
    // replace every external boundary; no provider, gateway or host config is used.
    await writeFile(join(root, 'node'), '#!/bin/sh\nprintf "http://127.0.0.1:4010\\n"\n', {
      mode: 0o700,
    });
    await writeFile(join(root, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(
      join(root, 'openclaw'),
      `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.AIMOCK_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'config' && args[1] === 'validate') console.log('{"valid":true}');
`,
      { mode: 0o700 },
    );
    try {
      await execFileAsync(command, ['prepare', '--scenario', 'openclaw-lifecycle-approvals'], {
        env: {
          ...environment,
          PATH: `${root}:${process.env.PATH}`,
          TMPDIR: root,
          GITHUB_ACTIONS: 'true',
          AIMOCK_TEST_CALLS: calls,
        },
      });
      const applied = (await readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const utility = applied.find((args) => args[2] === 'agents.defaults.utilityModel');
      assert.ok(utility, 'mock setup must not inherit automatic provider utility routing');
      assert.equal(JSON.parse(utility[3]!), '');
      assert.ok(utility.includes('--strict-json'));
      assert.equal(applied.at(-1)?.[1], 'validate');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
