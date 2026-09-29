import assert from 'node:assert/strict';
import GitHubWorkEventClient from '../channels/github/provider/work-event-client.ts';

function rawReview() {
  return {
    id: 81,
    node_id: 'PRR_review',
    user: { login: 'pirog', nodeId: 'U_pirog', type: 'User' },
    body: '@tanaabot fix this',
    bodyLength: 17,
    html_url: 'https://github.com/tanaabased/example/pull/45#pullrequestreview-81',
    pull_request_url: 'https://api.github.com/repos/tanaabased/example/pulls/45',
    commit_id: 'a'.repeat(40),
    state: 'COMMENTED',
    submitted_at: '2026-09-01T12:00:00Z',
  };
}
function rawComment(id = 82) {
  return {
    ...rawReview(),
    id,
    node_id: `PRRC_${id}`,
    html_url: `https://github.com/tanaabased/example/pull/45#discussion_r${id}`,
    pull_request_review_id: 81,
    in_reply_to_id: null,
    path: 'api/example.ts',
    diff_hunk: '@@ -1 +1 @@\n+x',
    original_commit_id: 'a'.repeat(40),
    created_at: '2026-09-01T12:00:00Z',
    updated_at: '2026-09-01T12:00:00Z',
    line: null,
    original_line: 1,
    side: 'RIGHT',
    start_line: null,
    original_start_line: null,
    start_side: null,
    position: null,
    original_position: 1,
  };
}
function fixture() {
  const requests: string[][] = [];
  let body: unknown = [rawReview()];
  let more = false;
  const client = new GitHubWorkEventClient({
    identity: { login: 'tanaabot', nodeId: 'U_bot' },
    async execute(argv) {
      requests.push(argv);
      return {
        exitCode: 0,
        stderr: '',
        stdout: [
          'HTTP/2 200 OK',
          ...(more
            ? [
                'link: <https://api.github.com/repos/tanaabased/example/pulls/45/reviews?page=2>; rel="next"',
              ]
            : []),
          '',
          JSON.stringify(body),
        ].join('\n'),
        timedOut: false,
        truncated: false,
      };
    },
  });
  return {
    client: client.reviews,
    requests,
    set(value: unknown, next = false) {
      body = value;
      more = next;
    },
  };
}

describe('channels/github/provider/review-client', () => {
  it('should use fixed review endpoints and preserve the next page for durable discovery', async () => {
    const h = fixture();
    h.set([rawReview()], true);
    const page = await h.client.listReviews('tanaabased', 'example', 45, 1);
    assert.equal(page.nextPage, 2);
    assert.equal(page.values[0]?.commitId, 'a'.repeat(40));
    assert.ok(h.requests[0]?.includes('/repos/tanaabased/example/pulls/45/reviews'));
    assert.ok(h.requests[0]?.includes('page=1'));
    assert.ok(h.requests[0]?.some((value) => value.includes('submitted_at')));
    h.set(rawReview());
    assert.equal((await h.client.getReview('tanaabased', 'example', 45, 81)).databaseId, 81);
  });

  it('should retain original locations and reply relationships from exact review-comment reads', async () => {
    const h = fixture();
    h.set({ ...rawComment(), in_reply_to_id: 70 });
    const comment = await h.client.getComment('tanaabased', 'example', 45, 82);
    assert.equal(comment.replyToId, 70);
    assert.equal(comment.line, null);
    assert.equal(comment.originalLine, 1);
    assert.equal(comment.side, 'RIGHT');
    assert.equal(comment.diffTruncated, false);
    assert.ok(h.requests[0]?.includes('/repos/tanaabased/example/pulls/comments/82'));
  });

  it('should reject foreign resources and incorrect exact identifiers', async () => {
    const h = fixture();
    h.set({
      ...rawReview(),
      pull_request_url: 'https://api.github.com/repos/tanaabased/other/pulls/45',
    });
    await assert.rejects(
      h.client.getReview('tanaabased', 'example', 45, 81),
      /another pull request/u,
    );
    h.set(rawComment(83));
    await assert.rejects(
      h.client.getComment('tanaabased', 'example', 45, 82),
      /another review comment/u,
    );
    h.set({ ...rawComment(), html_url: 'https://elsewhere.example/forged' });
    await assert.rejects(h.client.getComment('tanaabased', 'example', 45, 82), /permalink/u);
  });

  it('should assemble all review pages without executing a partial group', async () => {
    const requests: string[][] = [];
    const client = new GitHubWorkEventClient({
      identity: { login: 'tanaabot', nodeId: 'U_bot' },
      async execute(argv) {
        requests.push(argv);
        const first = argv.includes('page=1');
        return {
          exitCode: 0,
          stderr: '',
          stdout: [
            'HTTP/2 200 OK',
            ...(first ? ['link: <https://api.github.com/next>; rel="next"'] : []),
            '',
            JSON.stringify([rawComment(first ? 82 : 83)]),
          ].join('\n'),
          timedOut: false,
          truncated: false,
        };
      },
    });
    const comments = await client.reviews.getReviewComments('tanaabased', 'example', 45, 81);
    assert.deepEqual(
      comments.map((value) => value.databaseId),
      [82, 83],
    );
    assert.ok(
      requests.every((args) =>
        args.includes('/repos/tanaabased/example/pulls/45/reviews/81/comments'),
      ),
    );
  });

  it('should mark bounded bodies and diffs and fail explicitly at the group pagination boundary', async () => {
    const h = fixture();
    h.set({
      ...rawComment(),
      body: 'x'.repeat(8_001),
      bodyLength: 8_001,
      diff_hunk: 'y'.repeat(8_001),
    });
    const comment = await h.client.getComment('tanaabased', 'example', 45, 82);
    assert.equal(comment.bodyTruncated, true);
    assert.equal(comment.diffTruncated, true);
    h.set([rawComment()], true);
    await assert.rejects(h.client.getReviewComments('tanaabased', 'example', 45, 81), {
      code: 'github-notification-review-truncated',
    });
  });
});
