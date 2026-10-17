import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { CliCapture } from '../scripts/cli-fixtures.ts';

const fixture = 'fixtures/openclaw-automations.approved.txt';
const capture = async () =>
  JSON.parse(await readFile(fixture, 'utf8')) as {
    cli: (CliCapture & { executable: string; argv: string[] })[];
  };

describe('automation capture integrity', () => {
  it('should retain complete cli capture evidence and matching provenance', async () => {
    const recorded = await capture();
    for (const cli of recorded.cli) {
      assert.equal(cli.executable, 'openclaw');
      assert.equal(cli.timedOut, false);
      assert.equal(cli.truncated, false);
      assert.ok(['agent-system', 'as'].includes(cli.argv[0]!));
      assert.equal(cli.argv[1], 'automations');
    }
    const syncs = recorded.cli.filter(({ argv }) => argv[2] === 'sync');
    assert.ok(
      syncs.some(({ stdout }) =>
        JSON.parse(stdout).outcomes.some(({ status }: { status: string }) => status === 'updated'),
      ),
    );
    assert.ok(
      syncs.some(({ stdout }) =>
        JSON.parse(stdout).outcomes.every(
          ({ status }: { status: string }) => status === 'unchanged',
        ),
      ),
    );
    const missing = recorded.cli.find(({ argv }) => argv[2] === 'run' && argv[3] === 'missing')!;
    assert.equal(missing.exitCode, 1);
    assert.equal(JSON.parse(missing.stdout).code, 'automation-id-missing');
    assert.match(missing.stderr, /automation-id-missing/u);
    assert.ok(recorded.cli.some(({ argv, exitCode }) => argv.includes('--help') && exitCode === 0));
    const metadata = JSON.parse(await readFile('fixtures/openclaw-automations.meta.json', 'utf8'));
    assert.equal(
      createHash('sha256')
        .update(await readFile(fixture))
        .digest('hex'),
      metadata.sha256,
    );
  });
});
