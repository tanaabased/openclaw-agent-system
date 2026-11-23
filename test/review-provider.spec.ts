import assert from 'node:assert/strict';

import readReviewCI from '../channels/github/provider/review-ci.ts';
import GitHubReviewRequestClient from '../channels/github/provider/review-request-client.ts';
import reviewRoutingContext from '../channels/github/provider/review-routing-context.ts';

const head = 'a'.repeat(40);
const merge = 'b'.repeat(40);
const identity = { login: 'reviewer', nodeId: 'U_reviewer', type: 'User' };
const user = { login: 'reviewer', node_id: 'U_reviewer', type: 'User' };
const event = {
  id: 1,
  node_id: 'E_request',
  event: 'review_requested',
  created_at: '2026-01-01T00:00:00Z',
  requested_reviewer: user,
  review_requester: { login: 'requester', node_id: 'U_requester', type: 'User' },
};
const page = (value: unknown, hasNextPage = false) => ({ value, hasNextPage });

describe('channels/github/provider/review requests', () => {
  it('should attribute a current historical request to its requester, not the author or reviewer', async () => {
    const client = new GitHubReviewRequestClient({
      identity,
      request: async (argv) =>
        page(argv[0]?.endsWith('/requested_reviewers') ? { users: [user] } : [event]),
    });
    assert.equal((await client.current('owner', 'repo', 2))?.requester.nodeId, 'U_requester');
  });

  it('should inspect later pages and retain the exact re-request source', async () => {
    const client = new GitHubReviewRequestClient({
      identity,
      request: async (argv) => {
        if (argv[0]?.endsWith('/requested_reviewers')) return page({ users: [user] });
        return argv.includes('page=1')
          ? page([event], true)
          : page([
              { ...event, id: 2, node_id: 'E_removed', event: 'review_request_removed' },
              {
                ...event,
                id: 3,
                node_id: 'E_again',
                review_requester: { ...event.review_requester, login: 'other', node_id: 'U_other' },
              },
            ]);
      },
    });
    const result = await client.current('owner', 'repo', 2);
    assert.equal(result?.nodeId, 'E_again');
    assert.equal(result?.requester.nodeId, 'U_other');
  });

  it('should not turn missing membership, origin or unsupported actors into authorization', async () => {
    const absent = new GitHubReviewRequestClient({
      identity,
      request: async () => page({ users: [] }),
    });
    assert.equal(await absent.current('owner', 'repo', 2), undefined);
    for (const events of [
      [],
      [{ ...event, event: 'review_request_removed' }],
      [{ ...event, review_requester: { ...event.review_requester, type: 'Bot' } }],
    ]) {
      const client = new GitHubReviewRequestClient({
        identity,
        request: async (argv) =>
          page(argv[0]?.endsWith('/requested_reviewers') ? { users: [user] } : events),
      });
      await assert.rejects(client.current('owner', 'repo', 2), /review-request-/);
    }
  });
});

