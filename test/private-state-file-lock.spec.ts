import assert from 'node:assert/strict';

import acquirePrivateStateFileLock, {
  privateStateFileLockBusyErrorCode,
  privateStateFileLockLostErrorCode,
} from '../core/private-state-file-lock.ts';
import {
  assertPrivateStateLocksHeld,
  privateStateLockSignal,
  withPrivateStateLock,
} from '../core/private-state-lock-context.ts';
import { controlledFileLock, lockOptions } from './private-state-file-lock-fixture.ts';

const lost = { code: privateStateFileLockLostErrorCode };

describe('core/private-state-file-lock', () => {
  it('should contain asynchronous compromise and invalidate only the affected lease', async () => {
    const first = await controlledFileLock();
    const second = await controlledFileLock();
    assert.doesNotThrow(first.compromise);
    assert.equal(first.handle.signal.aborted, true);
    assert.throws(first.handle.assertHeld, lost);
    assert.equal(first.handle.signal.reason.message.includes('/private/path'), false);
    assert.doesNotThrow(second.handle.assertHeld);
    assert.equal(await withPrivateStateLock(second.handle, async () => 42), 42);
    await Promise.all([first.handle.release(), first.handle.release(), second.handle.release()]);
    assert.equal(first.releases(), 0);
    assert.equal(second.releases(), 1);
  });

  it('should release once and prevent continuations from using a released lease', async () => {
    const fixture = await controlledFileLock();
    const first = fixture.handle.release();
    assert.equal(fixture.handle.release(), first);
    assert.throws(fixture.handle.assertHeld, /released/u);
    await first;
    assert.equal(fixture.releases(), 1);
  });

  it('should not release a successor when compromise arrives during release scheduling', async () => {
    const fixture = await controlledFileLock();
    const released = fixture.handle.release();
    fixture.compromise();
    await released;
    assert.equal(fixture.releases(), 0);
  });

  it('should preserve busy mapping and unrelated acquisition errors', async () => {
    for (const code of ['ELOCKED', 'EACCES']) {
      const error = Object.assign(new Error('acquisition failed'), { code });
      await assert.rejects(
        acquirePrivateStateFileLock('/state', lockOptions, {
          async lock() {
            throw error;
          },
        }),
        code === 'ELOCKED' ? { code: privateStateFileLockBusyErrorCode } : error,
      );
    }
  });

  it('should reject successful-looking work after lock loss without releasing a running writer', async () => {
    const fixture = await controlledFileLock();
    const resumed = Promise.withResolvers<void>();
    let finished = false;
    const result = withPrivateStateLock(fixture.handle, async () => {
      await resumed.promise;
      finished = true;
      return 'must not succeed';
    });
    fixture.compromise();
    assert.equal(finished, false);
    assert.equal(fixture.releases(), 0);
    resumed.resolve();
    await assert.rejects(result, lost);
    assert.equal(finished, true);
    await fixture.handle.release();
  });

  it('should retain outer guards across nested leases and abort their command signal', async () => {
    const outer = await controlledFileLock();
    const inner = await controlledFileLock();
    await assert.rejects(
      withPrivateStateLock(outer.handle, () =>
        withPrivateStateLock(inner.handle, async () => {
          const signal = privateStateLockSignal();
          outer.compromise();
          assert.equal(signal?.aborted, true);
          assert.throws(assertPrivateStateLocksHeld, lost);
        }),
      ),
      lost,
    );
    assert.doesNotThrow(assertPrivateStateLocksHeld);
    await Promise.all([outer.handle.release(), inner.handle.release()]);
  });

  it('should retain guards in detached continuations after their owner returns', async () => {
    const fixture = await controlledFileLock();
    const resume = Promise.withResolvers<void>();
    let continuation!: Promise<void>;
    await withPrivateStateLock(fixture.handle, async () => {
      continuation = resume.promise.then(() => assertPrivateStateLocksHeld());
    });
    await fixture.handle.release();
    resume.resolve();
    await assert.rejects(continuation, /released/u);
  });
});
