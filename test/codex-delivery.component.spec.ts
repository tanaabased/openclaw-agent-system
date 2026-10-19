import { beginFeedbackWork } from '../agent/feedback-work.ts';
import { discoverFeedback } from '../agent/feedback-source.ts';
import { notificationAuthorityDigest } from '../agent/notification-authority.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import announcementFixture from './delivery-announcement-fixture.ts';

import { automationHash } from '../agent/automation-hash.ts';
import runCodexDelivery, {
  codexDeliveryAttachment,
  CodexDeliveryFailure,
  type CodexDeliveryDependencies,
} from '../agent/codex-delivery.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import { runCodexIntake, selectCodexIntake } from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { account, baseline, intakeFixture } from './github-intake-fixture.ts';

const id = 'd'.repeat(64);
const firstHead = 'a'.repeat(40);
const url = 'https://github.com/owner/repo/pull/7';
const manifest = {
  'schema-version': 1,
  agent: { id: 'receiver' },
  github: {
    username: 'receiver',
    notifications: {
      'schema-version': 2,
      runtimes: ['codex'],
      'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
      'issue-assignment': {
        mode: 'plan',
        allowed: [{ login: 'receiver', 'node-id': 'U_receiver' }],
        'pull-request': { recipients: [] },
      },
    },
  },
};
const result = (value: unknown) => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: '',
  timedOut: false,
  truncated: false,
});

