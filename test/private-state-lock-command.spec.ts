import assert from 'node:assert/strict';

import createToolCliRunner from '../api/cli-runner.ts';
import { privateStateFileLockLostErrorCode } from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import { controlledFileLock } from './private-state-file-lock-fixture.ts';

const request = {
  executable: process.execPath,
  argv: ['--version'],
  cwd: '/tmp',
  environment: {},
  excludedExecutableDirectories: [],
  maxOutputBytes: 1024,
  timeoutMs: 1000,
};

describe('api/cli-runner private state leases', () => {
  it('should not launch another command after lock loss', async () => {
    const fixture = await controlledFileLock();
    let calls = 0;
    const runner = createToolCliRunner(async () => {
      calls += 1;
      return {
        code: 0,
        stdout: '',
        stderr: '',
        killed: false,
        signal: null,
        termination: 'exit' as const,
      };
    });
    await assert.rejects(
      withPrivateStateLock(fixture.handle, async () => {
        fixture.compromise();
        await runner(request);
      }),
      { code: privateStateFileLockLostErrorCode },
    );
    assert.equal(calls, 0);
    await fixture.handle.release();
  });

  it('should abort an in-flight command and reject a late success after lock loss', async () => {
    const fixture = await controlledFileLock();
    const runner = createToolCliRunner(async (_argv, options) => {
      assert.notEqual(typeof options, 'number');
      if (typeof options === 'number') throw new Error('expected command options');
      assert.ok(options.signal);
      assert.equal(options.signal.aborted, false);
      fixture.compromise();
      assert.equal(options.signal.aborted, true);
      return {
        code: 0,
        stdout: 'late success',
        stderr: '',
        killed: false,
        signal: null,
        termination: 'exit' as const,
      };
    });
    await assert.rejects(
      withPrivateStateLock(fixture.handle, () => runner(request)),
      {
        code: privateStateFileLockLostErrorCode,
      },
    );
    await fixture.handle.release();
  });
});
