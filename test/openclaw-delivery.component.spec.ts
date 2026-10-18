import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import announcementFixture from './delivery-announcement-fixture.ts';

import { automationHash } from '../agent/automation-hash.ts';
import openClawDelivery from '../agent/openclaw-delivery.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';

const head = 'a'.repeat(40);
const response = (value: unknown) => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: '',
  timedOut: false,
  truncated: false,
});

describe('agent/openclaw-delivery', () => {
  let announcement: ReturnType<typeof announcementFixture>;
  let root: string, record: OpenClawDispatchRecord;
  let creates: number, pushes: number, saves: number;
  let remote: string,
    dirty: boolean,
    lost: boolean,
    missing: boolean,
    failLink: boolean,
    revoked: boolean;
  let pr: Record<string, unknown> | undefined;
  let input: Omit<Parameters<typeof openClawDelivery>[0], 'action'>;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'openclaw-delivery-')));
    announcement = announcementFixture({ login: 'agent', nodeId: 'U_agent', type: 'User' });
    creates = pushes = saves = 0;
    remote = '';
    dirty = lost = missing = failLink = revoked = false;
    pr = undefined;
    const result = {
      version: 1 as const,
      outcome: 'plan-ready' as const,
      summary: 'Plan',
      assessment: 'Plan',
      plan: 'Plan',
      fullAssessment: 'Complete plan',
      evidence: [],
      progress: { completed: [], remaining: [] },
    };
    const source = { runId: 'operator-run', inputEventId: 'operator-input' };
    record = {
      id: 'd'.repeat(64),
      intakeId: 'e'.repeat(64),
      issueKey: 'f'.repeat(64),
      sourceThreadId: 'intake',
      phase: 'complete',
      createdAt: 1,
      manifestDigest: 'b'.repeat(64),
      worktree: root,
      threadId: 'issue-chat',
      sessionCreation: {
        attempted: true,
        verified: true,
        sessionId: 'issue-session',
        sourceSessionId: 'intake',
        sourceRunId: 'run',
        sourceToolCallId: 'call',
      },
      result,
      handoff: { at: 2, by: 'issue-chat', turnId: 'operator-run' },
      work: { assessmentDigest: automationHash(result), publication: source },
    };
    input = {
      record,
      selectAnnouncement: async (retained) => ({
        version: 1,
        requestedSkill: 'reply',
        defaultSkill: true,
        observedAt: retained?.composition.observedAt ?? 1,
        skill: {
          name: 'reply',
          path: '/skills/reply/SKILL.md',
          scope: 'user',
          digest: 'a'.repeat(64),
        },
      }),
      source,
      base: 'main',
      recipients: [],
      feedbackEnabled: false,
      signal: new AbortController().signal,
      intake: {
        id: record.intakeId,
        issue: { number: 3, databaseId: 20, nodeId: 'I_issue' },
        repository: { owner: { login: 'owner' }, name: 'repo', nodeId: 'R_repo' },
        assignment: { actor: { login: 'operator', nodeId: 'U_operator' } },
      } as IntakeRecord,
      async save() {
        saves++;
      },
      async reauthorize() {
        if (revoked) throw new Error('dispatch-policy-changed');
      },
      async assertCurrent() {
        if (revoked) throw new Error('dispatch-policy-changed');
      },
      async connect() {
        return {
          async git(argv) {
            if (argv[0] === 'branch') return 'task-branch';
            if (argv.includes('--show-toplevel')) return root;
            if (argv[0] === 'rev-parse') return head;
            if (argv[0] === 'status') return dirty ? ' M file' : '';
            if (argv[0] === 'rev-list') return '1';
            if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
            if (argv[0] === 'ls-remote') return remote ? `${remote}\trefs/heads/task-branch` : '';
            if (argv[0] === 'push') {
              pushes++;
              remote = head;
            }
            return '';
          },
          account: {
            identity: { login: 'agent', nodeId: 'U_agent' },
            async execute(argv, stdin) {
              const comment = announcement.execute(argv, stdin);
              if (comment) return comment;
              if (argv.includes('graphql')) {
                if (failLink) throw new Error('link read failed');
                return response({
                  id: 'PR_7',
                  closingIssuesReferences: { nodes: [{ id: 'I_issue' }] },
                });
              }
              const endpoint = argv.find((arg) => arg.startsWith('repos/'));
              if (endpoint === 'repos/owner/repo/issues/3')
                return response({ databaseId: 20, nodeId: 'I_issue', number: 3, title: 'Issue' });
              if (endpoint === 'repos/owner/repo/pulls' && argv.includes('GET'))
                return response(pr ? [pr] : []);
              if (endpoint === 'repos/owner/repo/pulls' && argv.includes('POST')) {
                creates++;
                assert.ok(record.work?.delivery?.creationAttempted);
                if (!missing)
                  pr = {
                    itemNodeId: 'PR_7',
                    number: 7,
                    state: 'open',
                    baseRef: 'main',
                    headRef: 'task-branch',
                    headRepository: 'owner/repo',
                    ...JSON.parse(stdin!),
                  };
                if (lost || missing) throw new Error('response lost');
                return response(pr);
              }
              if (
                endpoint === 'repos/owner/repo/pulls/7' &&
                argv.some((arg) => arg.includes('draft,state'))
              )
                return response({
                  nodeId: 'PR_7',
                  draft: announcement.draft,
                  state: 'open',
                  head: remote,
                  title: pr?.title,
                  body: pr?.body,
                });
              if (endpoint === 'repos/owner/repo/pulls/7')
                return response({
                  nodeId: 'PR_7',
                  repositoryId: 'R_repo',
                  headRepositoryId: 'R_repo',
                  headSha: remote,
                  authorId: 'U_agent',
                  baseRef: 'main',
                  headRef: 'task-branch',
                  state: 'open',
                  number: 7,
                });
              throw new Error('unexpected request');
            },
          },
        };
      },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const request = (
    operation:
      'prepare' | 'publish' | 'reconcile' | 'present' | 'compose' | 'candidate' | 'announce',
    extra = {},
  ) =>
    openClawDelivery({
      ...input,
      action: { action: 'delivery', id: record.id, operation, ...extra },
    });
  async function publish() {
    const prepared = await request('prepare', { title: 'Fix issue', body: 'Closes #3' });
    assert.ok('digest' in prepared);
    return request('publish', { digest: prepared.digest, title: 'Fix issue', body: 'Closes #3' });
  }
  for (const draft of [false, true])
    it(`should announce a ${draft ? 'draft' : 'ready'} pr and preserve its private card`, async () => {
      await publish();
      announcement.draft = draft;
      const context = await request('compose');
      assert.ok('digest' in context);
      const preview = await request('candidate', {
        digest: context.digest,
        publicText: 'Delivers the requested change.',
      });
      assert.ok('digest' in preview);
      assert.equal((await request('announce', { digest: preview.digest })).status, 'announced');
      await request('announce');
      const shown = await request('present');
      assert.ok('presentation' in shown);
      assert.match(shown.presentation!, /Pull request opened/);
      assert.match(shown.presentation!, /#issuecomment-91/);
      assert.equal(announcement.posts, 1);
      assert.ok(announcement.comments[0]!.body.includes(draft ? 'Draft.' : 'Ready for review.'));
      assert.equal(creates, 1);
      assert.equal(pushes, 1);
    });
  it('should reconcile a lost announcement response after restart without recreating the pr', async () => {
    await publish();
    const context = await request('compose');
    assert.ok('digest' in context);
    const preview = await request('candidate', {
      digest: context.digest,
      publicText: 'Delivers the requested change.',
    });
    assert.ok('digest' in preview);
    announcement.lost = true;
    assert.equal(
      (await request('announce', { digest: preview.digest })).status,
      'announcement-blocked',
    );
    assert.equal(record.work!.delivery!.reconciled, true);
    assert.equal(record.work!.delivery!.announcement!.attempted, true);
    input.record = record = JSON.parse(JSON.stringify(record));
    announcement.lost = false;
    assert.equal((await request('announce')).status, 'announced');
    assert.equal(announcement.posts, 1);
    assert.equal(creates, 1);
    assert.equal(pushes, 1);
  });

  it('should publish once and retain the issue pr session binding with a quoted card and truthful feedback availability', async () => {
    assert.equal((await publish()).status, 'published');
    const shown = await request('present');
    assert.ok('presentation' in shown);
    assert.match(shown.presentation!, /^> ## 🔀 Pull request opened/m);
    assert.match(shown.presentation!, /issues\/3/);
    assert.match(shown.presentation!, /pull\/7/);
    assert.match(shown.presentation!, /Automatic GitHub feedback delivery is not available/);
    input.feedbackEnabled = true;
    const enabled = await request('present');
    assert.ok('presentation' in enabled);
    assert.match(enabled.presentation!, /originating item or review thread/);
    const binding = record.work!.delivery!.binding;
    assert.equal(binding.sessionId, 'issue-session');
    assert.equal(binding.threadId, 'issue-chat');
    assert.equal(binding.issueId, 'I_issue');
    assert.equal((await request('reconcile')).status, 'ready');
    await publish();
    assert.equal(creates, 1);
    assert.equal(pushes, 1);
    assert.ok(saves > 0);
  });
  it('should recover a lost creation response using the same provider pr', async () => {
    lost = true;
    await assert.rejects(publish());
    assert.equal(record.work!.delivery!.creationAttempted, true);
    const restored = JSON.parse(JSON.stringify(record)) as OpenClawDispatchRecord;
    input.record = record = restored;
    lost = false;
    await publish();
    assert.equal(creates, 1);
    assert.equal(record.work!.delivery!.pullRequest?.pullRequestNumber, 7);
  });
  it('should rebuild the complete card after interrupted presentation without republishing', async () => {
    await publish();
    const persisted = structuredClone(record);
    const save = input.save;
    input.save = async () => {
      throw new Error('presentation-interrupted');
    };
    await assert.rejects(request('present'), /presentation-interrupted/);
    input.record = record = structuredClone(persisted);
    input.save = save;
    const result = await request('present');
    assert.ok('presentation' in result && typeof result.presentation === 'string');
    assert.match(result.presentation, /^> ## 🔀 Pull request opened/m);
    assert.match(result.presentation, /issues\/3/);
    assert.match(result.presentation, /pull\/7/);
    assert.deepEqual(record.work!.delivery!.pullRequest, persisted.work!.delivery!.pullRequest);
    assert.equal(creates, 1);
    assert.equal(pushes, 1);
  });
  it('should refuse a second create when the attempted creation remains uncertain', async () => {
    missing = true;
    await assert.rejects(publish());
    missing = false;
    await assert.rejects(publish(), /delivery-creation-uncertain/);
    assert.equal(creates, 1);
  });
  it('should resume linkage on the checkpointed pr without creating another', async () => {
    failLink = true;
    await assert.rejects(publish());
    assert.equal(record.work!.delivery!.pullRequest?.pullRequestNumber, 7);
    assert.equal(record.work!.delivery!.reconciled, false);
    failLink = false;
    await publish();
    assert.equal(creates, 1);
  });
  it('should reject unauthorized stale dirty divergent and revoked publication before writes', async () => {
    const permission = record.work!.publication;
    delete record.work!.publication;
    await assert.rejects(publish(), /delivery-human-publication-required/);
    record.work!.publication = permission;
    dirty = true;
    await assert.rejects(publish(), /delivery-uncommitted-work/);
    dirty = false;
    await assert.rejects(
      request('publish', { title: 'Fix', body: 'Fix', digest: '0'.repeat(64) }),
      /delivery-preview-stale/,
    );
    remote = 'b'.repeat(40);
    await assert.rejects(publish(), /delivery-remote-head-diverged/);
    revoked = true;
    await assert.rejects(publish(), /dispatch-policy-changed/);
    assert.equal(creates, 0);
    assert.equal(pushes, 0);
  });
});
