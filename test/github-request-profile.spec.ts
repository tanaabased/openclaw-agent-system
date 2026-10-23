import assert from 'node:assert/strict';

import createGitHubRequestProfile from '../core/github-request-profile.ts';
import { summarizeGitHubProfiles } from '../scripts/github-profile-report.ts';

describe('core/github-request-profile', () => {
  it('should distinguish conditional responses from fewer observed http requests', () => {
    const summary = summarizeGitHubProfiles([
      {
        version: 1,
        complete: true,
        exitCode: 1,
        response: { status: 304 },
        requests: [{ route: '/repos/:owner/:repo' }],
      },
      {
        version: 1,
        complete: true,
        exitCode: 0,
        response: { status: 200 },
        requests: [{ route: '/repos/:owner/:repo' }],
      },
    ]);
    assert.equal(summary.requests, 2);
    assert.equal(summary.notModified, 1);
    assert.equal(summary.failures[0]?.httpStatus, 304);
  });
  it('should count repeated requests across arbitrary chunks without retaining urls or queries', () => {
    const profile = createGitHubRequestProfile(1024);
    const trace =
      '[git config private-value]\n* Request at time\n* Request to https://api.github.com/user?token=secret\n* Request took 2ms\n* Request to https://api.github.com/repos/private-owner/private-repo/issues/123/comments\n* Request took 0.1s\n* Request to https://api.github.com/user\n* Request took 500µs\n';
    for (const byte of Buffer.from(trace)) profile.observe(Buffer.from([byte]), 'stderr');
    profile.observe(Buffer.from('normal output\n'), 'stdout');
    profile.observe(Buffer.from('gh: ordinary error\n'), 'stderr');
    const result = profile.finish();
    assert.deepEqual(result.requests, [
      { route: '/user', durationMs: 2 },
      { route: '/repos/:owner/:repo/issues/:value/comments', durationMs: 100 },
      { route: '/user', durationMs: 0.5 },
    ]);
    assert.equal(result.complete, true);
    assert.equal(result.stdout, 'normal output\n');
    assert.equal(result.stderr, 'gh: ordinary error\n');
    assert.doesNotMatch(JSON.stringify(result), /secret|private-owner|private-repo|private-value/);
  });

  it('should retain request counts without inventing timing associations for concurrent requests', () => {
    const profile = createGitHubRequestProfile(1024);
    profile.observe(
      Buffer.from(
        '* Request to https://api.github.com/user\n* Request to https://api.github.com/graphql\n* Request took 1s\n* Request took 2s\n',
      ),
      'stderr',
    );
    assert.deepEqual(profile.finish().requests, [{ route: '/user' }, { route: '/graphql' }]);
  });

  it('should identify interrupted traces and keep large debug lines out of ordinary stderr', () => {
    const profile = createGitHubRequestProfile(10);
    profile.observe(
      Buffer.from(
        '* Request to https://api.github.com/user\n* Request to https://example.test/' +
          's'.repeat(9000),
      ),
      'stderr',
    );
    const result = profile.finish();
    assert.equal(result.complete, false);
    assert.equal(result.stderr, '');
    assert.equal(result.requests.length, 1);
  });

  it('should bound ordinary output independently of debug volume and preserve unicode', () => {
    const profile = createGitHubRequestProfile(6);
    const output = Buffer.from('héllo!');
    profile.observe(output.subarray(0, 2), 'stdout');
    profile.observe(
      Buffer.from('* Request to https://api.github.com/user\n* Request took 1ms\n'),
      'stderr',
    );
    profile.observe(output.subarray(2), 'stdout');
    profile.observe(Buffer.from('error'), 'stderr');
    const result = profile.finish();
    assert.equal(result.stdout, 'héllo');
    assert.equal(result.stderr, '');
    assert.equal(result.truncated, true);
    assert.equal(result.requests.length, 1);
  });

  it('should separate operation totals and summarize response counters without treating them as quota deltas', () => {
    const summary = summarizeGitHubProfiles([
      {
        version: 1,
        agentId: 'bot',
        account: 'bot',
        source: 'account',
        operation: 'configured-identity',
        response: { status: 200, resource: 'core', remaining: 4999 },
        complete: true,
        requests: [
          { route: '/user', durationMs: 2 },
          { route: '/user', durationMs: 3 },
        ],
      },
      {
        version: 1,
        agentId: 'bot',
        account: 'bot',
        source: 'account',
        operation: 'account-identity',
        response: { status: 200, resource: 'core', remaining: 4997 },
        complete: false,
        requests: [{ route: '/user' }],
      },
    ]);
    assert.equal(summary.requests, 3);
    assert.equal(summary.commands, 2);
    assert.equal(summary.incomplete, 1);
    assert.equal(summary.groups[0]?.requests, 2);
    assert.equal(summary.groups[0]?.durationMs, 5);
    assert.equal(summary.groups.length, 2);
    assert.deepEqual(summary.quotas, [
      { account: 'bot', resource: 'core', samples: 2, minimum: 4997, maximum: 4999 },
    ]);
  });

  it('should retain failed command metadata even when no http transaction was observed', () => {
    const summary = summarizeGitHubProfiles([
      { version: 1, complete: true, exitCode: 1, operation: 'account-identity', requests: [] },
      { version: 1, complete: true, exitCode: 0, requests: [{ route: '/user' }] },
      {
        version: 1,
        complete: false,
        exitCode: null,
        operation: 'repository',
        response: { status: 503 },
        requests: [{ route: '/repos/:owner/:repo' }],
      },
    ]);
    assert.equal(summary.commands, 3);
    assert.equal(summary.requests, 2);
    assert.deepEqual(
      summary.failures.map(({ operation, exitCode, httpStatus, requests }) => ({
        operation,
        exitCode,
        httpStatus,
        requests,
      })),
      [
        { operation: 'account-identity', exitCode: 1, httpStatus: undefined, requests: 0 },
        { operation: 'repository', exitCode: null, httpStatus: 503, requests: 1 },
      ],
    );
  });
});
