import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent/codex-runtime', () => {
  it('should route summary requests through the built command to the binding guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-summary-route-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['dist/codex/codex-runtime.js', 'dispatch', '--plugin-data', root],
        {
          input: JSON.stringify({ action: 'summary', id: 'a'.repeat(64), operation: 'compose' }),
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).code, 'intake-binding-unavailable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
