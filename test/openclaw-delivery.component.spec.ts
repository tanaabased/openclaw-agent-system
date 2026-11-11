import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverRetainedAnnouncement } from '../agent/delivery-announcement.ts';
import { feedbackRevision } from '../agent/feedback-source.ts';
import manualPullRequest from '../agent/manual-pull-request.ts';
import { openClawWorkSlot } from '../agent/openclaw-continuation.ts';
import { authorizeFeedback, type OpenClawFeedbackProvider } from '../agent/openclaw-feedback.ts';
import { account, fixturePullRequest, intakeFixture } from './github-intake-fixture.ts';

import announcementFixture from './delivery-announcement-fixture.ts';

import selectFeedbackStage from '../agent/feedback-stage.ts';
import openClawSkill from '../agent/openclaw-skill.ts';

import openClawDelivery from '../agent/openclaw-delivery.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';

const response = (value: unknown) => ({
  exitCode: 0,
  stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(value),
  stderr: '',
  timedOut: false,
  truncated: false,
});

describe('agent/openclaw-delivery', () => {
  let branch: string;
  let announcement: ReturnType<typeof announcementFixture>;
  let root: string, record: OpenClawDispatchRecord;
  let creates: number, pushes: number, saves: number, linkWrites: number;
  let linked: boolean, lostLink: boolean;
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
  let rejectCreation = false;
  let adopted = false;
  beforeEach(async () => {
    rejectCreation = false;
    adopted = false;
    root = await realpath(await mkdtemp(join(tmpdir(), 'openclaw-delivery-')));
    announcement = announcementFixture({ login: 'agent', nodeId: 'U_agent', type: 'User' });
    creates = pushes = saves = linkWrites = 0;
    linked = lostLink = false;
    head = 'a'.repeat(40);
    ancestor = true;
    patches = 0;
    failPatch = false;
    remote = '';
    dirty = lost = missing = failLink = revoked = false;
    pr = undefined;
    const source = { runId: 'operator-run', inputEventId: 'operator-input' };
    record = {
      id: 'd'.repeat(64),
      intakeId: 'e'.repeat(64),
      issueKey: 'f'.repeat(64),
      sourceThreadId: 'intake',

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
      handoff: { at: 2, by: 'issue-chat', turnId: 'operator-run' },
      work: { publication: source },
    };
    branch = 'task-branch';
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
        receiving: { login: 'agent', nodeId: 'U_agent' },
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
            if (argv[0] === 'branch') return branch;
            if (argv.includes('--show-toplevel')) return root;
            if (argv[0] === 'rev-parse')
              return argv.some((arg) => arg.startsWith('refs/agent-system/pr/')) ? remote : head;
            if (argv[0] === 'status') return dirty ? ' M file' : '';
            if (argv[0] === 'rev-list') return '1';
            if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
            if (argv[0] === 'ls-remote') return remote ? `${remote}\trefs/heads/task-branch` : '';
            if (argv[0] === 'merge-base') {
              assert.deepEqual(argv, ['merge-base', '--is-ancestor', remote, head]);
              if (!ancestor) throw new Error('not an ancestor');
            }
            if (argv[0] === 'push') {
              assert.ok(!argv.some((arg) => arg.includes('force')));
              if (record.adoptedPullRequest)
                assert.ok(argv.includes(`${head}:refs/heads/collaborator-work`));
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
                const request = JSON.parse(stdin!);
                if (request.query.startsWith('mutation')) {
                  assert.deepEqual(request.variables, { issue: 'I_issue', pullRequests: ['PR_7'] });
                  linkWrites++;
                  if (failLink) throw new Error('link write failed');
                  linked = true;
                  if (lostLink) throw new Error('link response lost');
                  return response({
                    id: 'I_issue',
                  });
                }
                if (failLink) throw new Error('link read failed');
                return response({
                  id: 'PR_7',
                  closingIssuesReferences: { nodes: linked ? [{ id: 'I_issue' }] : [] },
                });
              }
              const endpoint = argv.find((arg) => arg.startsWith('repos/'));
              if (
                endpoint === 'repos/owner/repo/pulls/7' &&
                argv.includes('{nodeId:.node_id,title,body}')
              )
                return response({ nodeId: pr?.itemNodeId, title: pr?.title, body: pr?.body });
              if (
                endpoint === 'repos/owner/repo/pulls/7' &&
                argv.some((arg) => arg.includes('branch:.head.ref'))
              )
                return response({
                  nodeId: 'PR_7',
                  number: 7,
                  state: 'open',
                  repositoryId: 'R_repo',
                  headRepositoryId: 'R_repo',
                  head: remote,
                  branch: pr?.headRef ?? 'collaborator-work',
                  base: pr?.baseRef ?? 'release',
                  authorId:
                    !pr?.headRef || pr.headRef === 'collaborator-work'
                      ? 'U_collaborator'
                      : (record.adoptedPullRequest?.authorId ??
                        (adopted ? 'U_operator' : 'U_agent')),
                  title: pr?.title,
                  body: pr?.body,
                });
              if (endpoint === 'repos/owner/repo/issues/3')
                return response({ databaseId: 20, nodeId: 'I_issue', number: 3, title: 'Issue' });
              if (endpoint === 'repos/owner/repo/pulls' && argv.includes('GET'))
                return response(pr ? [pr] : []);
              if (endpoint === 'repos/owner/repo/pulls' && argv.includes('POST')) {
                creates++;
                if (rejectCreation)
                  return {
                    ...response(null),
                    stdout: 'HTTP/2 403 Forbidden\n\n{}',
                    exitCode: 1,
                    stderr: 'gh: Resource not accessible by integration (HTTP 403)',
                  };
                assert.ok(record.delivery?.creationAttempted);
                const created = JSON.parse(stdin!);
                if (!missing)
                  pr = {
                    itemNodeId: 'PR_7',
                    number: 7,
                    state: 'open',
                    baseRef: created.base,
                    headRef: created.head,
                    headRepository: 'owner/repo',
                    ...created,
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
              if (
                adopted &&
                endpoint === 'repos/owner/repo/pulls/7' &&
                argv.some((arg) => arg.includes('itemNodeId:'))
              )
                return response(pr);
              if (endpoint === 'repos/owner/repo/pulls/7')
                return response({
                  nodeId: 'PR_7',
                  repositoryId: 'R_repo',
                  headRepositoryId: 'R_repo',
                  headSha: remote,
                  repositoryDatabaseId: 10,
                  headRepositoryDatabaseId: 10,
                  authorId:
                    record.adoptedPullRequest?.authorId ?? (adopted ? 'U_operator' : 'U_agent'),
                  baseRef:
                    record.adoptedPullRequest?.base ??
                    pr?.baseRef ??
                    (adopted ? 'release' : 'main'),
                  headRef: record.adoptedPullRequest?.branch ?? pr?.headRef ?? branch,
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
      | 'bind'
      | 'prepare'
      | 'publish'
      | 'reconcile'
      | 'present'
      | 'compose'
      | 'candidate'
      | 'announce',
    extra = {},
  ) =>
    openClawDelivery({
      ...input,
      action: { action: 'delivery', id: record.id, operation, ...extra },
    });
  async function publish(content = { title: 'Fix issue', body: 'Closes #3' }) {
    const prepared = await request('prepare', content);
    assert.ok('publishRequest' in prepared && prepared.publishRequest);
    return openClawDelivery({ ...input, action: { ...prepared.publishRequest, id: record.id } });
  }

  it('should use a custom checkout branch and keep the selected base through pr recovery', async () => {
    branch = 'pirog/custom-branch';
    const content = {
      title: 'Stacked fix',
      body: 'An authored stacked change.',
      base: 'release/2.x',
    };
    const preview = await request('prepare', content);
    assert.ok('publishRequest' in preview && preview.publishRequest);
    assert.equal(preview.publishRequest.base, content.base);
    lost = true;
    await assert.rejects(request('publish', content), /response lost/);
    assert.equal(record.delivery?.binding.base, content.base);
    assert.equal(pr?.headRef, branch);
    assert.equal(pr?.baseRef, content.base);
    await assert.rejects(
      request('publish', { ...content, base: 'other' }),
      /delivery-base-changed/,
    );
    lost = false;
    assert.equal((await request('reconcile')).status, 'ready');
    assert.equal(creates, 1);
  });

  it('should use the provider repository default when base is omitted', async () => {
    input.base = 'develop';
    assert.equal((await publish()).status, 'published');
    assert.equal(pr?.baseRef, 'develop');
  });

  it('should reconcile the original uncertain announcement after relinking and discarding pr creation state', async () => {
    await publish();
    await request('compose');
    await request('candidate', { publicText: 'The original change is ready.' });
    announcement.lost = true;
    assert.equal((await request('announce')).status, 'announcement-blocked');
    record.pullRequestLink = { pullRequestNodeId: 'PR_other', pullRequestNumber: 8 };
    delete record.delivery;
    announcement.lost = false;
    const recovered = await request('announce');
    assert.equal(recovered.status, 'announced');
    assert.equal(recovered.url, 'https://github.com/owner/repo/pull/7');
    assert.equal(announcement.posts, 1);
    assert.equal(creates, 1);
  });

  it('should announce a verified linked pr without a creation or implementation record', async () => {
    await publish();
    record.pullRequestLink = record.delivery!.pullRequest;
    delete record.delivery;
    delete record.progression;
    record.work!.scope = 'local';
    const connect = input.connect;
    input.connect = async () => ({
      ...(await connect()),
      git: async () => assert.fail('announcement must not inspect or publish local work'),
    });
    const composed = await request('compose');
    assert.equal(composed.status, 'composition-ready', JSON.stringify(composed));
    await request('candidate', { publicText: 'The linked change is ready for review.' });
    assert.equal((await request('announce')).status, 'announced');
    const saved = record;
    assert.equal(saved.delivery, undefined);
    assert.ok(saved.announcement?.receipt);
    assert.equal(announcement.posts, 1);
    assert.equal(creates, 1);
  });

  it('should request composition for a linked pr with no announcement draft', async () => {
    await publish();
    record.pullRequestLink = record.delivery!.pullRequest;
    delete record.delivery;
    const result = await request('announce');
    assert.equal(result.status, 'announcement-blocked');
    assert.ok('code' in result && result.code === 'delivery-announcement-candidate-required');
    assert.match(result.presentation!, /compose.*candidate/i);
    assert.equal(announcement.posts, 0);
    assert.equal(record.delivery, undefined);
    await request('compose');
    const withoutCandidate = await request('announce');
    assert.ok(
      'code' in withoutCandidate &&
        withoutCandidate.code === 'delivery-announcement-candidate-required',
    );
    assert.equal(announcement.posts, 0);
  });

  it('should honor a native denial before posting a composed announcement', async () => {
    await publish();
    await request('compose');
    await request('candidate', { publicText: 'The change is ready.' });
    input.reauthorize = async () => {
      throw new Error('native-approval-denied');
    };
    await assert.rejects(request('announce'), /native-approval-denied/);
    assert.equal(announcement.posts, 0);
  });

  it('should reject a mismatched linked pr before composing or posting an announcement', async () => {
    await publish();
    record.pullRequestLink = { pullRequestNodeId: 'PR_other', pullRequestNumber: 7 };
    delete record.delivery;
    const result = await request('compose');
    assert.equal(result.status, 'announcement-blocked');
    assert.ok('code' in result && result.code === 'delivery-announcement-pr-changed');
    assert.equal(announcement.posts, 0);
  });

  it('should publish authored content and link the current task without copied receipts', async () => {
    const content = { title: 'One poem', body: 'First line.\n\nSecond line.' };
    const prepared = await request('prepare', content);
    assert.ok('publishRequest' in prepared && prepared.publishRequest);
    assert.deepEqual(prepared.publishRequest, {
      action: 'delivery',
      operation: 'publish',
      ...content,
    });
    assert.equal(creates + pushes, 0);
    const published = await request('publish', { ...content, body: 'Revised poem.' });
    assert.equal(published.status, 'published');
    assert.ok('linkRequest' in published && published.linkRequest);
    const linked = await openClawDelivery({
      ...input,
      action: { ...published.linkRequest, id: record.id },
    });
    assert.equal(linked.status, 'linked');
    await request('reconcile');
    assert.equal(creates, 1);
    assert.ok(String(pr!.body).startsWith('Revised poem.'));
  });
  function authorizePrFeedback() {
    const fixture = intakeFixture();
    const pullRequest = fixturePullRequest(fixture);
    const item = {
      ...fixture.item,
      itemType: 'pull-request' as const,
      pullRequest,
      nodeId: 'PR_7',
      number: 7,
    };
    const source = {
      nodeId: 'C_feedback',
      databaseId: 42,
      author: { ...account },
      body: '@receiver update this PR',
      bodyTruncated: false,
      createdAt: '2026-10-07T10:03:00Z',
      updatedAt: '2026-10-07T10:03:00Z',
    };
    const event = {
      nodeId: item.nodeId,
      number: item.number,
      itemType: item.itemType,
      source: JSON.stringify(source),
      revision: feedbackRevision(source),
    };
    const provider: OpenClawFeedbackProvider = {
      ...fixture.client,
      getItem: async () => item,
      getItemContext: async () => ({
        title: 'PR',
        body: '',
        comments: [],
        labels: [],
        truncated: false,
      }),
      getIssueComment: async () => source,
      listIssueComments: async () => ({ comments: [source], truncated: false }),
      findOwnIssueComment: async () => undefined,
      createIssueComment: async () => {
        throw new Error('unexpected reply publication');
      },
      replies: {
        find: async () => undefined,
        create: async () => {
          throw new Error('unexpected review reply publication');
        },
      },
    };
    const assertCurrent = input.assertCurrent;
    input.assertCurrent = async () => {
      await authorizeFeedback({
        record,
        event,
        policy: fixture.policy,
        provider,
        intake: input.intake as IntakeRecord,
        assertCurrent,
      });
    };
    return { source, item, provider, policy: fixture.policy };
  }
  it('should allow unlinking without invalidating publication or repeating initial association', async () => {
    await publish();
    const receipt = structuredClone(record.delivery);
    assert.equal(
      (
        await openClawDelivery({
          ...input,
          action: { action: 'delivery', operation: 'link', id: record.id },
        })
      ).status,
      'linked',
    );
    assert.deepEqual(record.pullRequestLink, receipt!.pullRequest);
    input.connect = async () => {
      throw new Error('unlink does not require a provider write');
    };
    await openClawDelivery({
      ...input,
      operator: true,
      action: { action: 'delivery', operation: 'link', id: record.id, pullRequest: null },
    });
    assert.equal(record.pullRequestLink, null);
    await openClawDelivery({
      ...input,
      action: { action: 'delivery', operation: 'link', id: record.id },
    });
    assert.equal(record.pullRequestLink, null);
    assert.deepEqual(record.delivery, receipt);
    assert.equal(creates, 1);
  });

  it('should accept the current pr url without operator input while preserving association changes', async () => {
    await publish();
    const receipt = structuredClone(record.delivery);
    const pullRequest = `https://github.com/${input.intake.repository.owner.login}/${input.intake.repository.name}/pull/${receipt!.pullRequest!.pullRequestNumber}`;
    const linked = await openClawDelivery({
      ...input,
      operator: false,
      action: { action: 'delivery', operation: 'link', id: record.id, pullRequest },
    });
    assert.equal(linked.status, 'linked');
    assert.deepEqual(record.pullRequestLink, receipt!.pullRequest);
    for (const target of [null, pullRequest + '0'])
      await assert.rejects(
        openClawDelivery({
          ...input,
          operator: false,
          action: { action: 'delivery', operation: 'link', id: record.id, pullRequest: target },
        }),
        /delivery-link-operator-required/,
      );
    record.pullRequestLink = null;
    await assert.rejects(
      openClawDelivery({
        ...input,
        operator: false,
        action: { action: 'delivery', operation: 'link', id: record.id, pullRequest },
      }),
      /delivery-link-operator-required/,
    );
    assert.deepEqual(record.delivery, receipt);
    assert.equal(creates, 1);
  });

  function adoptTarget() {
    adopted = true;
    const f = intakeFixture();
    const source = fixturePullRequest(f, '8'.repeat(40));
    source.headRef = 'task-branch';
    Object.assign(input.intake, {
      assignment: undefined,
      issue: { number: 7, databaseId: 20, nodeId: 'PR_7' },
      initiation: { kind: 'operator' },
      pullRequest: manualPullRequest(f.repository, f.item),
    });
    input.base = 'release';
    record.context = JSON.stringify({ source: 'https://github.com/owner/repo/pull/7' });
    pr = {
      itemNodeId: 'PR_7',
      number: 7,
      state: 'open',
      baseRef: 'release',
      headRef: 'task-branch',
      headRepository: 'owner/repo',
      title: 'Original title',
      body: 'Original body',
      draft: true,
    };
    remote = source.headSha;
  }

  it('should update an adopted non-agent-authored draft without creating or changing metadata', async () => {
    adoptTarget();
    const original = structuredClone(pr);
    await request('prepare');
    assert.equal((await request('publish', {})).status, 'published');
    assert.equal(creates, 0);
    assert.equal(patches, 0);
    assert.deepEqual(pr, original);
    assert.equal(pushes, 1);
    assert.equal(record.delivery?.binding.branch, 'task-branch');
    assert.equal(record.delivery?.pullRequest?.pullRequestNumber, 7);
    const shown = await request('present');
    assert.ok('presentation' in shown);
    assert.match(String(shown.presentation), /Pull request\n/);
    assert.equal((await publish()).status, 'published');
    assert.equal(pushes, 1);
  });

  it('should refuse a removed adopted target before push and never create a replacement', async () => {
    adoptTarget();
    pr!.state = 'closed';
    await assert.rejects(publish(), /incompatible/);
    assert.equal(pushes, 0);
    assert.equal(creates, 0);
  });

  it('should preserve adopted work when native push authorization is denied', async () => {
    adoptTarget();
    input.reauthorize = async () => {
      throw new Error('native-approval-denied');
    };
    await assert.rejects(publish(), /native-approval-denied/);
    assert.equal(pushes, 0);
    assert.equal(creates, 0);
    assert.equal(record.delivery?.pullRequest?.pullRequestNumber, 7);
  });
  it('should bind and non-force update a collaborator pr without rewriting metadata or claiming prior publication', async () => {
    input.operator = true;
    remote = 'b'.repeat(40);
    pr = {
      itemNodeId: 'PR_7',
      number: 7,
      state: 'open',
      baseRef: 'release',
      headRef: 'collaborator-work',
      headRepository: 'owner/repo',
      title: 'Collaborator title',
      body: '',
    };
    const bound = await request('bind', {
      pullRequest: 'https://github.com/owner/repo/pull/7',
    });
    assert.equal(bound.status, 'bound');
    assert.equal(record.delivery!.reconciled, false);
    assert.equal(record.announcement, undefined);
    assert.equal(pushes, 0);
    await request('prepare');
    assert.equal((await request('publish', {})).status, 'published');
    assert.equal(record.delivery!.binding.authorId, 'U_collaborator');
    assert.equal(record.delivery!.binding.base, 'release');
    assert.equal(record.delivery!.localBranch, 'task-branch');
    assert.equal(creates, 0);
    assert.equal(pushes, 1);
    assert.equal(patches, 0);
    assert.equal(pr.body, '');
    const retained = await request('bind', { pullRequest: 'https://github.com/owner/repo/pull/7' });
    assert.ok('retained' in retained && retained.retained);
    assert.equal(record.delivery!.reconciled, true);
  });

  it('should leave unchanged adoption unannounced and refuse switching its retained local branch', async () => {
    record.adoptedPullRequest = {
      pullRequestNodeId: 'PR_7',
      pullRequestNumber: 7,
      branch: 'collaborator-work',
      base: 'release',
      head,
      authorId: 'U_collaborator',
      title: 'Existing work',
      body: '',
    };
    record.adoptedLocalBranch = 'task-branch';
    assert.equal((await request('prepare')).status, 'bound');
    assert.equal(record.delivery!.pushedHead, undefined);
    assert.equal(record.announcement, undefined);
    assert.equal(pushes + creates, 0);
    record.delivery!.localBranch = 'preserved-predecessor';
    await assert.rejects(request('prepare'), /delivery-branch-diverged/);
  });

  it('should reject a changed pr during binding and refuse non-operator binding', async () => {
    const action = { pullRequest: 'https://github.com/owner/repo/pull/7' };
    await assert.rejects(request('bind', action), /delivery-binding-operator-required/);
    input.operator = true;
    remote = 'b'.repeat(40);
    pr = { title: 'Existing', body: 'Preserved' };
    const before = structuredClone(record);
    const connect = input.connect;
    input.connect = async () => {
      const connection = await connect();
      const git = connection.git;
      return {
        ...connection,
        git: async (args) => {
          if (args[0] === 'fetch') remote = 'c'.repeat(40);
          return git(args);
        },
      };
    };
    await assert.rejects(request('bind', { ...action }), /delivery-binding-stale/);
    assert.deepEqual(record, before);
    assert.equal(pushes + creates, 0);
  });

  for (const variant of ['default', 'skill', 'inline', 'file', 'skill-inline', 'skill-file']) {
    it(`should publish the pr announcement with ${variant} reply customization`, async () => {
      const guidance = 'Explain the delivered change.\nPreserve the validation limit.';
      await mkdir(join(root, 'reply'));
      await writeFile(join(root, 'reply', 'SKILL.md'), 'Compose a concise public handoff.');
      await writeFile(join(root, 'SKILL.md'), 'Default reply.');
      await writeFile(join(root, 'guidance.md'), guidance);
      const policy = intakeFixture().policy;
      policy.issueAssignment!.assessment = { skill: 'unavailable-assessment' };
      policy.issueAssignment!.implementation = { skill: 'unavailable-implementation' };
      policy.issueAssignment!.feedback = {
        inherit: true,
        allowed: [],
        ...(variant.includes('skill') ? { skill: 'ordinary-reply' } : {}),
        ...(variant.includes('inline')
          ? { guidance }
          : variant.includes('file')
            ? { guidance: { file: 'guidance.md' } }
            : {}),
      };
      input.selectAnnouncement = async (retained) =>
        (
          await selectFeedbackStage({
            policy,
            workflow: 'issue-assignment',
            workspace: root,
            observedAt: retained?.composition.observedAt ?? 1,
            resolveSkill: (id) =>
              openClawSkill(
                async () => ({
                  skills: [
                    {
                      name: 'ordinary-reply',
                      source: 'openclaw-workspace',
                      filePath: join(root, 'reply', 'SKILL.md'),
                      eligible: true,
                      modelVisible: true,
                    },
                    {
                      name: 'agent-system-github-reply',
                      source: 'openclaw-plugins',
                      filePath: join(root, 'SKILL.md'),
                      eligible: true,
                      modelVisible: true,
                    },
                  ],
                }),
                { key: 'issue-chat', agentId: 'agent' },
                id,
              ),
          })
        ).selection;
      await publish();
      const composed = await request('compose');
      assert.ok('selection' in composed && composed.selection && 'digest' in composed);
      assert.equal(
        composed.selection.skill.name,
        variant.includes('skill') ? 'ordinary-reply' : 'agent-system-github-reply',
      );
      assert.equal(
        composed.selection.guidance?.content,
        variant.includes('inline') ? guidance : undefined,
      );
      await request('candidate', {
        publicText: 'Cleanup documented. Live transport remains untested.',
      });
      assert.equal((await request('announce', {})).status, 'announced');
      const retainedSelection = record.announcement!.composition!;
      assert.equal(retainedSelection.skill.digest, composed.selection.skill.digest);
      assert.equal(
        retainedSelection.guidance?.content,
        /inline|file/u.test(variant) ? guidance : undefined,
      );
      if (variant.includes('file'))
        assert.equal(composed.selection.guidance?.path, retainedSelection.guidance?.path);
      assert.ok(announcement.comments[0]!.body.includes('Live transport remains untested.'));
      await request('announce', {});
      assert.equal(announcement.posts, 1);
      assert.equal(creates, 1);
    });
  }

  it('should finish a new implementation through the same pr after earlier delivery completed', async () => {
    await publish();
    await request('compose');
    await request('candidate', {
      publicText: 'Delivers the requested change.',
    });
    await request('announce', {});
    const receipt = structuredClone(record.delivery!.pullRequest);
    head = 'b'.repeat(40); // ordinary native edits; no managed context/result round.
    assert.deepEqual(record.delivery!.pullRequest, receipt);
    await publish();
    assert.equal(creates, 1);
    assert.equal(announcement.posts, 1);
    assert.equal(record.delivery!.pushedHead, head);
  });

  it('should retry pr creation after a definite provider rejection', async () => {
    rejectCreation = true;
    await assert.rejects(publish(), /403/);
    rejectCreation = false;
    assert.equal((await publish()).status, 'published');
    assert.equal(creates, 2);
  });

  for (const draft of [false, true])
    it(`should reconcile announce and present a ${draft ? 'draft' : 'ready'} pr with uncommitted edits`, async () => {
      await publish();
      dirty = true;
      await request('reconcile');
      announcement.draft = draft;
      await request('compose');
      await request('candidate', {
        publicText: 'Delivers the requested change.',
      });
      assert.equal((await request('announce', {})).status, 'announced');
      await request('announce');
      const shown = await request('present');
      assert.ok('presentation' in shown);
      assert.match(shown.presentation!, /Pull request/);
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
    await request('compose');
    await request('candidate', {
      publicText: 'Delivers the requested change.',
    });
    announcement.lost = true;
    assert.equal((await request('announce', {})).status, 'announcement-blocked');
    assert.equal(record.delivery!.reconciled, true);
    assert.equal(record.announcement!.attempted, true);
    input.record = record = JSON.parse(JSON.stringify(record));
    announcement.lost = false;
    assert.equal((await request('announce')).status, 'announced');
    assert.equal(announcement.posts, 1);
    assert.equal(creates, 1);
    assert.equal(pushes, 1);
  });

  it('should recheck the published pr without waking delivery after announcement recovery', async () => {
    await publish();
    let available = false,
      checks = 0;
    const connect = input.connect;
    input.now = 100;
    input.connect = async () => {
      const connection = await connect();
      const execute = connection.account.execute;
      connection.account.execute = async (...args) => {
        if (args[0].some((value) => value.includes('draft,state'))) {
          checks++;
          if (!available)
            return {
              ...response({ message: 'Service unavailable' }),
              exitCode: 1,
              stdout: 'HTTP/2 503 Service Unavailable\n\n{}',
              stderr: 'gh: Service unavailable (HTTP 503)',
            };
        }
        return execute(...args);
      };
      return connection;
    };
    assert.equal((await request('compose')).status, 'announcement-blocked');
    input.record = record = JSON.parse(JSON.stringify(record));
    const delivery = record;
    const first = delivery.announcementRecovery!.retryAfter!;
    assert.equal(openClawWorkSlot(record), undefined);
    const check = (now: number) =>
      recoverRetainedAnnouncement({
        delivery,
        intake: input.intake,
        now,
        signal: input.signal,
        connect: input.connect,
        authorize: input.assertCurrent,
        save: input.save,
      });
    assert.equal(await check(first - 1), false);
    const before = checks;
    assert.ok(before > 0);
    assert.equal(await check(first - 1), false);
    assert.equal(checks, before);
    assert.equal(await check(first), false);
    assert.ok(checks > before);
    assert.equal(openClawWorkSlot(record), undefined);
    available = true;
    assert.equal(await check(delivery.announcementRecovery!.retryAfter!), true);
    assert.equal(openClawWorkSlot(record), undefined);
    await request('compose');
    await request('candidate', {
      publicText: 'Delivers the existing fix.',
    });
    await request('announce', {});
    assert.equal(creates, 1);
    assert.equal(pushes, 1);
    assert.equal(announcement.posts, 1);
  });

  it('should show incomplete publication while preserving the original pr', async () => {
    await publish();
    record.delivery!.reconciled = false;
    const shown = await request('present');
    assert.equal(shown.status, 'publication-incomplete');
    assert.ok('presentation' in shown);
    assert.match(shown.presentation!, /delivery-publication-incomplete/);
    assert.match(shown.presentation!, /pull\/7/);
    assert.equal(creates, 1);
    assert.equal(pushes, 1);
  });

  it('should publish once and retain the issue pr session binding with a quoted card and truthful feedback availability', async () => {
    assert.equal((await publish()).status, 'published');
    const shown = await request('present');
    assert.ok('presentation' in shown);
    assert.match(shown.presentation!, /^> ## 🔀 Pull request/m);
    assert.match(shown.presentation!, /issues\/3/);
    assert.match(shown.presentation!, /pull\/7/);
    assert.match(shown.presentation!, /Automatic GitHub feedback delivery is not available/);
    input.feedbackEnabled = true;
    const enabled = await request('present');
    assert.ok('presentation' in enabled);
    assert.match(enabled.presentation!, /originating item or review thread/);
    const binding = record.delivery!.binding;
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
    assert.equal(record.delivery!.creationAttempted, true);
    const restored = JSON.parse(JSON.stringify(record)) as OpenClawDispatchRecord;
    input.record = record = restored;
    lost = false;
    await publish();
    assert.equal(creates, 1);
    assert.equal(record.delivery!.pullRequest?.pullRequestNumber, 7);
  });
  it('should reconcile an accepted creation with a lost receipt despite newer dirty local work', async () => {
    lost = true;
    await assert.rejects(publish());
    input.record = record = JSON.parse(JSON.stringify(record));
    lost = false;
    const delivered = remote;
    head = 'b'.repeat(40);
    dirty = true;
    assert.equal((await request('reconcile')).status, 'ready');
    assert.equal(record.delivery!.pushedHead, delivered);
    assert.equal(record.delivery!.reconciled, true);
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
  });
  it('should resume incomplete provider effects without another push after restart', async () => {
    failLink = true;
    await assert.rejects(publish({ title: 'Fix issue', body: 'Authored body.' }));
    input.record = record = JSON.parse(JSON.stringify(record));
    failLink = false;
    assert.equal((await request('reconcile')).status, 'ready');
    assert.equal(record.delivery!.reconciled, true);
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
  });
  it('should prepare a new commit on the retained delivery without changing its receipt', async () => {
    await publish();
    const retained = structuredClone(record.delivery!);
    head = 'b'.repeat(40);
    const prepared = await request('prepare');
    assert.ok('operation' in prepared && prepared.operation);
    assert.equal(prepared.operation.id, retained.id);
    assert.equal(prepared.operation.binding.head, head);
    assert.deepEqual(prepared.operation.pullRequest, retained.pullRequest);
    assert.deepEqual(record.delivery, retained);
    head = 'c'.repeat(40);
    const refreshed = await request('publish', {});
    assert.equal(refreshed.status, 'published');
    assert.equal(record.delivery!.binding.head, head);
    assert.equal(pushes, 2);
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
  it('should update the delivered pr without the original implementation stage', async () => {
    await publish();
    delete record.progression;
    delete record.handoff;
    delete record.work!.publication;
    input.operator = true;
    const receipt = structuredClone(record.delivery!.pullRequest);
    head = 'b'.repeat(40);
    await publish();
    assert.equal(remote, head);
    assert.equal(record.delivery!.pushedHead, head);
    assert.equal(record.delivery!.binding.head, head);
    assert.deepEqual(record.delivery!.pullRequest, receipt);
    assert.equal(record.delivery!.reconciled, true);
    assert.equal(creates, 1);
    assert.equal(pushes, 2);
  });
  it('should publish an existing pr update while retaining approved feedback authority', async () => {
    await publish();
    const receipt = structuredClone(record.delivery!.pullRequest);
    authorizePrFeedback();
    head = 'b'.repeat(40);
    assert.equal((await publish()).status, 'published');
    assert.equal(remote, head);
    assert.deepEqual(record.delivery!.pullRequest, receipt);
    assert.equal(record.delivery!.reconciled, true);
    assert.equal(pushes, 2);
    assert.equal(creates, 1);
  });
  for (const change of [
    'body',
    'author',
    'deleted',
    'closed',
    'pr-id',
    'pr-number',
    'missing-pr',
    'policy',
    'owner',
  ] as const)
    it(`should reject changed feedback ${change} before updating the pr`, async () => {
      await publish();
      const feedback = authorizePrFeedback();
      head = 'b'.repeat(40);
      await request('prepare');
      if (change === 'body') feedback.source.body = '@receiver withdrawn';
      if (change === 'author') feedback.source.author.nodeId = 'U_other';
      if (change === 'deleted')
        feedback.provider.getIssueComment = async () => {
          throw new Error('comment-deleted');
        };
      if (change === 'closed') feedback.item.state = 'closed';
      if (change === 'pr-id') record.delivery!.pullRequest!.pullRequestNodeId = 'PR_other';
      if (change === 'pr-number') record.delivery!.pullRequest!.pullRequestNumber = 8;
      if (change === 'missing-pr') delete record.delivery!.pullRequest;
      if (change === 'policy') feedback.policy.issueAssignment!.allowed = [];
      if (change === 'owner') revoked = true;
      const expected = {
        body: 'feedback-source-changed',
        author: 'feedback-source-author-changed',
        deleted: 'comment-deleted',
        closed: 'feedback-source-owner-changed',
        'pr-id': 'feedback-source-owner-changed',
        'pr-number': 'feedback-source-owner-changed',
        'missing-pr': 'feedback-source-owner-changed',
        policy: 'workflow-policy-held',
        owner: 'dispatch-policy-changed',
      }[change];
      await assert.rejects(request('publish', {}), { message: expected });
      assert.equal(pushes, 1);
      assert.equal(creates, 1);
      assert.equal(patches, 0);
    });
  it('should reject incompatible history but accept an incorporated collaborator head', async () => {
    await publish();
    head = 'b'.repeat(40);
    ancestor = false;
    await assert.rejects(publish(), /not an ancestor/);
    ancestor = true;
    remote = 'c'.repeat(40);
    pr!.headSha = remote;
    await publish();
    assert.equal(remote, head);
    assert.equal(pushes, 2);
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
    it(`should recover feedback-driven metadata updates interrupted ${interruption} the provider write`, async () => {
      await publish();
      authorizePrFeedback();
      const content = { title: 'Updated fix', body: 'Includes the follow-up change.' };
      failPatch = interruption;
      await assert.rejects(publish(content), /update interrupted/);
      assert.equal(record.delivery!.reconciled, false);
      input.record = record = structuredClone(record);
      failPatch = false;
      await publish(content);
      assert.equal(pr!.title, content.title);
      assert.equal(pr!.body, content.body);
      assert.equal(patches, interruption === 'before' ? 2 : 1);
      assert.equal(creates, 1);
      assert.equal(pushes, 1);
      assert.equal(record.delivery!.reconciled, true);
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
  for (const snapshot of [true, false])
    it(`should show neutral pr readback after metadata updates with snapshot ${snapshot}`, async () => {
      await publish();
      if (snapshot) {
        await request('compose');
        await request('candidate', { publicText: 'Delivers the requested change.' });
        await request('announce', {});
      }
      await publish({ title: 'New title', body: 'Revised description.' });
      const shown = await request('present');
      assert.ok('presentation' in shown);
      assert.match(shown.presentation!, /Pull request\n/);
      assert.doesNotMatch(shown.presentation!, /Pull request (opened|updated)/);
      assert.match(shown.presentation!, /pull\/7/);
      assert.equal(pr!.title, 'New title');
      assert.equal(creates, 1);
      if (snapshot) {
        assert.match(shown.presentation!, /Original PR announcement/);
        assert.match(shown.presentation!, /#issuecomment-91/);
        assert.match(shown.presentation!, /Delivers the requested change/);
        const repeated = await request('compose');
        assert.ok('presentation' in repeated);
        assert.match(repeated.presentation!, /Original PR announcement/);
        assert.match(repeated.presentation!, /#issuecomment-91/);
      } else assert.doesNotMatch(shown.presentation!, /Original PR announcement/);
      assert.equal(announcement.posts, snapshot ? 1 : 0);
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
    assert.equal(record.delivery!.reconciled, false);
    assert.deepEqual(record.delivery!.contentUpdate, content);
    assert.equal(record.delivery!.contentUpdateAttempted, true);
    input.connect = connect;
    await publish(content);
    assert.equal(pr!.title, content.title);
    assert.equal(record.delivery!.contentUpdate, undefined);
    assert.equal(creates, 1);
  });
  for (const lostAnnouncement of [false, true])
    it(`should recover an interrupted follow-up push with a ${lostAnnouncement ? 'pending' : 'confirmed'} announcement`, async () => {
      await publish();
      await request('compose');
      await request('candidate', {
        publicText: 'Delivers the requested change.',
      });
      announcement.lost = lostAnnouncement;
      await request('announce', {});
      const retained = structuredClone(record.delivery!);
      const retainedAnnouncement = structuredClone(record.announcement);
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
      assert.equal(record.delivery!.pushedHead, retained.pushedHead);
      input.record = record = structuredClone(record);
      input.connect = connect;
      await publish();
      assert.equal(record.delivery!.id, retained.id);
      assert.deepEqual(record.delivery!.pullRequest, retained.pullRequest);
      assert.deepEqual(record.announcement, retainedAnnouncement);
      announcement.lost = false;
      assert.equal((await request('announce')).status, 'announced');
      const shown = await request('present');
      assert.ok('presentation' in shown);
      assert.match(shown.presentation!, /#issuecomment-91/);
      assert.equal(creates, 1);
      assert.equal(pushes, 2);
      assert.match(shown.presentation!, /Pull request updated/);
      assert.match(shown.presentation!, /Original PR announcement/);
      assert.match(shown.presentation!, /before this update/);
      assert.ok(
        shown.presentation!.indexOf('Original announcement (before this update):') <
          shown.presentation!.indexOf('Delivers the requested change'),
      );
      assert.match(shown.presentation!, /Delivers the requested change/);
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
    assert.match(result.presentation, /^> ## 🔀 Pull request/m);
    assert.match(result.presentation, /issues\/3/);
    assert.match(result.presentation, /pull\/7/);
    assert.deepEqual(record.delivery!.pullRequest, persisted.delivery!.pullRequest);
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
  it('should recover a lost link response by reading the same pr without another mutation', async () => {
    lostLink = true;
    await assert.rejects(publish(), /link response lost/);
    assert.equal(record.delivery!.pullRequest?.pullRequestNumber, 7);
    assert.equal(record.delivery!.reconciled, false);
    input.record = record = JSON.parse(JSON.stringify(record));
    await publish();
    assert.equal(record.delivery!.reconciled, true);
    assert.equal(linkWrites, 1);
    assert.equal(creates, 1);
    assert.equal(pushes, 1);
  });
  it('should resume linkage on the checkpointed pr without creating another', async () => {
    failLink = true;
    await assert.rejects(publish());
    assert.equal(record.delivery!.pullRequest?.pullRequestNumber, 7);
    assert.equal(record.delivery!.reconciled, false);
    failLink = false;
    await publish();
    assert.equal(creates, 1);
  });
  it('should reconcile an older confirmed push before publishing a newer commit after a link failure', async () => {
    failLink = true;
    await assert.rejects(publish({ title: 'Fix issue', body: 'Authored body.' }));
    input.record = record = JSON.parse(JSON.stringify(record));
    head = 'b'.repeat(40);
    failLink = false;
    assert.equal(
      (await publish({ title: 'Fix issue', body: 'Updated body.' })).status,
      'published',
    );
    assert.equal(record.delivery!.pendingPush, undefined);
    assert.equal(record.delivery!.pushedHead, head);
    assert.equal(creates, 1);
    assert.equal(pushes, 2);
  });
  it('should publish current authorized work without a saved result', async () => {
    record.progression = { stage: 'implementation', via: 'work' };
    await publish();
    assert.equal(creates, 1);
    assert.equal(pushes, 1);
  });
  it('should publish completed implementation without a publication-only grant', async () => {
    delete record.handoff;
    delete record.work!.publication;
    record.progression = { stage: 'implementation', via: 'work' };
    record.work!.implementation = input.source;
    await publish();
    assert.equal(creates, 1);
    assert.equal(record.delivery!.reconciled, true);
  });
  it('should reject unauthorized dirty divergent and revoked publication before writes', async () => {
    const permission = record.work!.publication;
    delete record.work!.publication;
    await assert.rejects(publish(), /delivery-implementation-not-authorized/);
    record.work!.publication = permission;
    dirty = true;
    await assert.rejects(publish(), /delivery-uncommitted-work/);
    dirty = false;
    remote = 'b'.repeat(40);
    await assert.rejects(publish(), /delivery-remote-head-diverged/);
    revoked = true;
    await assert.rejects(publish(), /dispatch-policy-changed/);
    assert.equal(creates, 0);
    assert.equal(pushes, 0);
  });
  it('should recover the previously verified head after an interrupted followup push', async () => {
    await request('prepare', { title: 'Initial', body: 'Initial body.' });
    await request('publish', { title: 'Initial', body: 'Initial body.' });
    head = 'b'.repeat(40);
    const connect = input.connect;
    let lagged = 0;
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
              lagged < 5 &&
              remote === head &&
              args[0].some((value) => value.includes('headSha:.head.sha'))
            ) {
              lagged++;
              return {
                ...result,
                stdout:
                  'HTTP/2 200 OK\n\n' +
                  JSON.stringify({
                    ...JSON.parse(result.stdout.split('\n\n').slice(1).join('\n\n')),
                    headSha: 'a'.repeat(40),
                  }),
              };
            }
            return result;
          },
        },
      };
    };
    await request('prepare', { title: 'Updated', body: 'Updated body.' });
    await assert.rejects(
      request('publish', {
        title: 'Updated',
        body: 'Updated body.',
      }),
      /The pull request head does not match the verified push/,
    );
    input.record = record = JSON.parse(JSON.stringify(record));
    assert.deepEqual(record.delivery!.pendingPush, { previousHead: 'a'.repeat(40), head });
    await request('prepare', { title: 'Updated', body: 'Updated body.' });
    const recovered = await request('publish', {
      title: 'Updated',
      body: 'Updated body.',
    });
    assert.equal(recovered.status, 'published');
    assert.equal(lagged, 5);
    assert.equal(record.delivery!.pendingPush, undefined);
    assert.equal(creates, 1);
    assert.equal(pushes, 2);
    assert.equal(patches, 1);
  });
});
