import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import assertCodexNodeVersion from '../agent/codex-node-version.ts';
import metadata from '../package.json' with { type: 'json' };

describe('agent/codex-node-version', () => {
  it('should accept the declared test runtime and explain incompatible node selection', async () => {
    assert.doesNotThrow(() => assertCodexNodeVersion());
    const version = (await readFile('.node-version', 'utf8')).trim();
    assert.doesNotThrow(() => assertCodexNodeVersion(version));
    assert.throws(
      () => assertCodexNodeVersion('1.0.0'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code: string }).code, 'codex-node-version-unsupported');
        assert.ok(error.message.includes(metadata.engines.node));
        assert.match(error.message, /1\.0\.0.*PATH/u);
        return true;
      },
    );
  });
});
