import assert from 'node:assert/strict';

import { parseGitHubApiResponse } from '../channels/github/provider/api-response.ts';

describe('channels/github/provider/api-response', () => {
  it('should parse the final included response and rate-limit controls', () => {
    const response = parseGitHubApiResponse(
      [
        'HTTP/2 301 Moved Permanently',
        'location: https://api.github.com/next',
        '',
        'HTTP/2 200 OK',
        'x-ratelimit-remaining: 0',
        'x-ratelimit-reset: 1786460000',
        'retry-after: 12',
        'link: <https://api.github.com/items?page=2>; rel="next"',
        '',
        '{"items":[]}',
      ].join('\r\n'),
    );

    assert.equal(response.status, 200);
    assert.equal(response.body, '{"items":[]}');
    assert.equal(response.hasNextPage, true);
    assert.deepEqual(response.rateLimit, {
      remaining: 0,
      resetAt: 1_786_460_000_000,
      retryAfterMs: 12_000,
    });
  });
});
