import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import PrivateStateFile from '../core/private-state-file.ts';
import { privateStateFileLockLostErrorCode } from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import { controlledFileLock } from './private-state-file-lock-fixture.ts';

describe('core/private-state-file lease guards', () => {
  for (const operation of ['write', 'remove'] as const) {
    it(`should refuse ${operation} commit when ownership is lost during filesystem preparation`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'agent-system-lock-write-'));
      const file = new PrivateStateFile({
        directories: [directory],
        label: 'test state',
        maximumBytes: 1024,
        path: join(directory, 'state.json'),
      });
      const fixture = await controlledFileLock();
      try {
        await file.write('original');
        await assert.rejects(
          withPrivateStateLock(fixture.handle, async () => {
            const pending = operation === 'write' ? file.write('stale') : file.remove();
            fixture.compromise();
            await pending;
          }),
          { code: privateStateFileLockLostErrorCode },
        );
        assert.equal(await file.read(), 'original');
        assert.deepEqual(await readdir(directory), ['state.json']);
      } finally {
        await fixture.handle.release();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