describe('channels/github/provider/review ci', () => {
  const fixture = (state: 'running' | 'failed' | 'passed' | 'absent', withMerge = false) => ({
    request: async (argv: string[]) => {
      if (argv[0] === 'graphql')
        return page({
          data: {
            repository: {
              pullRequest: {
                headRefOid: head,
                baseRefOid: 'c'.repeat(40),
                body: '',
                potentialMergeCommit: withMerge
                  ? {
                      oid: merge,
                      parents: {
                        nodes: [{ oid: head }, { oid: 'c'.repeat(40) }],
                        pageInfo: { hasNextPage: false },
                      },
                    }
                  : null,
              },
            },
          },
        });
      const endpoint = argv[2]!;
      if (endpoint.includes('/check-runs'))
        return page({
          check_runs:
            state === 'absent'
              ? []
              : [
                  {
                    head_sha: endpoint.includes(merge) ? merge : head,
                    status:
                      state === 'running' && (!withMerge || endpoint.includes(merge))
                        ? 'in_progress'
                        : 'completed',
                    conclusion: state === 'failed' ? 'failure' : 'success',
                  },
                ],
        });
      if (endpoint.includes('/status')) return page({ statuses: [] });
      return page({ workflow_runs: [] });
    },
  });

  it('should allow settled failures without calling them passing', async () => {
    const { fingerprint, changeFingerprint, ...result } = await readReviewCI(
      fixture('failed'),
      'owner',
      'repo',
      2,
      head,
    );
    assert.ok(changeFingerprint);
    assert.match(fingerprint!, /^[a-f0-9]{64}$/u);
    assert.deepEqual(result, {
      head,
      state: 'settled',
      passing: false,
    });
    assert.equal((await readReviewCI(fixture('passed'), 'owner', 'repo', 2, head)).passing, true);
  });

  it('should observe the latest workflow run and same-commit rerun attempt', async () => {
    const base = fixture('absent');
    let attempt = 1;
    const provider = {
      request: async (argv: string[]) =>
        argv[2]?.includes('/actions/runs')
          ? page({
              workflow_runs: [
                {
                  id: 20,
                  workflow_id: 1,
                  event: 'pull_request',
                  head_branch: 'topic',
                  head_sha: head,
                  run_attempt: attempt,
                  status: 'completed',
                  conclusion: 'success',
                },
                {
                  id: 10,
                  workflow_id: 1,
                  event: 'pull_request',
                  head_branch: 'topic',
                  head_sha: head,
                  status: 'completed',
                  conclusion: 'failure',
                },
              ],
            })
          : base.request(argv),
    };
    const first = await readReviewCI(provider, 'owner', 'repo', 2, head);
    assert.equal(first.passing, true);
    attempt++;
    assert.notEqual(
      (await readReviewCI(provider, 'owner', 'repo', 2, head)).fingerprint,
      first.fingerprint,
    );
  });

  it('should detect a description or base change without treating a repeated observation as news', async () => {
    const provider = fixture('passed');
    const read = (body: string, baseRefOid: string) =>
      readReviewCI(
        {
          request: async (argv) =>
            argv[0] === 'graphql'
              ? page({
                  data: {
                    repository: {
                      pullRequest: {
                        headRefOid: head,
                        baseRefOid,
                        body,
                        potentialMergeCommit: null,
                      },
                    },
                  },
                })
              : provider.request(argv),
        },
        'owner',
        'repo',
        2,
        head,
      );
    const first = (await read('original', merge)).changeFingerprint;
    assert.equal((await read('original', merge)).changeFingerprint, first);
    assert.notEqual((await read('updated', merge)).changeFingerprint, first);
    assert.notEqual((await read('original', head)).changeFingerprint, first);
  });

  it('should wait for verified merge checks as well as head checks', async () => {
    assert.equal(
      (await readReviewCI(fixture('running', true), 'owner', 'repo', 2, head)).state,
      'running',
    );
    assert.equal(
      (await readReviewCI(fixture('running'), 'owner', 'repo', 2, head)).state,
      'running',
    );
  });

  it('should distinguish absent evidence from failures and racing heads', async () => {
    assert.equal((await readReviewCI(fixture('absent'), 'owner', 'repo', 2, head)).state, 'absent');
    await assert.rejects(
      readReviewCI(
        {
          request: async () => {
            throw new Error('denied');
          },
        },
        'owner',
        'repo',
        2,
        head,
      ),
      /denied/,
    );
    await assert.rejects(
      readReviewCI(fixture('passed'), 'owner', 'repo', 2, merge),
      /review-head-changed/,
    );
  });
});

describe('channels/github/provider/review routing context', () => {
  it('should not select arbitrary linked issues when the provider relationship is ambiguous', async () => {
    for (const nodes of [[], [{ number: 1 }, { number: 2 }]]) {
      const result = await reviewRoutingContext(
        {
          request: async () =>
            page({
              data: {
                repository: {
                  pullRequest: {
                    closingIssuesReferences: { nodes, pageInfo: { hasNextPage: false } },
                  },
                },
              },
            }),
        },
        'owner',
        'repo',
        2,
      );
      assert.equal(result.linkedIssueStatus, nodes.length ? 'ambiguous' : 'missing');
      assert.equal(result.linkedIssue, undefined);
    }
  });

  it('should preserve unavailable linkage as uncertainty', async () => {
    const result = await reviewRoutingContext(
      {
        request: async () => {
          throw new Error('denied');
        },
      },
      'owner',
      'repo',
      2,
    );
    assert.equal(result.linkedIssueStatus, 'unavailable');
  });
});
