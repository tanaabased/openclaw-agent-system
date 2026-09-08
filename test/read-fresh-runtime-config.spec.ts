import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import readFreshRuntimeConfig from '../core/read-fresh-runtime-config.ts';

describe('core/read-fresh-runtime-config', () => {
  it('should bypass the pinned runtime snapshot', () => {
    const expected: OpenClawConfig = {
      agents: { entries: { data: { workspace: '/workspace/data' } } },
    };
    let received: { pin?: boolean } | undefined;

    const actual = readFreshRuntimeConfig((options) => {
      received = options;
      return expected;
    });

    assert.deepEqual(received, { pin: false });
    assert.equal(actual, expected);
  });
});