describe('agent/codex-delivery', () => {
  let announcement: ReturnType<typeof announcementFixture>;
  let root: string, workspace: string, pluginData: string, store: CodexDispatchStore;
  let deps: CodexDeliveryDependencies, fixture: ReturnType<typeof intakeFixture>;
  let head: string, remote: string, dirty: boolean, attached: boolean, creates: number;
  let failCreate: boolean, failLink: boolean, failRecipient: boolean, wrongIssueLink: boolean;
  let pr: Record<string, unknown> | undefined;
  let providerLink: boolean | undefined;
  let bindingOverride: Record<string, unknown>;
  let gitCalls: string[][];
  let linkReads: number, delayedLinkReads: number, bodyWrites: number;
  let failPatch: 'before' | 'after' | false;
  async function request(
    action: string,
    input: object = {},
    overrides: CodexDeliveryDependencies = {},
  ) {
    return runCodexDelivery(pluginData, { action, id, ...input }, { ...deps, ...overrides });
  }
  function requiredDigest(result: object) {
    assert.ok('digest' in result && typeof result.digest === 'string');
    return result.digest;
  }
  async function publish(content = { title: 'Authored title', body: 'Authored body.' }) {
    const preview = await request('prepare', content);
    assert.equal(preview.status, 'prepared');
    return request('publish', {
      digest: requiredDigest(preview),
      ...content,
    });
  }
  async function feedbackWorkFixture() {
    const declaration = JSON.parse(await readFile(join(workspace, 'agent.yaml'), 'utf8'));
    declaration.github.notifications['issue-assignment'].feedback = {
      allowed: [{ login: 'reviewer', 'node-id': 'U_reviewer' }],
    };
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(declaration));
    await publish();
    const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
    const policy = current.manifest.github!.notifications!;
    const source = {
      nodeId: 'C_feedback work',
      databaseId: 42,
      author: { login: 'reviewer', nodeId: 'U_reviewer', type: 'User' },
      body: '@receiver fix empty input and push',
      bodyTruncated: false,
      createdAt: new Date(baseline + 70000).toISOString(),
      updatedAt: new Date(baseline + 70000).toISOString(),
    };
    const comments = {
      ...fixture.client,
      identity: account,
      listIssueComments: async () => ({ comments: [source], truncated: false }),
      getIssueComment: async () => source,
    };
    const authority = {
      workflow: 'issue-assignment' as const,
      automationId: 'automation',
      sourceThreadId: 'intake',
      policyDigest: notificationAuthorityDigest(policy),
      definitionDigest: 'e'.repeat(64),
    };
    deps.activation = async () => ({
      sourceThreadId: 'intake',
      schedule: {
        current: authority,
        saved: { ...authority, version: 1, capabilities: ['feedback', 'publication'] },
      },
    });
    deps.feedbackConnect = async () => ({ client: fixture.client, comments }) as never;
    head = 'b'.repeat(40);
    const eventId = await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.feedback = { baseline: { I_issue: {} }, events: [] };
      await discoverFeedback({
        state: record.feedback,
        client: comments,
        policy,
        owner: 'owner',
        name: 'repo',
        number: 3,
        nodeId: 'I_issue',
        itemType: 'issue',
        now: baseline + 80000,
      });
      const event = record.feedback.events[0]!;
      event.phase = 'running';
      event.attempt = {
        id: 'f'.repeat(64),
        sourceTurnId: 'intake',
        beforeTurnId: 'before',
        turnId: 'turn',
        request: { threadId: 'child', prompt: 'feedback', model: 'model', thinking: 'high' },
      };
      record.progression = { stage: 'implementation', via: 'legacy' };
      await beginFeedbackWork({
        record,
        event,
        policy,
        workspace,
        now: baseline + 80000,
        pullRequest: record.delivery!.pullRequest,
        resolveSkill: (id) => deps.native!.assessmentSkill!(record.worktree!, id),
      });
      event.work!.result = {
        outcome: 'done',
        summary: 'Fixed.',
        fullResult: 'Regression passed; committed.',
      };
      event.work!.head = head;
      await save();
      return event.id;
    });
    return { eventId, source };
  }
  it('should publish a source-bound feedback work to the same pr without a new operator turn', async () => {
    const { eventId } = await feedbackWorkFixture();
    deps.native!.find = async () => ({
      id: 'child',
      cwd: (await store.read()).records[0]!.worktree!,
      status: 'active',
      turnId: 'turn',
      followUpUserTurn: false,
    });
    await assert.rejects(request('prepare'), /feedback-event-required/);
    const preview = await request('prepare', { eventId });
    const outcome = await request('publish', { eventId, digest: requiredDigest(preview) });
    assert.equal(outcome.status, 'published');
    assert.equal(creates, 1);
    assert.equal(remote, head);
    assert.equal((await store.read()).records[0]!.delivery!.pullRequest!.pullRequestNumber, 7);
    assert.equal(gitCalls.filter((args) => args.includes('push')).length, 2);
  });

  it('should reconcile an uncertain feedback work push without repeating implementation or push', async () => {
    const { eventId } = await feedbackWorkFixture();
    const git = deps.git!;
    let lost = true;
    deps.git = async (cwd, args, signal) => {
      const result = await git(cwd, args, signal);
      if (lost && args.includes('push')) {
        lost = false;
        throw new Error('transport lost');
      }
      return result;
    };
    const preview = await request('prepare', { eventId });
    await assert.rejects(
      request('publish', { eventId, digest: requiredDigest(preview) }),
      /transport lost/,
    );
    assert.equal(remote, head);
    const retained = (await store.read()).records[0]!.feedback!.events[0]!.work;
    const retry = await request('prepare', { eventId });
    assert.equal(
      (await request('publish', { eventId, digest: requiredDigest(retry) })).status,
      'published',
    );
    assert.deepEqual((await store.read()).records[0]!.feedback!.events[0]!.work, retained);
    assert.equal(gitCalls.filter((args) => args.includes('push')).length, 2);
    assert.equal(creates, 1);
  });
  it('should stop a feedback work push when its native activated authority is revoked after preparation', async () => {
    const { eventId } = await feedbackWorkFixture();
    const preview = await request('prepare', { eventId });
    const active = deps.activation!;
    const git = deps.git!;
    let revoked = false;
    deps.activation = async (...args) => {
      if (revoked) throw new Error('feedback-authority-revoked');
      return active(...args);
    };
    deps.git = async (cwd, args, signal) => {
      const value = await git(cwd, args, signal);
      if (args[0] === 'ls-remote') revoked = true;
      return value;
    };
    await assert.rejects(
      request('publish', { eventId, digest: requiredDigest(preview) }),
      /authority-revoked/,
    );
    assert.equal(remote, firstHead);
    assert.equal(gitCalls.filter((args) => args.includes('push')).length, 1);
  });
  it('should reject a different commit or native turn after feedback work is recorded', async () => {
    const { eventId } = await feedbackWorkFixture();
    head = 'c'.repeat(40);
    await assert.rejects(request('prepare', { eventId }), /feedback-implementation-head-changed/u);
    head = 'b'.repeat(40);
    const find = deps.native!.find;
    deps.native!.find = async (...args) => ({ ...(await find(...args))!, turnId: 'another-turn' });
    await assert.rejects(request('prepare', { eventId }), /feedback-owner-caller-required/u);
    assert.equal(remote, firstHead);
    assert.equal(creates, 1);
  });
  it('should stop a changed source before a feedback work push and retain the existing receipt', async () => {
    const { eventId, source } = await feedbackWorkFixture();
    const preview = await request('prepare', { eventId });
    source.body = '@receiver withdrawn';
    await assert.rejects(
      request('publish', { eventId, digest: requiredDigest(preview) }),
      /feedback-source-changed/,
    );
    assert.equal(remote, firstHead);
    assert.equal(creates, 1);
    assert.equal(gitCalls.filter((args) => args.includes('push')).length, 1);
  });
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex_delivery-')));
    workspace = join(root, 'workspace');
    pluginData = join(root, 'plugin');
    const codexHome = join(root, 'codex'),
      worktree = join(root, 'worktree'),
      source = join(root, 'source'),
      commonDir = join(root, 'common');
    for (const path of [workspace, codexHome, worktree, source, commonDir]) await mkdir(path);
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    await bindCodexWorkspace(pluginData, workspace);
    fixture = intakeFixture();
    await runCodexIntake(pluginData, true, {
      codexHome,
      now: () => baseline,
      connect: async () => fixture.client,
    });
    await runCodexIntake(pluginData, false, {
      codexHome,
      now: () => baseline + 60000,
      assertActive: async () => {},
      connect: async () => fixture.client,
    });
    const current = await selectCodexIntake(pluginData, { codexHome });
    const intake = (await current.store.read())!.records[0]!;
    store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records.push({
        id,
        intakeId: intake.id,
        issueKey: intake.id,
        sourceThreadId: 'intake',
        phase: 'assessing',
        createdAt: baseline,
        manifestDigest: current.digest,
        project: {
          id: 'project',
          path: source,
          commonDir,
          ref: 'origin/main',
          commit: '0'.repeat(40),
        },
        context: 'context',
        routing: 'routing',
        routingNote: 'note',
        threadId: 'child',
        worktree,
        request: {
          title: 'issue',
          prompt: 'assessment',
          model: 'model',
          thinking: 'high',
          target: {
            type: 'project',
            projectId: 'project',
            environment: {
              type: 'worktree',
              startingState: { type: 'branch', branchName: 'main' },
            },
          },
        },
        handoff: { at: baseline + 60000, by: 'child', turnId: 'turn' },
      });
      await save();
    });
    announcement = announcementFixture(account);
    head = firstHead;
    remote = '';
    dirty = false;
    attached = false;
    creates = 0;
    wrongIssueLink = false;
    failCreate = false;
    failLink = false;
    failRecipient = false;
    pr = undefined;
    providerLink = undefined;
    bindingOverride = {};
    gitCalls = [];
    linkReads = delayedLinkReads = bodyWrites = 0;
    failPatch = false;
    deps = {
      delay: async () => {},
      codexHome,
      threadId: 'child',
      attachment: async () => attached,
      native: {
        assessmentSkill: async (_cwd, name) => ({
          name,
          path: '/skills/reply/SKILL.md',
          scope: 'user',
          digest: 'a'.repeat(64),
        }),
        find: async () => ({
          id: 'child',
          cwd: worktree,
          status: 'active',
          turnId: 'turn',
          followUpUserTurn: true,
        }),
      },
      git: async (_cwd, argv) => {
        gitCalls.push(argv);
        if (argv[0] === 'remote') return 'https://github.com/owner/repo.git';
        if (argv.includes('--git-common-dir')) return commonDir;
        if (argv[0] === 'branch') return 'pirog-work';
        if (argv[0] === 'status') return dirty ? ' M source.ts' : '';
        if (argv[0] === 'rev-parse') return head;
        if (argv[0] === 'rev-list') return '2';
        if (argv[0] === 'ls-remote') return remote ? `${remote}\trefs/heads/pirog-work\n` : '';
        if (argv.includes('push')) remote = head;
        return '';
      },
      connect: async () => ({
        client: Object.assign(fixture.client, {
          getItemContext: async () => {
            throw new Error('not needed');
          },
        }),
        account: {
          identity: account,
          execute: async (argv, stdin) => {
            const comment = announcement.execute(argv, stdin);
            if (comment) return comment;
            if (argv.includes('graphql')) {
              linkReads++;
              return result({
                id: 'PR_7',
                closingIssuesReferences: {
                  nodes:
                    linkReads > delayedLinkReads &&
                    (providerLink ??
                      /Closes (?:#3|https:\/\/github.com\/owner\/repo\/issues\/3)/iu.test(
                        String(pr?.body),
                      ))
                      ? [{ id: wrongIssueLink ? 'I_other' : 'I_issue' }]
                      : [],
                },
              });
            }
            const endpoint = argv.find(
              (arg) => arg.startsWith('repos/') || arg.startsWith('users/'),
            );
            if (endpoint === 'repos/owner/repo/issues/3')
              return result({ databaseId: 20, nodeId: 'I_issue', number: 3, title: 'Issue title' });
            if (endpoint === 'repos/owner/repo/pulls' && argv.includes('GET'))
              return result(pr ? [pr] : []);
            if (endpoint === 'repos/owner/repo/pulls' && argv.includes('POST')) {
              creates++;
              if (failCreate) throw new Error('transport lost');
              pr = {
                itemNodeId: 'PR_7',
                number: 7,
                state: 'open',
                baseRef: 'main',
                headRef: 'pirog-work',
                headRepository: 'owner/repo',
                ...(JSON.parse(stdin!) as object),
              };
              return result(pr);
            }
            if (endpoint === 'repos/owner/repo/pulls/7') {
              if (argv.some((arg) => arg.includes('draft,state')))
                return result({
                  nodeId: 'PR_7',
                  draft: announcement.draft,
                  state: 'open',
                  head: remote,
                  title: pr?.title,
                  body: pr?.body,
                });
              if (argv.includes('PATCH')) {
                bodyWrites++;
                if (failLink) throw new Error('link unavailable');
                if (failPatch === 'before') throw new Error('update interrupted');
                pr = { ...pr, ...(JSON.parse(stdin!) as object) };
                if (failPatch === 'after') throw new Error('update interrupted');
              }
              if (argv.some((arg) => arg.includes('headSha:')))
                return result({
                  nodeId: 'PR_7',
                  repositoryId: 'R_repo',
                  headRepositoryId: 'R_repo',
                  headSha: remote,
                  authorId: account.nodeId,
                  baseRef: 'main',
                  headRef: 'pirog-work',
                  state: 'open',
                  number: 7,
                  ...bindingOverride,
                });
              return result(pr);
            }
            if (endpoint?.startsWith('users/') && failRecipient)
              throw new Error('recipient unavailable');
            throw new Error('unexpected provider request: ' + argv.join(' '));
          },
        },
      }),
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const deny of [false, true])
    it(`should let github ${deny ? 'reject' : 'accept'} recipient changes without permission preflights`, async () => {
      const configured = structuredClone(manifest);
      Object.assign(configured.github.notifications['issue-assignment']['pull-request'], {
        recipients: [
          { login: account.login, 'node-id': account.nodeId, roles: ['assignee', 'reviewer'] },
        ],
      });
      await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
      const connect = deps.connect!;
      let assigned = false,
        requested = false;
      deps.connect = async (...args) => {
        const connection = await connect(...args);
        const execute = connection.account.execute;
        return {
          ...connection,
          account: {
            ...connection.account,
            execute: async (argv, ...rest) => {
              const endpoint = argv.find(
                (arg) => arg.startsWith('repos/') || arg.startsWith('users/'),
              );
              if (endpoint === `users/${account.login}`) return result([account]);
              if (endpoint === 'repos/owner/repo/issues/7') return result([]);
              if (endpoint === 'repos/owner/repo/issues/7/assignees') {
                assigned = true;
                return result([account.login]);
              }
              if (endpoint === 'repos/owner/repo/pulls/7/reviews') return result([[]]);
              if (endpoint === 'repos/owner/repo/pulls/7/requested_reviewers') {
                if (argv.includes('POST')) {
                  requested = true;
                  if (deny)
                    return { ...result({ message: 'Forbidden' }), exitCode: 1, stderr: 'HTTP 403' };
                }
                return result(requested ? [account.login] : []);
              }
              return execute(argv, ...rest);
            },
          },
        };
      };
      if (deny) await assert.rejects(publish(), /GitHub/);
      else assert.equal((await publish()).status, 'published');
      assert.ok(assigned && requested);
      assert.equal(creates, 1);
    });

  it('should display the retained pr and reconcile only attachment after head and authority change', async () => {
    await publish();
    head = 'b'.repeat(40);
    fixture.item.assignees = [];
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.handoff;
      state.records[0]!.delivery!.reconciled = false;
      await save();
    });
    deps.connect = async () => {
      throw new Error('presentation must not connect to github');
    };
    deps.git = async () => {
      throw new Error('presentation must not inspect git');
    };
    const shown = await request('present');
    assert.equal(shown.status, 'linked');
    assert.match(String(shown.presentation), /pull\/7/);
    attached = true;
    assert.equal((await request('reconcile')).status, 'publication-incomplete');
    assert.equal((await store.read()).records[0]!.delivery!.attached, true);
    assert.equal((await store.read()).records[0]!.delivery!.reconciled, false);
    assert.equal(creates, 1);
    assert.equal(announcement.posts, 0);
  });

  for (const draft of [false, true])
    it(`should reconcile announce and present a delivered ${draft ? 'draft' : 'ready'} pr with uncommitted edits`, async () => {
      await publish();
      dirty = true;
      await request('reconcile');
      announcement.draft = draft;
      const context = await request('compose');
      assert.equal(context.status, 'composition-ready');
      const preview = await request('candidate', {
        digest: requiredDigest(context),
        publicText: 'Delivers the requested change.',
      });
      assert.equal(preview.status, 'announcement-prepared');
      assert.equal(
        (await request('announce', { digest: requiredDigest(preview) })).status,
        'announced',
      );
      await request('announce');
      const shown = await request('present');
      assert.match(String(shown.presentation), /Pull request opened/);
      assert.match(String(shown.presentation), /#issuecomment-91/);
      assert.equal(announcement.posts, 1);
      assert.match(announcement.comments[0]!.body, /pull\/7/);
      assert.ok(announcement.comments[0]!.body.includes(draft ? 'Draft.' : 'Ready for review.'));
      assert.equal(creates, 1);
      assert.equal(gitCalls.filter((argv) => argv.includes('push')).length, 1);
    });
  it('should recover only the lost announcement despite newer local work without republishing the pr', async () => {
    await publish();
    head = 'b'.repeat(40);
    deps.git = async () => {
      throw new Error('announcement recovery must not inspect newer local work');
    };
    const context = await request('compose');
    const preview = await request('candidate', {
      digest: requiredDigest(context),
      publicText: 'Delivers the requested change.',
    });
    announcement.lost = true;
    assert.equal(
      (await request('announce', { digest: requiredDigest(preview) })).status,
      'announcement-blocked',
    );
    const saved = (await store.read())!.records[0]!.delivery!;
    assert.equal(saved.reconciled, true);
    assert.equal(saved.announcement!.attempted, true);
    assert.equal(saved.announcement!.receipt, undefined);
    assert.match(String((await request('present')).presentation), /announcement pending/);
    announcement.lost = false;
    assert.equal((await request('announce')).status, 'announced');
    assert.equal(announcement.posts, 1);
    assert.equal(creates, 1);
  });
  it('should block announcement when provider closing linkage has disappeared', async () => {
    await publish();
    providerLink = false;
    assert.equal((await request('compose')).status, 'announcement-blocked');
    assert.equal(announcement.posts, 0);
    assert.equal((await store.read())!.records[0]!.delivery!.reconciled, true);
  });

  it('should retain linked custom implementation instructions after the pr card', async () => {
    await publish();
    await request('reconcile');
    await store.exclusive(async (state, save) => {
      state.records[0]!.continuation = {
        phase: 'complete',
        policyDigest: 'a'.repeat(64),
        selection: {
          version: 1,
          observedAt: 1,
          requestedSkill: 'custom:work',
          defaultSkill: false,
          skill: {
            name: 'custom:work',
            path: '/skills/work/SKILL.md',
            scope: 'user',
            digest: 'a'.repeat(64),
          },
          guidance: {
            source: 'file',
            path: join(workspace, 'work.md'),
            content: 'Private instructions',
            digest: 'b'.repeat(64),
          },
        },
      };
      await save();
    });
    const normal = String((await request('present')).presentation);
    assert.ok(!normal.includes('Implementation instructions'));
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify({ ...manifest, debug: true }));
    const shown = String((await request('present')).presentation);
    assert.ok(shown.indexOf('Implementation instructions') > shown.indexOf('Comment flow'));
    assert.ok(shown.includes('[custom:work](</skills/work/SKILL.md>)'));
    assert.ok(shown.includes('[work.md](<'));
    assert.ok(!shown.includes('Private instructions'));
  });
  it('should show feedback only when the configured schedule and owner are verified', async () => {
    const configured = structuredClone(manifest);
    Object.assign(configured.github.notifications['issue-assignment'], { feedback: true });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
    const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
    const authority = {
      workflow: 'issue-assignment' as const,
      automationId: 'automation',
      sourceThreadId: 'intake',
      policyDigest: automationHash(current.manifest.github!.notifications),
      definitionDigest: 'e'.repeat(64),
    };
    const activation = {
      sourceThreadId: 'intake',
      schedule: {
        current: authority,
        saved: { ...authority, version: 1 as const, capabilities: ['feedback' as const] },
      },
    };
    deps.activation = async () => activation;
    await publish();
    await request('reconcile');
    const active = await request('present');
    assert.match(String(active.presentation), /Approved feedback.*original issue chat/u);
    assert.match(String(active.presentation), /originating item or review thread/u);
    activation.sourceThreadId = 'other-intake';
    assert.match(
      String((await request('present')).presentation),
      /active intake could not be verified/u,
    );
    activation.sourceThreadId = 'intake';
    activation.schedule.saved.policyDigest = 'stale';
    assert.match(
      String((await request('present')).presentation),
      /Approved feedback.*original issue chat/u,
    );
    deps.activation = async () => {
      throw new Error('dispatch-activation-required');
    };
    assert.match(
      String((await request('present')).presentation),
      /active intake could not be verified/u,
    );
    assert.equal(creates, 1);
  });
  it('should publish authored multi-commit work and present before native attachment is ready', async () => {
    const preview = await request('prepare');
    assert.equal(preview.status, 'prepared');
    assert.equal((await store.read()).records[0]!.delivery, undefined);
    assert.ok(!gitCalls.some((argv) => argv.includes('push')));
    const published = await publish();
    assert.equal(published.status, 'published');
    assert.equal(published.workflowStatus, 'partially-delivered');
    assert.equal(pr!.title, 'Authored title');
    assert.equal(pr!.body, 'Authored body.\n\nCloses https://github.com/owner/repo/issues/3');
    assert.deepEqual(
      gitCalls.find((argv) => argv.includes('push')),
      [
        '-c',
        'url.git@github.com:owner/repo.git.insteadOf=https://github.com/owner/repo.git',
        'push',
        '--set-upstream',
        'origin',
        `${firstHead}:refs/heads/pirog-work`,
      ],
    );
    assert.ok(!gitCalls.some((argv) => argv[0] === 'commit'));
    assert.equal((await request('present')).status, 'linked');
    assert.equal((await request('reconcile')).status, 'ready');
    attached = true;
    assert.equal((await request('reconcile')).status, 'ready');
    const presented = await request('present');
    assert.equal(presented.status, 'linked');
    assert.deepEqual(presented.notices, []);
    assert.match(String(presented.instruction), /complete presentation Markdown.*final reply/u);
    assert.match(String(presented.instruction), /including the PR card and all notices/u);
    assert.match(String(presented.instruction), /card generation, not visible delivery/u);
    assert.match(JSON.stringify(presented.presentation), /feedback delivery is not available/);
    assert.equal(creates, 1);
    attached = false;
    await request('reconcile');
    assert.equal((await request('present')).status, 'linked');
  });
  it('should resume a failed linkage or recipient phase on the checkpointed pr', async () => {
    failLink = true;
    await assert.rejects(publish(), (error: unknown) => {
      assert.ok(error instanceof CodexDeliveryFailure);
      assert.match(error.message, /link unavailable/);
      assert.equal(error.pullRequest?.pullRequestNumber, 7);
      const failure = error.notices.find((notice) => notice.message.includes(url));
      assert.ok(failure?.message.includes(url));
      return true;
    });
    let saved = (await store.read()).records[0]!.delivery!;
    assert.equal(saved.pullRequest!.pullRequestNodeId, 'PR_7');
    assert.equal(saved.reconciled, false);
    failLink = false;
    failRecipient = true;
    const changed = structuredClone(manifest);
    delete (
      changed.github.notifications['issue-assignment']['pull-request'] as { recipients?: unknown }
    ).recipients;
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(changed));
    await assert.rejects(publish(), /recipient unavailable/);
    saved = (await store.read()).records[0]!.delivery!;
    assert.equal(saved.pullRequest!.pullRequestNodeId, 'PR_7');
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    assert.equal((await publish()).status, 'published');
    assert.equal(creates, 1);
  });
  it('should retain uncertain creation intent instead of issuing another create', async () => {
    failCreate = true;
    await assert.rejects(publish(), /transport lost/);
    assert.equal((await store.read()).records[0]!.delivery!.creationAttempted, true);
    await assert.rejects(publish(), /creation-uncertain/);
    assert.equal(creates, 1);
  });
  it('should preserve native host-access failures for the authorized retry', async () => {
    const git = deps.git!;
    for (const code of ['EPERM', 'EACCES', 'automation-thread-host-access-required']) {
      const denied = Object.assign(new Error('host access required'), { code });
      deps.git = async (cwd, argv, signal) => {
        if (argv[0] === 'ls-remote') throw denied;
        return git(cwd, argv, signal);
      };
      await assert.rejects(publish(), (error) => error === denied);
      assert.equal(creates, 0);
      assert.ok(!gitCalls.some((argv) => argv.includes('push')));
    }
    deps.git = git;
    assert.equal((await publish()).status, 'published');
    assert.equal(creates, 1);
  });
  it('should recover a lost creation response by adopting the same verified pr', async () => {
    failCreate = true;
    await assert.rejects(publish(), /transport lost/);
    pr = {
      itemNodeId: 'PR_7',
      number: 7,
      state: 'open',
      baseRef: 'main',
      headRef: 'pirog-work',
      headRepository: 'owner/repo',
      title: 'Authored title',
      body: 'Authored body.',
    };
    assert.equal((await publish()).status, 'published');
    assert.equal(creates, 1);
    assert.equal((await store.read()).records[0]!.delivery!.pullRequest!.pullRequestNumber, 7);
  });
  it('should serialize competing publications and invalidate the consumed preview', async () => {
    const preview = await request('prepare');
    const outcomes = await Promise.allSettled([
      request('publish', { digest: requiredDigest(preview) }),
      request('publish', { digest: requiredDigest(preview) }),
    ]);
    assert.equal(
      outcomes.filter(
        (outcome) => outcome.status === 'fulfilled' && outcome.value.status === 'published',
      ).length,
      1,
    );
    assert.equal(
      outcomes.filter(
        (outcome) => outcome.status === 'fulfilled' && outcome.value.status === 'prepared',
      ).length,
      1,
    );
    assert.equal(creates, 1);
  });
  it('should verify the provider issue link instead of trusting closing prose', async () => {
    wrongIssueLink = true;
    await assert.rejects(publish(), /linkage-unverified/);
    assert.equal((await store.read()).records[0]!.delivery!.pullRequest!.pullRequestNumber, 7);
    assert.equal(linkReads, 5);
    const retained = await request('present');
    assert.equal(retained.workflowStatus, 'partially-delivered');
    assert.match(String(retained.presentation), /pull\/7/);
    wrongIssueLink = false;
    await publish();
    assert.equal(creates, 1);
  });
  it('should retain shorthand closing prose while waiting for provider linkage and deduplicate recovery notices', async () => {
    delayedLinkReads = 2;
    const body = 'Authored body.\n\nCloses #3.';
    const preview = await request('prepare', { body });
    const published = await request('publish', { body, digest: requiredDigest(preview) });
    assert.equal(published.status, 'published');
    assert.equal(pr!.body, body);
    assert.equal(bodyWrites, 0);
    assert.equal(linkReads, 3);
    assert.equal(
      (await store.read()).records[0]!.delivery!.notices!.filter(
        (code) => code === 'delivery-linkage-retried',
      ).length,
      1,
    );
    const presented = await request('present');
    assert.match(String(presented.presentation), /Issue link verified after retry/);
    assert.match(String(presented.presentation), /PR attachment needs a check/);
    assert.equal(creates, 1);
  });
  it('should recognize equivalent closing references without confusing other issues or repositories', async () => {
    await publish();
    providerLink = true;
    for (const [body, added] of [
      ['CLOSES: #3.', 0],
      ['Fixed OWNER/REPO#3.', 0],
      ['Resolves https://github.com/owner/repo/issues/3.', 0],
      ['Closes #30.', 1],
      ['Closes other/repo#3.', 1],
    ] as const) {
      pr!.body = body;
      delayedLinkReads = linkReads + 2;
      const before = bodyWrites;
      await publish();
      assert.equal(bodyWrites - before, added, body);
    }
    assert.equal(creates, 1);
  });
  it('should present the published pr with a warning when native attachment inspection fails', async () => {
    await publish();
    const reconciled = await request(
      'reconcile',
      {},
      {
        attachment: async () => {
          throw new Error('native unavailable');
        },
      },
    );
    assert.equal(reconciled.status, 'ready');
    const presented = await request('present');
    assert.equal(presented.status, 'linked');
    assert.match(String(presented.presentation), /Pull request opened/);
    assert.ok(reconciled.notices?.some((notice) => notice.severity === 'warning'));
  });
  it('should suppress retained ssh transport notices while preserving actionable warnings', async () => {
    await publish();
    await store.exclusive(async (state, save) => {
      state.records[0]!.delivery!.notices = ['delivery-ssh-transport'];
      await save();
    });
    const presented = await request('present');
    assert.equal(presented.status, 'linked');
    assert.doesNotMatch(String(presented.presentation), /delivery-ssh-transport/);
    assert.equal(presented.notices?.length, 1);
    assert.equal(presented.notices?.[0]?.severity, 'warning');
    assert.match(String(presented.presentation), /delivery-attachment-pending/);
  });
  it('should require issue work or current operator direction and reject request-supplied authority', async () => {
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.handoff;
      await save();
    });
    const find = deps.native!.find;
    deps.native!.find = async (...args) => ({ ...(await find(...args))!, followUpUserTurn: false });
    await assert.rejects(request('prepare'), /workflow-policy-held/);
    const current = {
      workflow: 'issue-assignment' as const,
      sourceThreadId: 'intake',
      automationId: 'schedule',
      definitionDigest: 'definition',
      policyDigest: 'policy',
    };
    await assert.rejects(
      request(
        'prepare',
        {},
        { schedule: { current, saved: { ...current, version: 1, capabilities: ['assessment'] } } },
      ),
      /schedule-reconciliation-required/,
    );
    await assert.rejects(
      request(
        'prepare',
        {},
        { schedule: { current, saved: { ...current, version: 1, capabilities: ['publication'] } } },
      ),
      /delivery-body-required/,
    );
    await assert.rejects(request('prepare', { schedule: current }), /request-invalid/);
    assert.equal(creates, 0);
  });
  it('should publish retained implementation without another human turn or handoff', async () => {
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.handoff;
      state.records[0]!.progression = { stage: 'implementation', via: 'work' };
      await save();
    });
    const find = deps.native!.find;
    deps.native!.find = async (...args) => ({ ...(await find(...args))!, followUpUserTurn: false });
    await publish();
    assert.equal(creates, 1);
    assert.equal((await request('reconcile')).status, 'ready');
    assert.equal(creates, 1);
  });
  async function workSchedule() {
    const configured = structuredClone(manifest);
    configured.github.notifications['issue-assignment'].mode = 'work';
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
    const selected = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
    const current = {
      workflow: 'issue-assignment' as const,
      sourceThreadId: 'intake',
      automationId: 'schedule',
      definitionDigest: 'definition',
      policyDigest: automationHash(selected.manifest.github?.notifications),
    };
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.handoff;
      await save();
    });
    deps.schedule = { current, saved: { ...current, version: 1, capabilities: ['publication'] } };
  }
  it('should require an authored body before automatic publication without blocking recovery', async () => {
    await workSchedule();
    deps.authorizeSchedule = async () => {};
    for (const body of [undefined, '', '  \n']) {
      await assert.rejects(request('prepare', { body }), /delivery-body-required/);
      await assert.rejects(
        request('publish', { body, digest: 'a'.repeat(64) }),
        /delivery-body-required/,
      );
    }
    assert.equal(creates, 0);
    assert.equal(
      gitCalls.some((argv) => argv.includes('push')),
      false,
    );
    const body =
      'Added the marker. Exact bytes and final newline verified; git diff --check passed. Closes #3.';
    const preview = await request('prepare', { body });
    await request('publish', { body, digest: requiredDigest(preview) });
    assert.equal(pr!.body, body);
    // recovery must not require inventing a body for an already attempted publication.
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.delivery!.body;
      await save();
    });
    await request('reconcile');
    assert.equal((await request('prepare')).status, 'prepared');
    assert.equal(creates, 1);
  });
  it('should publish with standing work authority and keep subsequent actions in its continuation', async () => {
    await workSchedule();
    deps.authorizeSchedule = async () => {};
    const published = await publish();
    assert.equal(published.status, 'published');
    assert.equal(creates, 1);
    assert.match(String(published.instruction), /continuationRuntime action:delivery/);
  });
  for (const boundary of ['push', 'create'])
    it(`should stop before ${boundary} when standing work authority is revoked during publication`, async () => {
      await workSchedule();
      let revoked = false;
      deps.authorizeSchedule = async () => {
        if (revoked) throw new Error('continuation-authority-changed');
      };
      if (boundary === 'push') {
        const git = deps.git!;
        deps.git = async (...args) => {
          const output = await git(...args);
          if (args[1].includes('--push')) revoked = true;
          return output;
        };
      } else {
        const connect = deps.connect!;
        deps.connect = async (...args) => {
          const connected = await connect(...args);
          const execute = connected.account.execute;
          connected.account.execute = async (...command) => {
            const output = await execute(...command);
            // this read happens inside publish, after the last outer schedule check.
            if (command[0].includes('repos/owner/repo/issues/3')) revoked = true;
            return output;
          };
          return connected;
        };
      }
      await assert.rejects(publish(), /continuation-authority-changed/);
      assert.equal(creates, 0);
      assert.equal(
        gitCalls.some((argv) => argv.includes('push')),
        boundary === 'create',
      );
    });
  it('should refresh stale previews and reject changed assignments foreign chats and dirty work before writes', async () => {
    const preview = await request('prepare');
    head = 'b'.repeat(40);
    const refreshed = await request('publish', { digest: requiredDigest(preview) });
    assert.equal(refreshed.status, 'prepared');
    assert.ok('digest' in refreshed && requiredDigest(refreshed) !== requiredDigest(preview));
    await assert.rejects(request('prepare', {}, { threadId: 'other' }), /managed-issue-required/);
    dirty = true;
    await assert.rejects(request('prepare'), /uncommitted-work/);
    dirty = false;
    fixture.item.assignees = [];
    await assert.rejects(request('prepare'), /dispatch-assignment-removed/);
    assert.equal(creates, 0);
    assert.ok(!gitCalls.some((argv) => argv.includes('push')));
  });
  it('should reject foreign or closed provider identity before checkpointing or linking', async () => {
    for (const mismatch of [
      { authorId: 'foreign' },
      { headRepositoryId: 'fork' },
      { headSha: 'b'.repeat(40) },
      { baseRef: 'release' },
      { state: 'closed' },
    ]) {
      bindingOverride = mismatch;
      await assert.rejects(
        publish(),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          String(error.code).startsWith('github-delivery-binding-'),
      );
      assert.equal((await store.read()).records[0]!.delivery!.pullRequest, undefined);
      assert.equal(pr!.body, 'Authored body.');
    }
    assert.equal(creates, 1);
  });
  it('should preserve an existing ssh push transport without adding overrides', async () => {
    const git = deps.git!;
    deps.git = async (cwd, argv, signal) =>
      argv[0] === 'remote' && argv.includes('--push')
        ? 'git@github.com:owner/repo.git'
        : git(cwd, argv, signal);
    await publish();
    assert.deepEqual(
      gitCalls.find((argv) => argv.includes('push')),
      ['push', '--set-upstream', 'origin', `${firstHead}:refs/heads/pirog-work`],
    );
    assert.ok(
      !(await store.read()).records[0]!.delivery!.notices!.includes('delivery-ssh-transport'),
    );
  });
  it('should reject every foreign or invalid push destination before pushing or creating a pr', async () => {
    const git = deps.git!;
    for (const pushUrls of [
      'https://github.com/other/repo.git',
      'https://github.com/owner/repo.git\nhttps://github.com/other/repo.git',
      '',
    ]) {
      deps.git = async (cwd, argv, signal) =>
        argv[0] === 'remote' && argv.includes('--push') ? pushUrls : git(cwd, argv, signal);
      await assert.rejects(publish(), /push-destination-mismatch/);
      assert.equal(remote, '');
      assert.equal(creates, 0);
      assert.ok(!gitCalls.some((argv) => argv.includes('push')));
    }
  });
  it('should reject changed or missing existing pr bindings before advancing the remote branch', async () => {
    await publish();
    const saved = { ...pr! };
    const body = pr!.body;
    head = 'b'.repeat(40);
    gitCalls = [];
    for (const mismatch of [
      { nodeId: 'PR_other' },
      { number: 8 },
      { authorId: 'foreign' },
      { repositoryId: 'R_other' },
      { headRepositoryId: 'fork' },
      { headSha: 'c'.repeat(40) },
      { baseRef: 'release' },
      { headRef: 'foreign' },
      { state: 'closed' },
    ]) {
      bindingOverride = mismatch;
      await assert.rejects(
        publish(),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          String(error.code).startsWith('github-delivery-binding-'),
      );
      assert.equal(remote, firstHead);
      assert.equal(pr!.body, body);
    }
    bindingOverride = {};
    for (const changed of [
      undefined,
      { ...saved, state: 'closed' },
      { ...saved, itemNodeId: 'PR_other' },
    ]) {
      pr = changed;
      await assert.rejects(publish(), /incompatible pull request|no longer matches/);
      assert.equal(remote, firstHead);
    }
    assert.equal(creates, 1);
    assert.ok(!gitCalls.some((argv) => argv.includes('push')));
  });
  it('should update only a known ancestor on the same pr and reject unrelated remote heads', async () => {
    await publish();
    const operationId = (await store.read()).records[0]!.delivery!.id;
    head = 'b'.repeat(40);
    await publish();
    assert.equal(creates, 1);
    assert.equal((await store.read()).records[0]!.delivery!.id, operationId);
    assert.ok(
      gitCalls.some(
        (argv) => argv[0] === 'merge-base' && argv[2] === firstHead && argv[3] === head,
      ),
    );
    remote = 'c'.repeat(40);
    await assert.rejects(publish(), /remote-head-diverged/);
  });
  for (const interruption of ['before', 'after'] as const)
    it(`should recover metadata updates interrupted ${interruption} the provider write`, async () => {
      await publish();
      bodyWrites = 0;
      const content = { title: 'Updated title', body: 'Includes the follow-up change.' };
      failPatch = interruption;
      await assert.rejects(publish(content), /update interrupted/);
      assert.equal((await store.read()).records[0]!.delivery!.reconciled, false);
      failPatch = false;
      await publish(content);
      assert.equal(pr!.title, content.title);
      assert.equal(pr!.body, content.body + '\n\nCloses https://github.com/owner/repo/issues/3');
      assert.equal(bodyWrites, interruption === 'before' ? 2 : 1);
      assert.equal(creates, 1);
      assert.equal((await store.read()).records[0]!.delivery!.reconciled, true);
    });
  it('should freeze authored content while creation remains uncertain', async () => {
    failCreate = true;
    await assert.rejects(publish(), /transport lost/);
    await assert.rejects(
      publish({ title: 'Changed title', body: 'Changed body.' }),
      /delivery-content-changed/,
    );
    assert.equal(creates, 1);
    assert.equal(bodyWrites, 0);
  });
  it('should preserve github body edits when explicitly updating only the title', async () => {
    await publish();
    pr!.body = 'Operator clarification. Closes #3';
    head = 'b'.repeat(40);
    await publish();
    assert.equal(pr!.body, 'Operator clarification. Closes #3');
    await publish({ title: 'Revised title', body: 'Authored body.' });
    assert.equal(pr!.title, 'Revised title');
    assert.equal(pr!.body, 'Operator clarification. Closes #3');
  });
  for (const lostAnnouncement of [false, true])
    it(`should recover an interrupted follow-up push with a ${lostAnnouncement ? 'pending' : 'confirmed'} announcement`, async () => {
      await publish();
      const context = await request('compose');
      const preview = await request('candidate', {
        digest: requiredDigest(context),
        publicText: 'Delivers the requested change.',
      });
      announcement.lost = lostAnnouncement;
      await request('announce', { digest: requiredDigest(preview) });
      const retained = (await store.read()).records[0]!.delivery!;
      head = 'b'.repeat(40);
      const git = deps.git!;
      deps.git = async (...args) => {
        const output = await git(...args);
        if (args[1].includes('push')) throw new Error('push response lost');
        return output;
      };
      await assert.rejects(publish(), /push response lost/);
      assert.equal(remote, head);
      assert.equal((await store.read()).records[0]!.delivery!.pushedHead, retained.pushedHead);
      deps.git = git;
      await publish();
      const recovered = (await store.read()).records[0]!.delivery!;
      assert.equal(recovered.id, retained.id);
      assert.deepEqual(recovered.pullRequest, retained.pullRequest);
      assert.deepEqual(recovered.announcement, retained.announcement);
      announcement.lost = false;
      assert.equal((await request('announce')).status, 'announced');
      const shown = await request('present');
      assert.match(String(shown.presentation), /#issuecomment-91/);
      assert.equal(creates, 1);
      assert.equal(gitCalls.filter((argv) => argv.includes('push')).length, 2);
      assert.equal(announcement.posts, 1);
    });
  it('should wait for the verified followup head without repeating the push', async () => {
    await publish();
    const previous = head;
    head = 'b'.repeat(40);
    const connect = deps.connect!;
    let lagged = false;
    deps.connect = async (...args) => {
      const connection = await connect(...args);
      const execute = connection.account.execute;
      return {
        ...connection,
        account: {
          ...connection.account,
          execute: async (...parameters) => {
            const result = await execute(...parameters);
            if (
              !lagged &&
              remote === head &&
              parameters[0].some((value) => value.includes('headSha:'))
            ) {
              lagged = true;
              return {
                ...result,
                stdout: JSON.stringify({ ...JSON.parse(result.stdout), headSha: previous }),
              };
            }
            return result;
          },
        },
      };
    };
    assert.equal((await publish()).status, 'published');
    assert.ok(lagged);
    assert.equal(creates, 1);
    assert.equal(gitCalls.filter((argv) => argv.includes('push')).length, 2);
  });
});

