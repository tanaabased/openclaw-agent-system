import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import runCodexDelivery, {
  codexDeliveryAttachment,
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
  let root: string, workspace: string, pluginData: string, store: CodexDispatchStore;
  let deps: CodexDeliveryDependencies, fixture: ReturnType<typeof intakeFixture>;
  let head: string, remote: string, dirty: boolean, attached: boolean, creates: number;
  let failCreate: boolean, failLink: boolean, failRecipient: boolean, wrongIssueLink: boolean;
  let pr: Record<string, unknown> | undefined;
  let bindingOverride: Record<string, unknown>;
  let gitCalls: string[][];
  async function request(
    action: string,
    input: object = {},
    overrides: CodexDeliveryDependencies = {},
  ) {
    return runCodexDelivery(pluginData, { action, id, ...input }, { ...deps, ...overrides });
  }
  async function publish() {
    const preview = await request('prepare', { title: 'Authored title', body: 'Authored body.' });
    assert.equal(preview.status, 'prepared');
    return request('publish', {
      digest: preview.digest,
      title: 'Authored title',
      body: 'Authored body.',
    });
  }
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
    bindingOverride = {};
    gitCalls = [];
    deps = {
      codexHome,
      threadId: 'child',
      attachment: async () => attached,
      native: {
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
        if (argv[0] === 'push') remote = head;
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
            if (argv.includes('graphql'))
              return result({
                id: 'PR_7',
                closingIssuesReferences: {
                  nodes:
                    pr?.body === 'Closes #3' ||
                    pr?.body === 'Authored body.\n\nCloses https://github.com/owner/repo/issues/3'
                      ? [{ id: wrongIssueLink ? 'I_other' : 'I_issue' }]
                      : [],
                },
              });
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
              if (argv.includes('PATCH')) {
                if (failLink) throw new Error('link unavailable');
                pr = { ...pr, ...(JSON.parse(stdin!) as object) };
              }
              if (argv.some((arg) => arg.includes('headSha:')))
                return result({
                  nodeId: 'PR_7',
                  repositoryId: 'R_repo',
                  headRepositoryId: 'R_repo',
                  headSha: head,
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

  it('should publish authored multi-commit work, checkpoint linkage and require native attachment before presentation', async () => {
    const preview = await request('prepare');
    assert.equal(preview.status, 'prepared');
    assert.equal((await store.read()).records[0]!.delivery, undefined);
    assert.ok(!gitCalls.some((argv) => argv[0] === 'push'));
    const published = await publish();
    assert.equal(published.status, 'attachment-required');
    assert.equal(pr!.title, 'Authored title');
    assert.equal(pr!.body, 'Authored body.\n\nCloses https://github.com/owner/repo/issues/3');
    assert.deepEqual(
      gitCalls.find((argv) => argv[0] === 'push'),
      ['push', '--set-upstream', 'origin', `${firstHead}:refs/heads/pirog-work`],
    );
    assert.ok(!gitCalls.some((argv) => argv[0] === 'commit'));
    await assert.rejects(request('present'), /reconciliation-required/);
    assert.equal((await request('reconcile')).status, 'attachment-required');
    attached = true;
    assert.equal((await request('reconcile')).status, 'ready');
    const presented = await request('present');
    assert.equal(presented.status, 'linked');
    assert.match(JSON.stringify(presented.presentation), /feedback delivery is not available/);
    assert.equal(creates, 1);
    attached = false;
    await request('reconcile');
    await assert.rejects(request('present'), /reconciliation-required/);
  });
  it('should resume a failed linkage or recipient phase on the checkpointed pr', async () => {
    failLink = true;
    await assert.rejects(publish(), /link unavailable/);
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
    assert.equal((await publish()).status, 'attachment-required');
    assert.equal(creates, 1);
  });
  it('should retain uncertain creation intent instead of issuing another create', async () => {
    failCreate = true;
    await assert.rejects(publish(), /transport lost/);
    assert.equal((await store.read()).records[0]!.delivery!.creationAttempted, true);
    await assert.rejects(publish(), /creation-uncertain/);
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
    assert.equal((await publish()).status, 'attachment-required');
    assert.equal(creates, 1);
    assert.equal((await store.read()).records[0]!.delivery!.pullRequest!.pullRequestNumber, 7);
  });
  it('should serialize competing publications and invalidate the consumed preview', async () => {
    const preview = await request('prepare');
    const outcomes = await Promise.allSettled([
      request('publish', { digest: preview.digest }),
      request('publish', { digest: preview.digest }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    assert.ok(failure?.status === 'rejected');
    assert.match(String(failure.reason), /preview-stale/);
    assert.equal(creates, 1);
  });
  it('should verify the provider issue link instead of trusting closing prose', async () => {
    wrongIssueLink = true;
    await assert.rejects(publish(), /linkage-unverified/);
    assert.equal((await store.read()).records[0]!.delivery!.pullRequest!.pullRequestNumber, 7);
    wrongIssueLink = false;
    await publish();
    assert.equal(creates, 1);
  });
  it('should require human handoff or a fresh publication schedule and reject request-supplied authority', async () => {
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.handoff;
      await save();
    });
    await assert.rejects(request('prepare'), /human-publication-required/);
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
      /schedule-stale/,
    );
    await assert.rejects(request('prepare', { schedule: current }), /request-invalid/);
    assert.equal(creates, 0);
  });
  it('should reject stale previews, changed assignments, foreign chats and dirty work before writes', async () => {
    const preview = await request('prepare');
    head = 'b'.repeat(40);
    await assert.rejects(request('publish', { digest: preview.digest }), /preview-stale/);
    await assert.rejects(request('prepare', {}, { threadId: 'other' }), /managed-issue-required/);
    dirty = true;
    await assert.rejects(request('prepare'), /uncommitted-work/);
    dirty = false;
    fixture.item.assignees = [];
    await assert.rejects(request('prepare'), /authority-revoked/);
    assert.equal(creates, 0);
    assert.ok(!gitCalls.some((argv) => argv[0] === 'push'));
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
      await assert.rejects(publish(), /does not match/);
      assert.equal((await store.read()).records[0]!.delivery!.pullRequest, undefined);
      assert.equal(pr!.body, 'Authored body.');
    }
    assert.equal(creates, 1);
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
            text: JSON.stringify({ artifacts: [{ type: 'pull_request', identityKey: url }] }),
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
