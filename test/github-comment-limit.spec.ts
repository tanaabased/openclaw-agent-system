import assert from 'node:assert/strict';
import {
  defaultMaximumCommentCharacters,
  maximumMaximumCommentCharacters,
  validateMaximumCommentCharacters,
} from '../channels/github/provider/comment-limit.ts';

describe('channels/github/provider/comment-limit', () => {
  it('should accept bounded provider comment limits', () => {
    assert.equal(validateMaximumCommentCharacters(defaultMaximumCommentCharacters), 8000);
    assert.equal(validateMaximumCommentCharacters(maximumMaximumCommentCharacters), 64000);
  });
  it('should reject invalid provider comment limits', () => {
    for (const value of [0, -1, 1.5, maximumMaximumCommentCharacters + 1, '8000'])
      assert.throws(() => validateMaximumCommentCharacters(value));
  });
});
