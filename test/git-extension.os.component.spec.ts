import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import createGitExtensionResolver from '../tools/git/extension.ts';

describe('tools/git/extension', () => {
  it('should resolve exact external helpers outside excluded launcher paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-git-extension-'));
    try {
      const trustedBin = join(root, 'trusted-bin');
      const excludedBin = join(root, 'excluded-bin');
      await Promise.all([mkdir(trustedBin), mkdir(excludedBin)]);
      for (const directory of [trustedBin, excludedBin]) {
        await writeFile(join(directory, 'git-town'), '#!/bin/sh\nexit 0\n');
        await chmod(join(directory, 'git-town'), 0o755);
      }
      const available = createGitExtensionResolver({
        excludedExecutableDirectories: [excludedBin],
        path: [excludedBin, trustedBin].join(delimiter),
      });

      assert.equal(await available('town'), true);
      assert.equal(await available('missing'), false);
      assert.equal(await available('../town'), false);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
