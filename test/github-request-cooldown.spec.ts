import assert from 'node:assert/strict';

import GitHubRequestCooldown from '../core/github-request-cooldown.ts';
import { githubCliDiagnostic } from '../credentials/github-diagnostic.ts';

const response = (status: number, headers: string[], message = '') => ({
  exitCode: status >= 400 ? 1 : 0,
  stdout: [`HTTP/2 ${status}`, ...headers, '', '{}'].join('\n'),
  stderr: message ? `gh: ${message} (HTTP ${status})` : '',
  timedOut: false,
  truncated: false,
});

describe('core/github-request-cooldown', () => {
  it('should share a primary deadline only within its account and quota bucket', () => {
    let now = 100000;
    const cooldown = new GitHubRequestCooldown(() => now);
    cooldown.observe(
      'account-a',
      response(403, [
        'x-ratelimit-remaining: 0',
        'x-ratelimit-resource: search',
        'x-ratelimit-reset: 220',
      ]),
    );
    assert.equal(cooldown.inspect('account-a', ['api', '/search/issues'])?.localBackoffMs, 120000);
    assert.equal(cooldown.inspect('account-a', ['api', '/user']), undefined);
    assert.equal(cooldown.inspect('account-b', ['api', '/search/issues']), undefined);
    now = 220000;
    assert.equal(cooldown.inspect('account-a', ['api', '/search/issues']), undefined);
  });

  it('should stop across buckets for a secondary limit even with primary allowance remaining', () => {
    let now = 100000;
    const cooldown = new GitHubRequestCooldown(() => now);
    const result = response(
      403,
      ['x-ratelimit-remaining: 4500', 'x-ratelimit-resource: core'],
      'You have exceeded a secondary rate limit.',
    );
    assert.equal(githubCliDiagnostic(result).classification, 'rate-limit');
    assert.equal(githubCliDiagnostic(result).httpStatusSource, 'structured');
    cooldown.observe('account', result);
    assert.equal(cooldown.inspect('account', ['api', 'graphql'])?.localBackoffMs, 60000);
    now += 60000;
    assert.equal(cooldown.inspect('account', ['api', '/user']), undefined);
  });

  it('should honor retry-after without confusing a permission denial with throttling', () => {
    const cooldown = new GitHubRequestCooldown(() => 100000);
    cooldown.observe(
      'account',
      response(403, [], 'Resource not accessible by personal access token'),
    );
    assert.equal(cooldown.inspect('account', ['api', '/user']), undefined);
    cooldown.observe('account', response(429, ['retry-after: 120']));
    assert.equal(cooldown.inspect('account', ['api', '/user'])?.localBackoffMs, 120000);
  });
});
