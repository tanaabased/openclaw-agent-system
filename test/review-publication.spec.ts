import assert from 'node:assert/strict';

import reviewPublisher from '../channels/github/publication/review-publisher.ts';
import { reviewEventState, type ReviewDraft } from '../channels/github/provider/review-draft.ts';
import type { GitHubPullRequestReview } from '../channels/github/provider/review-types.ts';
import type { ReviewCI } from '../channels/github/provider/review-ci.ts';
import { account, fixturePullRequest, intakeFixture } from './github-intake-fixture.ts';
import { reviewCommentFixture, reviewFixture } from './github-review-fixtures.ts';

function fixture(event: ReviewDraft['event'] = 'COMMENT') {
  const f = intakeFixture();
  const pr = fixturePullRequest(f);
  pr.draft = false;
  const draft: ReviewDraft = {
    event,
    body: 'Reviewed the current change.',
    comments: [{ path: 'api/example.ts', line: 1, side: 'RIGHT', body: 'Handle the empty list.' }],
  };
  const state = {
    ci: { head: pr.headSha, state: 'settled', passing: true } as ReviewCI,
    reviews: [] as GitHubPullRequestReview[],
    writes: 0,
    attempts: 0,
    allowed: true,
    drop: false,
    inlineChanged: false,
  };
  const publisher = () =>
    reviewPublisher(
      {
        item: {
          lifecycleId: 'pull-request-review',
          repositoryOwner: 'owner',
          repositoryName: 'repo',
          repositoryNodeId: f.repository.nodeId,
          number: 3,
        },
        publicationId: 'first-review',
        head: '1'.repeat(40),
        draft,
      },
      {
        redactText: (text) => text,
        authorize: () => ({ authorized: state.allowed }),
        exclusive: async (_key, run) => run(),
        beforeCreate: async () => {
          state.attempts++;
        },
        connect: async () => ({
          identity: account,
          getItem: f.client.getItem,
          getReviewCI: async () => state.ci,
          reviews: {
            listReviews: async () => ({ values: state.reviews, nextPage: 1 }),
            getReviewComments: async () => [
              reviewCommentFixture({
                author: account,
                originalCommitId: pr.headSha,
                body: state.inlineChanged ? 'changed externally' : draft.comments[0]!.body,
              }),
            ],
            submit: async (_owner, _name, _number, head, submitted) => {
              state.writes++;
              const result = reviewFixture({
                author: account,
                commitId: head,
                body: submitted.body,
                state: reviewEventState[submitted.event],
              });
              state.reviews.push(result);
              if (state.drop) throw new Error('transport interrupted after submission');
              return result;
            },
          },
        }),
      },
    );
  return { ...f, pr, draft, state, publisher };
}

describe('channels/github/publication/formal review', () => {
  it('should publish first-pass approval with grouped inline findings and verify the readback', async () => {
    const f = fixture('APPROVE');
    assert.equal((await f.publisher().publish()).status, 'published');
    assert.equal((await f.publisher().reconcile())?.status, 'reconciled');
    assert.equal(f.state.writes, 1);
  });

  it('should reconcile an uncertain submitted review without creating another', async () => {
    const f = fixture();
    f.state.drop = true;
    await assert.rejects(f.publisher().publish(), /transport interrupted/);
    assert.equal((await f.publisher().reconcile())?.status, 'reconciled');
    assert.equal(f.state.writes, 1);
  });

  it('should reject approval of failed ci but permit a changes-requested review', async () => {
    const f = fixture('APPROVE');
    f.state.ci.passing = false;
    await assert.rejects(f.publisher().publish(), /review-publication-ci-not-ready/);
    assert.equal(f.state.writes, 0);
    assert.equal(f.state.attempts, 0);
    f.draft.event = 'REQUEST_CHANGES';
    assert.equal((await f.publisher().publish()).status, 'published');
  });

  it('should reject running ci, changed revisions, self-review and revoked authority before submission', async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.state.ci.state = 'running';
      },
      (f: ReturnType<typeof fixture>) => {
        f.pr.headSha = '2'.repeat(40);
      },
      (f: ReturnType<typeof fixture>) => {
        f.pr.author = account;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.allowed = false;
      },
    ]) {
      const f = fixture();
      change(f);
      await assert.rejects(f.publisher().publish());
      assert.equal(f.state.writes, 0);
    }
  });

  it('should preserve conflicts in inline contents and disposition instead of accepting a matching marker alone', async () => {
    const f = fixture();
    await f.publisher().publish();
    f.state.inlineChanged = true;
    await assert.rejects(f.publisher().reconcile(), /review-reconciliation-conflict/);
    f.state.inlineChanged = false;
    f.state.reviews[0]!.state = 'APPROVED';
    await assert.rejects(f.publisher().reconcile(), /review-reconciliation-conflict/);
    assert.equal(f.state.writes, 1);
  });
});
