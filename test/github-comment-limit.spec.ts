import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import {
  defaultMaximumCommentCharacters,
  maximumMaximumCommentCharacters,
  resolveMaximumCommentCharacters,
} from '../channels/github/provider/comment-limit.ts';

function configured(value: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        'agent-system': {
          config: { githubNotifications: { maxCommentCharacters: value } },
        },
      },
    },
  } as OpenClawConfig;
}

describe('channels/github/provider/comment-limit', () => {
  it('should default and override the operator-wide comment intake boundary', () => {
    assert.equal(resolveMaximumCommentCharacters({}), defaultMaximumCommentCharacters);
    assert.equal(resolveMaximumCommentCharacters(configured(12_000)), 12_000);
    assert.equal(
      resolveMaximumCommentCharacters(configured(maximumMaximumCommentCharacters)),
      maximumMaximumCommentCharacters,
    );
  });

  it('should reject invalid comment intake boundaries', () => {
    for (const value of [0, -1, 1.5, maximumMaximumCommentCharacters + 1, '8000']) {
      assert.throws(() => resolveMaximumCommentCharacters(configured(value)));
    }
  });
});