describe('agent/codex-delivery native attachment', () => {
  it('should accept only a completed inventory from the current native turn and reject later removal or quoted proof', async () => {
    const item = {
      type: 'mcpToolCall',
      server: 'codex_app',
      tool: 'list_artifacts',
      status: 'completed',
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              artifacts: [
                {
                  attachmentType: 'pull_request',
                  identityKey: '["github.com","owner","repo",7]',
                  payload: { url, root: null, headBranch: null },
                },
              ],
            }),
          },
        ],
      },
    };
    let items: unknown[] = [item];
    const request = async (method: string) =>
      method === 'thread/turns/list'
        ? { data: [{ id: 'turn' }] }
        : { data: items.map((entry) => ({ turnId: 'turn', item: entry })) };
    assert.equal(await codexDeliveryAttachment(request, 'child', 'turn', url), true);
    assert.equal(await codexDeliveryAttachment(request, 'child', 'other-turn', url), false);
    items = [item, { ...item, result: { content: [{ type: 'text', text: '{"artifacts":[]}' }] } }];
    assert.equal(await codexDeliveryAttachment(request, 'child', 'turn', url), false);
    for (const invalid of [
      { ...item, status: 'failed' },
      { ...item, type: 'agentMessage' },
      { ...item, server: 'other' },
      { ...item, result: { isError: true, content: item.result.content } },
    ]) {
      items = [invalid];
      assert.equal(await codexDeliveryAttachment(request, 'child', 'turn', url), false);
    }
  });
});
