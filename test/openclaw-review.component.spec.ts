import assert from 'node:assert/strict';
import openclawDispatchFixture from './openclaw-dispatch-fixture.ts';
import { reviewFixture } from './github-review-fixtures.ts';
import { reviewEventState } from '../channels/github/provider/review-draft.ts';
import type { GitHubPullRequestReview } from '../channels/github/provider/review-types.ts';
import { account, fixturePullRequest } from './github-intake-fixture.ts';
import GitHubWorkEventClient from '../channels/github/provider/work-event-client.ts';
import openClawReviewCheck from '../agent/tasks/review/openclaw-review-check.ts';
import type { ReviewCI } from '../channels/github/provider/review-ci.ts';

describe('OpenClaw independent review', () => {
  const f = openclawDispatchFixture();
  it('waits for settled CI and opens a GitHub-only review without preparing a checkout', async () => {
    const pr = fixturePullRequest(f.fixture);
    pr.draft = false;
    f.enableClaims('local');
    f.consumeSend = true;
    const deps = f.service.dependencies;
    const provider = new GitHubWorkEventClient({
      identity: account,
      execute: async () => {
        throw new Error('unexpected provider call');
      },
    });
    provider.listIssueComments = async () => ({ comments: [], truncated: false });
    const reviews: GitHubPullRequestReview[] = [];
    provider.reviews.listReviews = async () => ({ values: reviews, nextPage: 1 });
    provider.reviews.getReviewComments = async () => [];
    provider.reviews.submit = async (_owner, _name, _number, head, draft) => {
      const reviewed = reviewFixture({
        author: account,
        commitId: head,
        state: reviewEventState[draft.event],
        body: draft.body,
        url: target + '#pullrequestreview-81',
      });
      reviews.push(reviewed);
      return reviewed;
    };
    provider.reviews.listComments = async () => ({ values: [], nextPage: 1 });
    provider.getRepository = f.fixture.client.getRepository;
    provider.getItem = f.fixture.client.getItem;
    provider.resolveIdentities = async (ids) => ids.map(() => account);
    provider.resolveIdentity = async () => account;
    provider.discoverReviewRequests = async () => ({
      candidates: [
        {
          nodeId: f.fixture.item.nodeId,
          databaseId: 20,
          itemType: 'pull-request',
          number: 3,
          repositoryPath: '/repos/owner/repo',
          updatedAt: f.fixture.item.updatedAt,
        },
      ],
      truncated: false,
      incomplete: false,
      totalCount: 1,
      nextPage: 1,
    });
    provider.reviewRequests.current = provider.reviewRequests.latest = async () => ({
      nodeId: 'E_review',
      databaseId: 33,
      event: 'review_requested',
      createdAt: '2020-01-01T00:00:00Z',
      requester: account,
      reviewer: account,
    });
    const ci: ReviewCI = { head: pr.headSha, state: 'running', passing: false };
    provider.getReviewCI = async () => ci;
    const target = 'https://github.com/owner/repo/pull/3';
    provider.getReviewRoutingContext = async () => ({
      source: target,
      linkedIssueStatus: 'missing',
    });
    deps.connect = async () => provider;
    deps.reviewOccurrence = async () => 1;
    f.manifest.github!.notifications!.reviewRequest = { allowed: [account] };
    const check = () => openClawReviewCheck(deps, f.manifest, f.root, AbortSignal.timeout(5000));
    const call = (operation: string, input: Record<string, unknown> = {}) =>
      f.service.runModel(
        f.manifest,
        f.root,
        { ...f.coordinator, jobId: 'review-job' },
        { action: 'review', operation, ...input },
      );
    assert.equal((await check()).changed, false);
    ci.state = 'settled';
    assert.equal((await check()).changed, true);
    assert.equal((await call('scan')).status, 'observed');
    assert.equal((await call('next')).status, 'routing-required');
    await call('prepare', {
      target,
      assessment: { complexity: 'medium', reason: 'Review CI failure.' },
    });
    assert.equal(f.creates().length, 1);
    assert.equal(f.preparedWorktrees, 0);
    assert.equal(f.sends().length, 1);
    assert.equal((await check()).changed, false);
    const owner = (await f.record()).threadId!;
    const publish = (operation: 'publish' | 'reconcile') =>
      f.service.runModel(
        f.manifest,
        f.root,
        { ...f.child, sessionKey: owner, sessionId: String(f.session!.sessionId) },
        {
          action: 'review',
          operation,
          ...(operation === 'publish'
            ? {
                draft: {
                  event: 'REQUEST_CHANGES',
                  body: '@operator Repair the failing assertion.',
                  comments: [],
                },
              }
            : {}),
        },
      );
    assert.equal((await publish('publish')).status, 'published');
    assert.equal((await publish('reconcile')).status, 'reconciled');
    assert.equal(reviews.length, 1);
    f.active = false;
    ci.changeFingerprint = 'changed-description';
    assert.equal((await check()).changed, true);
    await call('next', { target });
    assert.equal(f.sends().length, 2);
    assert.equal((await check()).changed, false);
    f.active = false;
    pr.headSha = ci.head = 'b'.repeat(40);
    ci.passing = true;
    ci.changeFingerprint = 'passing-repair';
    assert.equal((await check()).changed, true);
    await call('next', { target });
    assert.equal(f.sends().length, 3);
    assert.equal((await f.record()).threadId, owner);
    assert.equal((await f.record()).reviewAdmission!.head, ci.head);
    assert.equal(f.creates().length, 1);
    assert.equal((await check()).changed, false);
  });
});
