import assert from 'node:assert/strict';

import openClawCapacity from '../agent/tasks/dispatch/openclaw-capacity.ts';
import type { OpenClawDispatchRecord } from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';

describe('agent/openclaw-capacity', () => {
  for (const [limit, occupied, available] of [
    [3, 0, 3],
    [3, 1, 2],
    [3, 3, 0],
    [1, 0, 1],
    [5, 0, 5],
    [1, 2, 0],
  ] as const)
    it(`should expose ${available} slots with limit ${limit} and ${occupied} occupied`, () => {
      const records = Array.from(
        { length: occupied },
        (_, index) => ({ id: `owner-${index}`, request: {} }) as OpenClawDispatchRecord,
      );
      assert.deepEqual(openClawCapacity(records, limit), { occupied, available });
    });
});
