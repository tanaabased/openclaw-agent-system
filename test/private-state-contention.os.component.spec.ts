import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import properLockfile from 'proper-lockfile';

import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { lockOptions } from './private-state-file-lock-fixture.ts';

describe('core/private-state contention across processes', () => {
  it('should retain process exclusion and acquire after a remote lease releases within the deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'state-contention-'));
    const path = join(root, 'state.json');
    const module = new URL('../core/private-state-file-lock.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import acquire from ${JSON.stringify(module)};
      const handle = await acquire(process.argv[1], ${JSON.stringify(lockOptions)});
      process.send('held');
      process.once('message', async () => { await handle.release(); process.disconnect(); });
    `,
        path,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    const exit = once(child, 'exit');
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    try {
      const ready = await Promise.race([
        once(child, 'message'),
        exit.then(() => {
          throw new Error(stderr || 'lock child exited before readiness');
        }),
      ]);
      assert.equal(ready[0], 'held');
      const options = {
        ...lockOptions,
        contention: {
          category: 'dispatch' as const,
          operation: 'dispatch-commit' as const,
          timeoutMs: 0,
          retryMs: 25,
        },
      };
      await assert.rejects(acquirePrivateStateFileLock(path, options), (error: unknown) => {
        const failure = error as {
          code: string;
          contention: {
            category: string;
            operation: string;
            waitedMs: number;
            holderOperation: string;
          };
        };
        assert.equal(failure.code, 'private-state-file-lock-busy');
        assert.equal(failure.contention.category, 'dispatch');
        assert.equal(failure.contention.operation, 'dispatch-commit');
        assert.equal(failure.contention.holderOperation, 'unknown');
        assert.ok(failure.contention.waitedMs >= 0);
        return true;
      });
      const other = await acquirePrivateStateFileLock(join(root, 'other.json'), options);
      await other.release();
      let busyObserved = false;
      const handle = await acquirePrivateStateFileLock(
        path,
        { ...options, contention: { ...options.contention, timeoutMs: 1000 } },
        {
          async lock(...args) {
            try {
              return await properLockfile.lock(...args);
            } catch (error) {
              if (!busyObserved) {
                busyObserved = true;
                child.send('release');
              }
              throw error;
            }
          },
        },
      );
      await handle.release();
      assert.equal(busyObserved, true);
      assert.deepEqual(await exit, [0, null]);
    } finally {
      if (child.connected) child.send('release');
      if (child.exitCode === null) {
        child.kill();
        await exit;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
