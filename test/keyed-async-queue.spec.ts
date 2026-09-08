import assert from 'node:assert/strict';

import KeyedAsyncQueue from '../utils/keyed-async-queue.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('utils/keyed-async-queue', () => {
  it('should serialize work for one key without poisoning later work', async () => {
    const queue = new KeyedAsyncQueue();
    const release = deferred();
    const events: string[] = [];
    const first = queue.enqueue('data', async () => {
      events.push('first-start');
      await release.promise;
      events.push('first-end');
      throw new Error('first failed');
    });
    const second = queue.enqueue('data', async () => {
      events.push('second');
      return 'done';
    });

    await Promise.resolve();
    assert.deepEqual(events, ['first-start']);
    release.resolve();

    await assert.rejects(first, /first failed/u);
    assert.equal(await second, 'done');
    assert.deepEqual(events, ['first-start', 'first-end', 'second']);
  });

  it('should allow different keys to proceed independently', async () => {
    const queue = new KeyedAsyncQueue();
    const release = deferred();
    const first = queue.enqueue('data', async () => release.promise);
    const second = queue.enqueue('emori', async () => 'ready');

    assert.equal(await second, 'ready');
    release.resolve();
    await first;
  });
});
