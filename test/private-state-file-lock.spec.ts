import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import acquirePrivateStateFileLock, {
  privateStateFileLockBusyErrorCode,
} from '../core/private-state-file-lock.ts';

const execute = promisify(execFile);
const options = {
  retries: { factor: 1, maxTimeout: 0, minTimeout: 0, retries: 0 },
  staleMs: 30_000,
};

describe('core/private-state-file-lock', () => {
  it('should exclude another process until the owning process releases its lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-system-lock-process-'));
    const target = join(directory, 'private-state');
    const moduleUrl = new URL('../core/private-state-file-lock.ts', import.meta.url).href;
    const source = `
      import acquire from ${JSON.stringify(moduleUrl)};
      try {
        const lease = await acquire(process.argv[1], ${JSON.stringify(options)});
        await lease.release();
        process.stdout.write('acquired');
      } catch (error) {
        process.stdout.write(String(error.code));
      }
    `;
    const probe = () =>
      execute(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', source, target],
        {
          timeout: 5_000,
        },
      );
    try {
      const lease = await acquirePrivateStateFileLock(target, options);
      try {
        assert.equal((await probe()).stdout, privateStateFileLockBusyErrorCode);
      } finally {
        await lease.release();
      }
      assert.equal((await probe()).stdout, 'acquired');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }).timeout(15_000);
});
