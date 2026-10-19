import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import announcementFixture from './delivery-announcement-fixture.ts';

import { automationHash } from '../agent/automation-hash.ts';
import openClawDelivery from '../agent/openclaw-delivery.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';

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
  let head: string;
  let ancestor: boolean;
  let patches: number, failPatch: 'before' | 'after' | false;
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
    head = 'a'.repeat(40);
    ancestor = true;
    patches = 0;
    failPatch = false;
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
            if (argv[0] === 'merge-base') {
              assert.deepEqual(argv, ['merge-base', '--is-ancestor', remote, head]);
              if (!ancestor) throw new Error('not an ancestor');
            }
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
              if (endpoint === 'repos/owner/repo/pulls/7' && argv.includes('PATCH')) {
                patches++;
                if (failPatch === 'before') throw new Error('update interrupted');
                pr = { ...pr, ...JSON.parse(stdin!) };
                if (failPatch === 'after') throw new Error('update interrupted');
                return response(pr);
              }
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
  async function publish(content = { title: 'Fix issue', body: 'Closes #3' }) {
    const prepared = await request('prepare', content);
    assert.ok('digest' in prepared);
    return request('publish', { digest: prepared.digest, ...content });
  }
  for (const draft of [false, true])
    it(`should reconcile announce and present a ${draft ? 'draft' : 'ready'} pr with uncommitted edits`, async () => {
      await publish();
      dirty = true;
      await request('reconcile');
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
  it('should reconcile only the lost announcement after restart despite newer local work', async () => {
    await publish();
    head = 'b'.repeat(40);
    const connect = input.connect;
    input.connect = async () => ({
      ...(await connect()),
      git: async () => {
        throw new Error('announcement recovery must not inspect newer local work');
      },
    });
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
  it('should prepare a new commit on the retained delivery without changing its receipt', async () => {
    await publish();
    const retained = structuredClone(record.work!.delivery!);
    head = 'b'.repeat(40);
    const prepared = await request('prepare');
    assert.ok('operation' in prepared && prepared.operation);
    assert.equal(prepared.operation.id, retained.id);
    assert.equal(prepared.operation.binding.head, head);
    assert.deepEqual(prepared.operation.pullRequest, retained.pullRequest);
    assert.deepEqual(record.work!.delivery, retained);
    head = 'c'.repeat(40);
    const refreshed = await request('publish', { digest: prepared.digest });
    assert.equal(refreshed.status, 'prepared');
    assert.ok('digest' in refreshed && refreshed.digest !== prepared.digest);
    assert.deepEqual(record.work!.delivery, retained);
    assert.equal(pushes, 1);
  });
  it('should reject a changed session while retaining delivery across configuration changes', async () => {
    await publish();
    record.sessionCreation!.sessionId = 'other-session';
    await assert.rejects(request('prepare'), /delivery-session-changed/);
    record.sessionCreation!.sessionId = 'issue-session';
    record.manifestDigest = 'c'.repeat(64);
    assert.equal((await request('prepare')).status, 'prepared');
    assert.equal(pushes, 1);
  });
  it('should fast forward the verified branch while retaining the same pr', async () => {
    await publish();
    const receipt = structuredClone(record.work!.delivery!.pullRequest);
    head = 'b'.repeat(40);
    await publish();
    assert.equal(remote, head);
    assert.equal(record.work!.delivery!.pushedHead, head);
    assert.equal(record.work!.delivery!.binding.head, head);
    assert.deepEqual(record.work!.delivery!.pullRequest, receipt);
    assert.equal(record.work!.delivery!.reconciled, true);
    assert.equal(creates, 1);
    assert.equal(pushes, 2);
  });
  it('should reject a rewritten commit or unexpected remote head before pushing', async () => {
    await publish();
    head = 'b'.repeat(40);
    ancestor = false;
    await assert.rejects(publish(), /not an ancestor/);
    ancestor = true;
    remote = 'c'.repeat(40);
    await assert.rejects(publish(), /delivery-remote-head-diverged/);
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
  });
  it('should reject a replacement pr before advancing the remote branch', async () => {
    await publish();
    head = 'b'.repeat(40);
    pr!.itemNodeId = 'PR_other';
    await assert.rejects(publish(), /no longer matches/);
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
  });
  for (const interruption of ['before', 'after'] as const)
    it(`should recover metadata updates interrupted ${interruption} the provider write`, async () => {
      await publish();
      const content = { title: 'Updated fix', body: 'Includes the follow-up change.' };
      failPatch = interruption;
      await assert.rejects(publish(content), /update interrupted/);
      assert.equal(record.work!.delivery!.reconciled, false);
      input.record = record = structuredClone(record);
      failPatch = false;
      await publish(content);
      assert.equal(pr!.title, content.title);
      assert.equal(pr!.body, content.body + '\n\nCloses https://github.com/owner/repo/issues/3');
      assert.equal(patches, interruption === 'before' ? 2 : 1);
      assert.equal(creates, 1);
      assert.equal(pushes, 1);
      assert.equal(record.work!.delivery!.reconciled, true);
    });
  it('should freeze content only until uncertain creation has been reconciled', async () => {
    lost = true;
    await assert.rejects(publish(), /response lost/);
    const content = { title: 'Updated fix', body: 'Closes #3 with more detail.' };
    await assert.rejects(publish(content), /delivery-content-changed/);
    assert.equal(patches, 0);
    lost = false;
    await publish();
    await publish(content);
    assert.equal(pr!.title, content.title);
    assert.equal(pr!.body, content.body);
    assert.equal(creates, 1);
  });
  it('should preserve github body edits when explicitly updating only the title', async () => {
    await publish();
    pr!.body = 'Operator clarification. Closes #3';
    head = 'b'.repeat(40);
    await publish();
    assert.equal(pr!.body, 'Operator clarification. Closes #3');
    await publish({ title: 'Revised title', body: 'Closes #3' });
    assert.equal(pr!.title, 'Revised title');
    assert.equal(pr!.body, 'Operator clarification. Closes #3');
  });
  it('should retain the requested update when the provider does not confirm its content', async () => {
    await publish();
    const connect = input.connect;
    input.connect = async () => {
      const connection = await connect();
      const execute = connection.account.execute;
      connection.account.execute = async (...args) =>
        args[0].includes('PATCH') ? response(pr) : execute(...args);
      return connection;
    };
    const content = { title: 'Revised title', body: 'Closes #3' };
    await assert.rejects(publish(content), /github-delivery-content-unverified/);
    assert.equal(record.work!.delivery!.reconciled, false);
    assert.deepEqual(record.work!.delivery!.contentUpdate, { title: content.title });
    input.connect = connect;
    await publish(content);
    assert.equal(pr!.title, content.title);
    assert.equal(record.work!.delivery!.contentUpdate, undefined);
    assert.equal(creates, 1);
  });
  for (const lostAnnouncement of [false, true])
    it(`should recover an interrupted follow-up push with a ${lostAnnouncement ? 'pending' : 'confirmed'} announcement`, async () => {
      await publish();
      const context = await request('compose');
      assert.ok('digest' in context);
      const preview = await request('candidate', {
        digest: context.digest,
        publicText: 'Delivers the requested change.',
      });
      assert.ok('digest' in preview);
      announcement.lost = lostAnnouncement;
      await request('announce', { digest: preview.digest });
      const retained = structuredClone(record.work!.delivery!);
      head = 'b'.repeat(40);
      const connect = input.connect;
      input.connect = async () => {
        const connection = await connect();
        const git = connection.git;
        connection.git = async (argv) => {
          const output = await git(argv);
          if (argv[0] === 'push') throw new Error('push response lost');
          return output;
        };
        return connection;
      };
      await assert.rejects(publish(), /push response lost/);
      assert.equal(remote, head);
      assert.equal(record.work!.delivery!.pushedHead, retained.pushedHead);
      input.record = record = structuredClone(record);
      input.connect = connect;
      await publish();
      assert.equal(record.work!.delivery!.id, retained.id);
      assert.deepEqual(record.work!.delivery!.pullRequest, retained.pullRequest);
      assert.deepEqual(record.work!.delivery!.announcement, retained.announcement);
      announcement.lost = false;
      assert.equal((await request('announce')).status, 'announced');
      const shown = await request('present');
      assert.ok('presentation' in shown);
      assert.match(shown.presentation!, /#issuecomment-91/);
      assert.equal(creates, 1);
      assert.equal(pushes, 2);
      assert.equal(announcement.posts, 1);
    });
  it('should rebuild the retained card without git provider or publication permission', async () => {
    await publish();
    const persisted = structuredClone(record);
    delete record.work!.publication;
    input.connect = async () => {
      throw new Error('must not connect for presentation');
    };
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
  it('should refresh stale previews and reject unauthorized dirty divergent and revoked publication before writes', async () => {
    const permission = record.work!.publication;
    delete record.work!.publication;
    await assert.rejects(publish(), /delivery-human-publication-required/);
    record.work!.publication = permission;
    dirty = true;
    await assert.rejects(publish(), /delivery-uncommitted-work/);
    dirty = false;
    assert.equal(
      (await request('publish', { title: 'Fix', body: 'Fix', digest: '0'.repeat(64) })).status,
      'prepared',
    );
    remote = 'b'.repeat(40);
    await assert.rejects(publish(), /delivery-remote-head-diverged/);
    revoked = true;
    await assert.rejects(publish(), /dispatch-policy-changed/);
    assert.equal(creates, 0);
    assert.equal(pushes, 0);
  });
  it('should tolerate the previously verified head briefly lagging after a followup push', async () => {
    let preview = await request('prepare', { title: 'Initial', body: 'Initial body.' });
    assert.ok('digest' in preview);
    await request('publish', { digest: preview.digest, title: 'Initial', body: 'Initial body.' });
    head = 'b'.repeat(40);
    const connect = input.connect;
    let lagged = false;
    input.connect = async () => {
      const connection = await connect();
      const execute = connection.account.execute;
      return {
        ...connection,
        account: {
          ...connection.account,
          execute: async (...args) => {
            const result = await execute(...args);
            if (
              !lagged &&
              remote === head &&
              args[0].some((value) => value.includes('headSha:.head.sha'))
            ) {
              lagged = true;
              return {
                ...result,
                stdout: JSON.stringify({ ...JSON.parse(result.stdout), headSha: 'a'.repeat(40) }),
              };
            }
            return result;
          },
        },
      };
    };
    preview = await request('prepare', { title: 'Updated', body: 'Updated body.' });
    assert.ok('digest' in preview);
    const recovered = await request('publish', {
      digest: preview.digest,
      title: 'Updated',
      body: 'Updated body.',
    });
    assert.equal(recovered.status, 'published');
    assert.equal(creates, 1);
    assert.equal(pushes, 2);
    assert.equal(patches, 1);
  });
});
