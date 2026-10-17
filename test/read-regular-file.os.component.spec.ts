import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import readRegularFile from '../paths/read-regular-file.ts';

describe('paths/read-regular-file', () => {
  it('should distinguish missing files from empty files and reject symlinks and directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-system-read-'));
    try {
      const path = join(directory, 'file');
      assert.equal(await readRegularFile(path), undefined);
      await writeFile(path, '');
      assert.equal(await readRegularFile(path), '');
      await symlink(path, join(directory, 'link'));
      await assert.rejects(readRegularFile(join(directory, 'link')), /regular file/u);
      await assert.rejects(readRegularFile(directory), /regular file/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
