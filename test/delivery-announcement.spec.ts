import { mock } from 'node:test';
import hydrateImplementation from './implementation-material-fixture.ts';
import type { ImplementationMaterialRead } from '../agent/tasks/implementation/implementation-material.ts';
import assert from 'node:assert/strict';

import { Value } from 'typebox/value';

import deliveryAnnouncement, {
  announcementPrecedesDelivery,
  announcementPresentation,
  reconcileAnnouncement,
  recheckAnnouncement,
} from '../agent/tasks/delivery/delivery-announcement.ts';
import { deliveryAnnouncementStateSchema } from '../agent/tasks/delivery/delivery-announcement-state.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import {
  announcementRecoveryAction,
  announcementRecoverySchema,
  type AnnouncementDelivery,
} from '../agent/tasks/delivery/delivery-announcement-recovery.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import { WorkflowPolicyHeld } from '../agent/tasks/live-workflow-policy.ts';

describe('agent/delivery-announcement', () => {
  let input: Parameters<typeof deliveryAnnouncement>[0];
  let delivery: AnnouncementDelivery;
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
      runtime: 'codex',
      request: { action: 'compose', id: 'a'.repeat(64) },
      operation: 'compose',
      delivery,
      publication: {
        item: {
          number: 3,
          itemDatabaseId: 3,
          itemNodeId: 'I_3',
          repositoryOwner: 'owner',
          repositoryName: 'repo',
        },
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
          observedAt: state?.composition?.observedAt ?? 1,
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
        if (delivery.announcement)
          assert.equal(Value.Check(deliveryAnnouncementStateSchema, delivery.announcement), true);
        if (delivery.announcementRecovery)
          assert.equal(
            Value.Check(announcementRecoverySchema, delivery.announcementRecovery),
            true,
          );
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
      publicText: 'Keeps the issue announcement with its delivered PR.',
    });
    assert.equal(prepared.status, 'announcement-prepared');
    assert.ok('digest' in prepared);
    return prepared;
  }
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should page complete announcement inputs in ${runtime} without resetting a candidate`, async () => {
      input.runtime = runtime;
      const provider = input.provider.announcement;
      const body = 'Complete delivery details 🦕.\n'.repeat(1000);
      input.provider.announcement = async (request) => ({ ...(await provider(request)), body });
      const context = await run('compose');
      assert.ok('contextMaterials' in context && context.contextMaterials);
      const read = context.contextMaterials.fields[0]!.request;
      const complete = await hydrateImplementation(context, (request) => run('compose', request));
      assert.equal((complete.event as { body: string }).body, body);
      await run('candidate', { publicText: 'The complete change.' });
      const before = JSON.stringify(delivery);
      await run('compose', read);
      assert.equal(JSON.stringify(delivery), before);
      skillDigest = 'b'.repeat(64);
      await assert.rejects(run('compose', read), /delivery-announcement-material-stale/);
      assert.equal(JSON.stringify(delivery), before);
      revoked = true;
      await assert.rejects(run('compose', read), /delivery-authority-revoked/);
      assert.equal(posts, 0);
      const material = read.material as ImplementationMaterialRead;
      await assert.rejects(run('announce', { material }), /delivery-authority-revoked/);
    });
  it('should persist the first failed prerequisite before composing an announcement', async () => {
    let saves = 0;
    input.provider.announcement = async () => {
      throw new Error('github-delivery-linkage-unverified');
    };
    input.save = async () => {
      saves++;
    };
    const result = await run('compose');
    assert.equal(result.status, 'announcement-blocked');
    assert.equal(saves, 1);
    assert.equal(delivery.announcement, undefined);
    assert.equal(delivery.announcementRecovery?.code, 'github-delivery-linkage-unverified');
    assert.equal(
      Value.Check(
        announcementRecoverySchema,
        JSON.parse(JSON.stringify(delivery.announcementRecovery)),
      ),
      true,
    );
    assert.match(result.presentation!, /github-delivery-linkage-unverified/);
  });
  it('should direct held missing-candidate recovery to compose and retain without access or linkage claims', async () => {
    input.provider.announcement = async () => {
      throw new Error('delivery-announcement-candidate-required');
    };
    await run('compose', { now: 100 });
    const presentation = announcementPresentation(
      delivery.announcement,
      'https://github.com/owner/repo/issues/3',
      undefined,
      delivery.announcementRecovery,
    );
    assert.equal(delivery.announcementRecovery?.code, 'delivery-announcement-candidate-required');
    assert.match(presentation, /no announcement write was attempted/i);
    assert.match(presentation, /compose and retain the announcement candidate/i);
    assert.doesNotMatch(presentation, /closing association|github access/i);
    assert.equal(posts, 0);
  });
  it('should not retain arbitrary provider text as a diagnostic code', async () => {
    input.provider.announcement = async () => {
      throw new Error('sensitive-material');
    };
    await run('compose', { now: 100 });
    assert.equal(delivery.announcementRecovery!.code, 'delivery-announcement-failed');
    assert.ok(!JSON.stringify(delivery).includes('sensitive-material'));
  });
  it('should check only when due and exhaust unchanged failure without another model turn', async () => {
    let now = 100;
    let checks = 0;
    input.provider.announcement = async () => {
      checks++;
      throw new Error('github-delivery-linkage-unverified');
    };
    await run('compose', { now });
    assert.equal(checks, 1);
    const first = delivery.announcementRecovery!.retryAfter!;
    const check = () => recheckAnnouncement({ ...input, now });
    assert.equal(announcementRecoveryAction(delivery, now), 'wait');
    now = first - 1;
    assert.equal(await check(), false);
    assert.equal(checks, 1);
    now = first;
    assert.equal(announcementRecoveryAction(delivery, now), 'check');
    for (let attempt = 2; attempt <= 5; attempt++) {
      assert.equal(await check(), false);
      assert.equal(checks, attempt);
      assert.equal(delivery.announcementRecovery!.attempts, attempt);
      now = delivery.announcementRecovery!.retryAfter ?? now;
    }
    assert.equal(delivery.announcementRecovery!.status, 'exhausted');
    now += 86400000;
    assert.equal(await check(), false);
    assert.equal(checks, 5);
    assert.equal(posts, 0);
  });
  it('should preserve reversible policy holds without consuming the recovery budget', async () => {
    input.provider.announcement = async () => {
      throw new Error('github-delivery-linkage-unverified');
    };
    await run('compose', { now: 100 });
    const saved = JSON.stringify(delivery);
    input.authorize = async () => {
      throw new WorkflowPolicyHeld('workflow-disabled');
    };
    await assert.rejects(
      recheckAnnouncement({ ...input, now: delivery.announcementRecovery!.retryAfter! }),
      WorkflowPolicyHeld,
    );
    assert.equal(JSON.stringify(delivery), saved);
    await assert.rejects(run('compose'), WorkflowPolicyHeld);
    assert.equal(JSON.stringify(delivery), saved);
  });
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should direct exhausted uncertainty to read-only comment reconciliation in ${runtime} without reposting`, async () => {
      input.runtime = runtime;
      await candidate();
      missing = true;
      await run('announce', { now: 100 });
      const retained = JSON.stringify(delivery.announcement);
      while (delivery.announcementRecovery!.status === 'retrying')
        await recheckAnnouncement({
          ...input,
          now: delivery.announcementRecovery!.retryAfter!,
        });
      assert.equal(delivery.announcementRecovery!.status, 'exhausted');
      const presentation = announcementPresentation(
        delivery.announcement,
        'https://github.com/owner/repo/issues/3',
        undefined,
        delivery.announcementRecovery,
      );
      assert.match(presentation, /automatic checks exhausted/i);
      assert.match(presentation, /read-only reconciliation of the original comment/i);
      assert.match(presentation, /do not compose or post a replacement/i);
      assert.doesNotMatch(presentation, /closing association/i);
      assert.equal(JSON.stringify(delivery.announcement), retained);
      assert.equal((await run('announce')).status, 'announcement-blocked');
      assert.equal(posts, 1);
    });
  it('should retain the same draft and preview while recovering a failed prerequisite', async () => {
    await candidate();
    const saved = JSON.stringify(delivery.announcement);
    const provider = input.provider.announcement;
    input.provider.announcement = async () => {
      throw new Error('github-delivery-linkage-unverified');
    };
    await run('announce', { now: 100 });
    delivery = JSON.parse(JSON.stringify(delivery));
    input.delivery = delivery;
    input.provider.announcement = provider;
    assert.equal(
      await recheckAnnouncement({ ...input, now: delivery.announcementRecovery!.retryAfter! }),
      true,
    );
    assert.equal(delivery.announcementRecovery, undefined);
    assert.equal(JSON.stringify(delivery.announcement), saved);
    assert.equal((await run('announce', {})).status, 'announced');
    assert.equal(posts, 1);
  });
  it('should reconcile an uncertain write deterministically without another snapshot or post', async () => {
    await candidate();
    lost = true;
    await run('announce', { now: 100 });
    const before = snapshots;
    assert.equal(
      await recheckAnnouncement({ ...input, now: delivery.announcementRecovery!.retryAfter! }),
      true,
    );
    assert.equal(snapshots, before);
    assert.equal(posts, 1);
    assert.equal(delivery.announcement!.receipt!.nodeId, 'IC_1');
    assert.equal(delivery.announcement!.publicText, undefined);
    assert.equal(delivery.announcement!.publication, undefined);
  });
  it('should hold native denials and missing references while respecting provider retry guidance', async () => {
    for (const code of [
      'delivery-authority-revoked',
      'dispatch-approval-denied',
      'github-delivery-closing-reference-missing',
      'github-delivery-linkage-observation-invalid',
    ]) {
      delivery = {};
      input.delivery = delivery;
      input.provider.announcement = async () => {
        throw new Error(code);
      };
      await run('compose', { now: 100 });
      assert.equal(announcementRecoveryAction(delivery, 86400000), 'wait');
      assert.match(
        announcementPresentation(
          delivery.announcement,
          'https://github.com/owner/repo/issues/3',
          undefined,
          delivery.announcementRecovery,
        ),
        /do not bypass a native denial/i,
      );
      assert.equal(posts, 0);
    }
    for (const classification of [
      'transport',
      'permission',
      'authentication',
      'rate-limit',
    ] as const) {
      delivery = {};
      input.delivery = delivery;
      input.provider.announcement = async () => {
        throw new GitHubWorkEventClientError(
          'github-notification-request-failed',
          'safe',
          {},
          undefined,
          providerDiagnostic('github', 'api-request', classification, {
            httpStatus: 429,
            retryAfterMs: 900000,
          }),
        );
      };
      await run('compose', { now: 100 });
      assert.equal(
        delivery.announcementRecovery!.providerDiagnostic!.classification,
        classification,
      );
      assert.equal(delivery.announcementRecovery!.retryAfter, 900100);
      if (classification === 'permission' || classification === 'authentication') {
        const recovery = delivery.announcementRecovery!;
        assert.match(
          announcementPresentation(
            delivery.announcement,
            'https://github.com/owner/repo/issues/3',
            undefined,
            {
              ...recovery,
              status: 'exhausted',
              code: 'delivery-announcement-unconfirmed',
            },
          ),
          /restore the indicated github access/i,
        );
      }
    }
  });
  for (const state of [false, true])
    it(`should publish one verified ${state ? 'draft' : 'ready'} announcement on its originating issue`, async () => {
      draft = state;
      await candidate();
      assert.equal(posts, 0);
      assert.equal((await run('announce', {})).status, 'announced');
      assert.equal(posts, 1);
      assert.match(comments[0]!.body, /https:\/\/github.com\/owner\/repo\/pull\/7/);
      assert.ok(comments[0]!.body.includes(state ? 'Draft.' : 'Ready for review.'));
      assert.match(comments[0]!.body, /agent-system-github-publication:pull-request-handoff:/);
      assert.deepEqual(delivery.announcement?.receipt, { nodeId: 'IC_1', databaseId: 1 });
    });
  it('should reconcile repeated delivery after restart without regenerating text or reading changed pr status', async () => {
    await candidate();
    await run('announce', {});
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
    await candidate();
    lost = true;
    assert.equal((await run('announce', {})).status, 'announcement-blocked');
    assert.equal(delivery.announcement?.attempted, true);
    assert.equal(delivery.announcement?.receipt, undefined);
    assert.ok(delivery.announcement?.publicText);
    assert.ok(delivery.announcement?.publication);
    assert.equal((await run('announce')).status, 'announced');
    assert.equal(delivery.announcement?.publicText, undefined);
    assert.equal(delivery.announcement?.publication, undefined);
    assert.equal(posts, 1);
  });
  it('should retain uncertainty when a completed post cannot be found', async () => {
    await candidate();
    missing = true;
    await run('announce', {});
    const retry = await run('announce');
    assert.equal(retry.status, 'announcement-blocked');
    assert.ok('code' in retry && retry.code === 'delivery-announcement-unconfirmed');
    assert.equal(posts, 1);
  });
  it('should not clear an uncertain attempt when reconciliation is denied', async () => {
    await candidate();
    missing = true;
    await run('announce', {});
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
    await candidate();
    rejected = true;
    await run('announce', {});
    assert.equal(delivery.announcement?.attempted, false);
    rejected = false;
    await candidate();
    assert.equal((await run('announce', {})).status, 'announced');
    assert.equal(comments.length, 1);
  });
  it('should reject stale draft status and require a fresh candidate before the first post', async () => {
    await candidate();
    draft = true;
    assert.equal((await run('announce', {})).status, 'announcement-blocked');
    assert.equal(posts, 0);
    const refreshed = await candidate();
    await run('announce', { digest: refreshed.digest });
    assert.match(comments[0]!.body, /Draft\./);
  });
  it('should publish the exact candidate after composer and cosmetic pr metadata changes', async () => {
    await candidate();
    const publicText = delivery.announcement!.publicText;
    skillDigest = 'b'.repeat(64);
    const read = input.provider.announcement;
    input.provider.announcement = async (request) => ({
      ...(await read(request)),
      title: 'edited title',
      body: 'edited description',
    });
    assert.equal((await run('announce', {})).status, 'announced');
    assert.equal(posts, 1);
    assert.ok(comments[0]!.body.includes(publicText!));
  });
  it('should continue to reject private candidate content', async () => {
    await run('compose');
    await run('candidate', { publicText: 'password=secret' });
    assert.equal(posts, 0);
    assert.equal(delivery.announcement?.publicText, undefined);
  });
  it('should stop before reading or publishing when authority is revoked', async () => {
    await candidate();
    revoked = true;
    await run('announce', {});
    assert.equal(posts, 0);
    assert.equal(reads, 0);
  });
  for (const uncertain of [false, true])
    it(`should never replace edited or deleted announcements with ${uncertain ? 'uncertain' : 'confirmed'} publication`, async () => {
      await candidate();
      lost = uncertain;
      await run('announce');
      comments[0]!.body = comments[0]!.body.replace('Keeps', 'Changes');
      assert.equal(
        (await run('announce')).status,
        uncertain ? 'announcement-blocked' : 'announced',
      );
      comments.length = 0;
      assert.equal(
        (await run('announce')).status,
        uncertain ? 'announcement-blocked' : 'announced',
      );
      assert.equal(posts, 1);
      assert.equal(Boolean(delivery.announcement!.publicText), uncertain);
    });
  it('should expose a verified receipt for feedback suppression after a response loss', async () => {
    await candidate();
    lost = true;
    await run('announce', {});
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
  it('should return the published announcement once and retain only receipt metadata after restart', async () => {
    const preview = await candidate();
    const text = delivery.announcement!.publicText!;
    assert.match(preview.presentation!, /PR announcement draft/);
    assert.match(
      announcementPresentation(delivery.announcement, 'https://github.com/owner/repo/issues/3'),
      /announcement pending/,
    );
    const result = await run('announce');
    assert.ok('presentation' in result);
    assert.ok(result.presentation!.includes(text.split('\n')[0]!));
    assert.match(result.presentation!, /#issuecomment-1/);
    assert.equal(delivery.announcement!.publicText, undefined);
    assert.equal(delivery.announcement!.publication, undefined);
    assert.equal(delivery.announcement!.composition, undefined);
    assert.deepEqual(delivery.announcement!.snapshot, {
      pullRequestNodeId: 'PR_7',
      pullRequestNumber: 7,
      head: 'a'.repeat(40),
    });
    assert.deepEqual(delivery.announcement!.receipt, { nodeId: 'IC_1', databaseId: 1 });
    assert.equal(
      announcementPresentation(delivery.announcement, 'https://github.com/owner/repo/issues/3'),
      '',
    );
    delivery = JSON.parse(JSON.stringify(delivery));
    input.delivery = delivery;
    const before = reads;
    for (const operation of ['compose', 'candidate', 'announce'] as const) {
      const repeated = await run(operation);
      assert.equal(repeated.status, 'announced');
      assert.ok('presentation' in repeated);
      assert.equal(repeated.presentation, '');
    }
    assert.equal(posts, 1);
    assert.equal(reads, before);
  });
  it('should drain confirmed content and preserve the receipt when its card renderer fails', async () => {
    await candidate();
    const body = delivery.announcement!.publicText!;
    const original = String.prototype.replace;
    const stub = mock.method(
      String.prototype,
      'replace',
      function (this: string, ...args: Parameters<typeof original>) {
        if (String(this) === body && String(args[0]) === String(/\r\n|\r/gu))
          throw new Error('card formatter unavailable');
        return original.apply(this, args);
      },
    );
    try {
      const result = await run('announce');
      assert.equal(result.status, 'announced');
      assert.ok('presentation' in result && result.presentation?.includes('#issuecomment-1'));
      assert.equal(delivery.announcement!.publicText, undefined);
      assert.equal(delivery.announcement!.publication, undefined);
      assert.deepEqual(delivery.announcement!.receipt, { nodeId: 'IC_1', databaseId: 1 });
      assert.equal((await run('announce')).status, 'announced');
      assert.equal(posts, 1);
    } finally {
      stub.mock.restore();
    }
  });
  it('should identify a later published head only for the same reconciled pr', async () => {
    await candidate();
    const publication = {
      ...delivery,
      reconciled: true,
      pushedHead: 'a'.repeat(40),
      pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
    };
    assert.equal(announcementPrecedesDelivery(publication), false);
    publication.pushedHead = 'b'.repeat(40);
    assert.equal(announcementPrecedesDelivery(publication), true);
    assert.equal(announcementPrecedesDelivery({ ...publication, reconciled: false }), false);
    assert.equal(announcementPrecedesDelivery({ ...publication, pushedHead: undefined }), false);
    assert.equal(announcementPrecedesDelivery({ ...publication, announcement: undefined }), false);
    for (const pullRequest of [
      { pullRequestNodeId: 'PR_other', pullRequestNumber: 7 },
      { pullRequestNodeId: 'PR_7', pullRequestNumber: 8 },
    ])
      assert.equal(announcementPrecedesDelivery({ ...publication, pullRequest }), false);
    assert.equal(announcementPrecedesDelivery(undefined), false);
  });
});
