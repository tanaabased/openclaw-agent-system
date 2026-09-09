import assert from 'node:assert/strict';

import abortableDelay from '../utils/abortable-delay.ts';

describe('utils/abortable-delay', () => {
  it('should resolve a valid zero-duration delay', async () => {
    await abortableDelay(0);
  });

  it('should reject promptly when the caller aborts', async () => {
    const controller = new AbortController();
    const waiting = abortableDelay(10_000, controller.signal);

    controller.abort(new Error('cancelled'));

    await assert.rejects(waiting, /cancelled/u);
  });

  it('should reject invalid durations', async () => {
    await assert.rejects(abortableDelay(-1), /bounded non-negative integers/u);
  });
});
