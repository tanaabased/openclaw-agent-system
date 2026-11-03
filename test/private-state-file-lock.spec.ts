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
  function acquisitionFixture() {
    let now = 0;
    const timers = new Map<() => void, number>();
    const calls: string[] = [];
    let rejected = false;
    const dependencies = {
      now: () => now,
      schedule(run: () => void, ms: number) {
        timers.set(run, now + ms);
        return () => {
          timers.delete(run);
        };
      },
      async lock(path: string) {
        calls.push(path);
        if (rejected) throw Object.assign(new Error('/secret/path'), { code: 'ELOCKED' });
        return async () => {};
      },
    };
    const options = {
      ...lockOptions,
      contention: {
        category: 'dispatch' as const,
        operation: 'dispatch-commit' as const,
        timeoutMs: 100,
        retryMs: 25,
      },
    };
    return {
      calls,
      timers,
      dependencies,
      options,
      reject(value: boolean) {
        rejected = value;
      },
      tick(ms: number) {
        now += ms;
        for (const [run, at] of [...timers])
          if (at <= now) {
            timers.delete(run);
            run();
          }
      },
      acquire: (
        path = '/queue/state',
        overrides: Partial<typeof options.contention> & { signal?: AbortSignal } = {},
      ) =>
        acquirePrivateStateFileLock(
          path,
          { ...options, contention: { ...options.contention, ...overrides } },
          dependencies,
        ),
    };
  }

  it('should queue same-path acquisitions fifo while unrelated paths proceed', async () => {
    const f = acquisitionFixture();
    const first = await f.acquire();
    const second = f.acquire();
    const third = f.acquire();
    const independent = await f.acquire('/queue/other');
    assert.deepEqual(f.calls, ['/queue/state', '/queue/other']);
    await first.release();
    const next = await second;
    assert.equal(f.calls.length, 3);
    await next.release();
    await (await third).release();
    await independent.release();
    assert.equal(f.calls.length, 4);
    assert.equal(f.timers.size, 0);
  });

  it('should expire or cancel queued waiters without stranding their successors', async () => {
    const f = acquisitionFixture();
    const first = await f.acquire();
    const expired = f.acquire();
    const rejected = assert.rejects(expired, (error: unknown) => {
      const e = error as Error & { code: string; contention: object };
      assert.equal(e.code, privateStateFileLockBusyErrorCode);
      assert.deepEqual(e.contention, {
        category: 'dispatch',
        operation: 'dispatch-commit',
        waitedMs: 100,
        holderOperation: 'dispatch-commit',
        heldMs: 100,
      });
      assert.doesNotMatch(e.message, /queue|secret/);
      return true;
    });
    f.tick(100);
    await rejected;
    const controller = new AbortController();
    const cancelled = assert.rejects(
      f.acquire('/queue/state', { signal: controller.signal }),
      /cancelled/,
    );
    controller.abort(new Error('cancelled'));
    await cancelled;
    const successor = f.acquire();
    await first.release();
    await (await successor).release();
    assert.equal(f.timers.size, 0);
  });

  it('should share one deadline across queue time and cross-process retries', async () => {
    const f = acquisitionFixture();
    const first = await f.acquire();
    const pending = f.acquire();
    const rejected = assert.rejects(pending, { code: privateStateFileLockBusyErrorCode });
    f.tick(75);
    f.reject(true);
    await first.release();
    // let the second acquisition reach the injected retry boundary.
    await Promise.resolve();
    assert.deepEqual([...f.timers.values()], [100]);
    f.tick(25);
    await rejected;
    assert.equal(f.timers.size, 0);
    f.reject(false);
    await (await f.acquire()).release();
  });

  it('should keep a remote holder unknown and recover acquisition after failures', async () => {
    const f = acquisitionFixture();
    f.reject(true);
    await assert.rejects(f.acquire('/queue/state', { timeoutMs: 0 }), (error: unknown) => {
      assert.deepEqual((error as { contention: unknown }).contention, {
        category: 'dispatch',
        operation: 'dispatch-commit',
        waitedMs: 0,
        holderOperation: 'unknown',
      });
      return true;
    });
    f.reject(false);
    const handle = await f.acquire();
    await withPrivateStateLock(handle, async () => {
      await assert.rejects(f.acquire(), { code: privateStateFileLockBusyErrorCode });
    });
    await handle.release();
    await (await f.acquire()).release();
  });

  it('should cancel remote backoff and reclaim the acquisition slot', async () => {
    const f = acquisitionFixture();
    f.reject(true);
    const controller = new AbortController();
    const pending = assert.rejects(
      f.acquire('/queue/state', { signal: controller.signal }),
      /cancelled/,
    );
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    await pending;
    assert.equal(f.timers.size, 0);
    f.reject(false);
    await (await f.acquire()).release();
  });

  for (const compromised of [false, true])
    it(`should release cancelled acquisition without releasing a successor after compromise: ${compromised}`, async () => {
      const f = acquisitionFixture();
      const controller = new AbortController();
      let releases = 0;
      await assert.rejects(
        acquirePrivateStateFileLock(
          '/queue/state',
          { ...f.options, contention: { ...f.options.contention, signal: controller.signal } },
          {
            ...f.dependencies,
            async lock(_path, options) {
              if (compromised) options.onCompromised(new Error('lease lost'));
              controller.abort(new Error('cancelled'));
              return async () => {
                releases++;
              };
            },
          },
        ),
        /cancelled/,
      );
      assert.equal(releases, compromised ? 0 : 1);
      await (await f.acquire()).release();
    });

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
