import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import writeAtomic from '../paths/write-atomic.ts';

describe('paths/write-atomic', () => {
  it('should replace text with the requested mode and leave no temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-system-write-'));
    try {
      const path = join(directory, 'file');
      await writeFile(path, 'old', { mode: 0o644 });
      await writeAtomic(path, 'new', 0o600);
      assert.equal(await readFile(path, 'utf8'), 'new');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(directory), ['file']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should remove its temporary file when replacement fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-system-write-'));
    try {
      const target = join(directory, 'target');
      await mkdir(target);
      await assert.rejects(writeAtomic(target, 'new', 0o600));
      assert.equal((await stat(target)).isDirectory(), true);
      assert.deepEqual(await readdir(directory), ['target']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
