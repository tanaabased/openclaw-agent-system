import assert from 'node:assert/strict';

import { Value } from 'typebox/value';

import deliveryAnnouncement, {
  announcementPresentation,
  reconcileAnnouncement,
} from '../agent/delivery-announcement.ts';
import {
  deliveryAnnouncementStateSchema,
  type DeliveryAnnouncementState,
} from '../agent/delivery-announcement-state.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

describe('agent/delivery-announcement', () => {
  let input: Parameters<typeof deliveryAnnouncement>[0];
  let delivery: { announcement?: DeliveryAnnouncementState };
  let comments: Array<{ nodeId: string; databaseId: number; body: string }>;
  let posts: number, reads: number, snapshots: number;
  let lost: boolean, missing: boolean, rejected: boolean, revoked: boolean;
  let draft: boolean, skillDigest: string;
  beforeEach(() => {
    delivery = {};
    comments = [];
    posts = reads = snapshots = 0;
    lost = missing = rejected = revoked = draft = false;
    skillDigest = 'a'.repeat(64);
    input = {
      operation: 'compose',
      delivery,
      publication: {
        item: {
          number: 3,
          itemDatabaseId: 3,
          itemNodeId: 'I_3',
          repositoryOwner: 'owner',
          repositoryName: 'repo',
          repositoryDefaultBranch: 'main',
        },
        branch: 'task',
        headSha: 'a'.repeat(40),
        repositoryNodeId: 'R_repo',
        expectedPullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
      },
      provider: {
        async announcement() {
          snapshots++;
          return {
            pullRequestNodeId: 'PR_7',
            pullRequestNumber: 7,
            draft,
            head: 'a'.repeat(40),
            title: 'Fix issue',
            body: 'A public description.',
          };
        },
      },
      authorId: 'U_agent',
      authorLogin: 'posting-agent',
      client: {
        async findOwnIssueComment(owner, name, number, marker) {
          reads++;
          assert.equal(`${owner}/${name}#${number}`, 'owner/repo#3');
          return comments.find((comment) => comment.body.includes(marker));
        },
        async createIssueComment(owner, name, number, body) {
          assert.equal(`${owner}/${name}#${number}`, 'owner/repo#3');
          assert.equal(delivery.announcement?.attempted, true);
          posts++;
          if (rejected)
            throw new GitHubWorkEventClientError(
              'github-notification-request-failed',
              'Rejected',
              {},
              undefined,
              providerDiagnostic('github', 'api-request', 'permission', { httpStatus: 403 }),
            );
          const comment = { nodeId: 'IC_1', databaseId: 1, body };
          if (!missing) comments.push(comment);
          if (lost || missing) throw new Error('transport lost');
          return comment;
        },
      },
      async select(state) {
        return {
          version: 1,
          requestedSkill: 'reply',
          defaultSkill: true,
          observedAt: state?.composition.observedAt ?? 1,
          skill: {
            name: 'reply',
            path: '/skills/reply/SKILL.md',
            scope: 'user',
            digest: skillDigest,
          },
        };
      },
      async authorize() {
        if (revoked) throw new Error('delivery-authority-revoked');
      },
      async save() {
        assert.equal(Value.Check(deliveryAnnouncementStateSchema, delivery.announcement), true);
      },
    };
  });
  const run = (operation: typeof input.operation, extra = {}) =>
    deliveryAnnouncement({ ...input, operation, ...extra });
  async function candidate() {
    const context = await run('compose');
    assert.equal(context.status, 'composition-ready');
    assert.ok('digest' in context);
    const prepared = await run('candidate', {
      digest: context.digest,
      publicText: 'Keeps the issue announcement with its delivered PR.',
    });
    assert.equal(prepared.status, 'announcement-prepared');
    assert.ok('digest' in prepared);
    return prepared;
  }
  for (const state of [false, true])
    it(`should publish one verified ${state ? 'draft' : 'ready'} announcement on its originating issue`, async () => {
      draft = state;
      const preview = await candidate();
      assert.equal(posts, 0);
      assert.equal((await run('announce', { digest: preview.digest })).status, 'announced');
      assert.equal(posts, 1);
      assert.match(comments[0]!.body, /https:\/\/github.com\/owner\/repo\/pull\/7/);
      assert.ok(comments[0]!.body.includes(state ? 'Draft.' : 'Ready for review.'));
      assert.match(comments[0]!.body, /agent-system-github-publication:pull-request-handoff:/);
      assert.deepEqual(delivery.announcement?.receipt, { nodeId: 'IC_1', databaseId: 1 });
    });
  it('should reconcile repeated delivery after restart without regenerating text or reading changed pr status', async () => {
    const preview = await candidate();
    await run('announce', { digest: preview.digest });
    const original = comments[0]!.body;
    const before = snapshots;
    delivery = JSON.parse(JSON.stringify(delivery));
    input.delivery = delivery;
    draft = true;
    await run('compose');
    await run('announce');
    assert.equal(posts, 1);
    assert.equal(snapshots, before);
    assert.equal(comments[0]!.body, original);
  });
  it('should recover a lost post response using the exact existing comment', async () => {
    const preview = await candidate();
    lost = true;
    assert.equal(
      (await run('announce', { digest: preview.digest })).status,
      'announcement-blocked',
    );
    assert.equal(delivery.announcement?.attempted, true);
    assert.equal(delivery.announcement?.receipt, undefined);
    assert.equal((await run('announce')).status, 'announced');
    assert.equal(posts, 1);
  });
  it('should retain uncertainty when a completed post cannot be found', async () => {
    const preview = await candidate();
    missing = true;
    await run('announce', { digest: preview.digest });
    const retry = await run('announce');
    assert.equal(retry.status, 'announcement-blocked');
    assert.ok('code' in retry && retry.code === 'delivery-announcement-unconfirmed');
    assert.equal(posts, 1);
  });
  it('should not clear an uncertain attempt when reconciliation is denied', async () => {
    const preview = await candidate();
    missing = true;
    await run('announce', { digest: preview.digest });
    input.client.findOwnIssueComment = async () => {
      throw new GitHubWorkEventClientError(
        'denied',
        'Denied',
        {},
        undefined,
        providerDiagnostic('github', 'api-request', 'permission', { httpStatus: 403 }),
      );
    };
    await run('announce');
    assert.equal(delivery.announcement?.attempted, true);
    assert.equal(posts, 1);
  });
  it('should recover an explicitly rejected post without creating another pr', async () => {
    let preview = await candidate();
    rejected = true;
    await run('announce', { digest: preview.digest });
    assert.equal(delivery.announcement?.attempted, false);
    rejected = false;
    preview = await candidate();
    assert.equal((await run('announce', { digest: preview.digest })).status, 'announced');
    assert.equal(comments.length, 1);
  });
  it('should reject stale draft status and require a fresh candidate before the first post', async () => {
    const preview = await candidate();
    draft = true;
    assert.equal(
      (await run('announce', { digest: preview.digest })).status,
      'announcement-blocked',
    );
    assert.equal(posts, 0);
    const refreshed = await candidate();
    await run('announce', { digest: refreshed.digest });
    assert.match(comments[0]!.body, /Draft\./);
  });
  it('should withhold changed skills, stale digests, and private candidate content', async () => {
    const preview = await candidate();
    skillDigest = 'b'.repeat(64);
    await run('announce', { digest: preview.digest });
    assert.equal(posts, 0);
    const context = await run('compose');
    assert.ok('digest' in context);
    await run('candidate', { digest: context.digest, publicText: 'password=secret' });
    assert.equal(posts, 0);
    assert.equal(delivery.announcement?.publicText, undefined);
  });
  it('should stop before reading or publishing when authority is revoked', async () => {
    const preview = await candidate();
    revoked = true;
    await run('announce', { digest: preview.digest });
    assert.equal(posts, 0);
    assert.equal(reads, 0);
  });
  it('should reject edited or deleted accepted comments without replacement', async () => {
    const preview = await candidate();
    await run('announce', { digest: preview.digest });
    comments[0]!.body = comments[0]!.body.replace('Keeps', 'Changes');
    assert.equal((await run('announce')).status, 'announcement-blocked');
    comments.length = 0;
    assert.equal((await run('announce')).status, 'announcement-blocked');
    assert.equal(posts, 1);
  });
  it('should expose a verified receipt for feedback suppression after a response loss', async () => {
    const preview = await candidate();
    lost = true;
    await run('announce', { digest: preview.digest });
    const receipt = await reconcileAnnouncement({
      state: delivery.announcement!,
      client: input.client,
      authorId: 'U_agent',
      item: {
        lifecycleId: 'issue',
        number: 3,
        repositoryOwner: 'owner',
        repositoryName: 'repo',
        repositoryNodeId: 'R_repo',
      },
    });
    assert.equal(receipt.nodeId, 'IC_1');
    assert.equal(posts, 1);
  });
  it('should present the accepted public text and distinct pending or published outcome', async () => {
    const preview = await candidate();
    const pending = announcementPresentation(
      delivery.announcement,
      'https://github.com/owner/repo/issues/3',
    );
    assert.match(pending, /announcement pending/);
    assert.match(pending, /Keeps the issue/);
    assert.match(preview.presentation!, /PR announcement draft by \[@posting-agent\]/);
    assert.ok(!preview.presentation!.includes('#issuecomment-'));
    await run('announce', { digest: preview.digest });
    const confirmed = announcementPresentation(
      delivery.announcement,
      'https://github.com/owner/repo/issues/3',
    );
    assert.ok(confirmed.includes(delivery.announcement!.publicText!.split('\n')[0]!));
    assert.ok(
      confirmed.includes(
        '[PR announcement ↗](https://github.com/owner/repo/issues/3#issuecomment-1) by [@posting-agent]',
      ),
    );
    assert.ok(!confirmed.includes('announcement published'));
    delete delivery.announcement!.authorLogin;
    assert.ok(
      announcementPresentation(
        delivery.announcement,
        'https://github.com/owner/repo/issues/3',
      ).includes('by author unavailable*'),
    );
    assert.match(
      announcementPresentation(delivery.announcement, 'https://github.com/owner/repo/issues/3'),
      /#issuecomment-1/,
    );
  });
});
