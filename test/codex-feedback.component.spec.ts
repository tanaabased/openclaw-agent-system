import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import { scanCodexFeedback } from '../agent/codex-feedback-scan.ts';
import reconcileCodexLifecycle from '../agent/codex-assignment-lifecycle.ts';
import type { CodexDispatchDependencies } from '../agent/codex-dispatch.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attemptedAnnouncement } from './delivery-announcement-fixture.ts';

import { automationHash } from '../agent/automation-hash.ts';
import runCodexFeedback, { type CodexFeedbackDependencies } from '../agent/codex-feedback.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import { runCodexIntake, selectCodexIntake } from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { account, baseline, intakeFixture } from './github-intake-fixture.ts';
import {
  reviewFixture,
  reviewCommentFixture,
  reviewClientFixture,
} from './github-review-fixtures.ts';

const id = 'd'.repeat(64);
const commenter = { ...account, login: 'contributor', nodeId: 'U_contributor' };
describe('agent/codex-feedback', () => {
  let root: string, pluginData: string, store: CodexDispatchStore, deps: CodexFeedbackDependencies;
  let comments: Array<{
    nodeId: string;
    databaseId: number;
    author: typeof account;
    body: string;
    bodyTruncated: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  let occurrence: number,
    turn: string,
    sent: boolean,
    ended: boolean,
    lost: boolean,
    creates: number,
    published: string | undefined;
  let receiptStatus: 'verified' | 'blocked' | 'uncertain';
  let receiptTurn: string | undefined;
  const call = (action: string, input = {}, child = false) =>
    runCodexFeedback(
      pluginData,
      { action, ...input },
      { ...deps, threadId: child ? 'child' : 'intake' },
    );
  beforeEach(async () => {
    receiptTurn = undefined;
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex-feedback-')));
    const workspace = join(root, 'workspace'),
      codexHome = join(root, 'codex'),
      worktree = join(root, 'worktree'),
      commonDir = join(root, 'common'),
      source = join(root, 'source');
    for (const path of [workspace, codexHome, worktree, commonDir, source]) await mkdir(path);
    pluginData = join(root, 'plugin');
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
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
              allowed: [
                { login: 'receiver', 'node-id': 'U_receiver' },
                { login: commenter.login, 'node-id': commenter.nodeId },
              ],
            },
          },
        },
      }),
    );
    await bindCodexWorkspace(pluginData, workspace);
    const fixture = intakeFixture();
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
    const admitted = (await current.store.read())!.records[0]!;
    store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records.push({
        context: 'context',
        routing: 'routing',
        routingNote: 'note',
        result: {
          version: 1,
          outcome: 'plan-ready',
          summary: 'summary',
          assessment: 'assessment',
          plan: 'plan',
          evidence: [],
          progress: { completed: [], remaining: [] },
        },
        id,
        intakeId: admitted.id,
        issueKey: automationHash([
          admitted.scope,
          admitted.receiving.nodeId,
          admitted.repository.nodeId,
          admitted.issue.nodeId,
        ]),
        sourceThreadId: 'intake',
        phase: 'complete',
        createdAt: baseline,
        manifestDigest: current.digest,
        threadId: 'child',
        worktree,
        effective: { status: 'verified', model: 'model', effort: 'high' },
        project: { id: 'project', path: source, commonDir, ref: 'main', commit: 'a'.repeat(40) },
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
      });
      await save();
    });
    comments = [];
    occurrence = 0;
    turn = 'assessment';
    sent = lost = false;
    ended = false;
    creates = 0;
    published = undefined;
    receiptStatus = 'verified';
    const authority = {
      workflow: 'issue-assignment' as const,
      automationId: 'automation',
      sourceThreadId: 'intake',
      policyDigest: automationHash(current.manifest.github!.notifications),
      definitionDigest: 'e'.repeat(64),
    };
    deps = {
      codexHome,
      now: () => baseline + 70000 + occurrence,
      activation: async () => ({
        sourceThreadId: 'intake',
        schedule: {
          current: authority,
          saved: { ...authority, version: 1, capabilities: ['feedback', 'publication'] },
        },
      }),
      native: {
        assessmentSkill: async (_cwd: string, name: string) => ({
          name,
          path: '/trusted/feedback/SKILL.md',
          scope: 'user',
          digest: 'f'.repeat(64),
        }),
        occurrence: async () => ({
          id: String(occurrence),
          automationId: 'automation',
          currentTimeIso: new Date(baseline + occurrence).toISOString(),
        }),
        find: async () => ({
          id: 'child',
          cwd: worktree,
          model: 'model',
          effort: 'high',
          status: 'idle',
          turnStatus: sent && !ended ? 'inProgress' : 'completed',
          turnEnded: !sent || ended,
          turnId: turn,
        }),
      } as unknown as NonNullable<CodexFeedbackDependencies['native']>,
      continuationNative: async () =>
        receiptStatus === 'blocked'
          ? {
              status: 'blocked',
              code: 'continuation-native-approval-denied',
              turnId: receiptTurn ?? turn,
              ended,
            }
          : !sent || receiptStatus === 'uncertain'
            ? { status: 'uncertain' }
            : { status: 'verified', turnId: receiptTurn ?? turn, ended },
      git: async (_cwd, args) =>
        args[0] === 'remote' ? 'https://github.com/owner/repo.git' : commonDir,
      feedbackConnect: async () =>
        ({
          client: {
            ...fixture.client,
            getItemContext: async () => ({
              title: 'Issue',
              body: 'Issue context',
              comments: [],
              labels: [],
              truncated: false,
            }),
          },
          comments: {
            identity: account,
            listIssueComments: async () => ({ comments, truncated: false }),
            getIssueComment: async (_o: string, _n: string, _number: number, databaseId: number) =>
              comments.find((comment) => comment.databaseId === databaseId),
            createIssueComment: async (_o: string, _n: string, _num: number, body: string) => {
              creates++;
              published = body;
              if (lost) throw new Error('lost');
              return { nodeId: 'reply', databaseId: 99 };
            },
            findOwnIssueComment: async () =>
              published ? { nodeId: 'reply', databaseId: 99, body: published } : undefined,
          },
        }) as unknown as Awaited<
          ReturnType<NonNullable<CodexFeedbackDependencies['feedbackConnect']>>
        >,
    };
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  async function feedbackMode(mode: 'plan' | 'work' | 'auto') {
    const path = join(root, 'workspace', 'agent.yaml');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.github.notifications['issue-assignment'].mode = mode;
    await writeFile(path, JSON.stringify(manifest));
  }
  for (const message of ['Why this approach?', 'Keep the smaller approach in the plan.'])
    it(`should retain planning input without implementation for ${message.toLowerCase()}`, async () => {
      const ref = await prepare(commenter, `@receiver ${message}`);
      sent = true;
      turn = 'feedback';
      const context = await call('context', ref, true);
      assert.equal(context.status, 'verified');
      assert.equal('mode' in context && context.mode, 'plan');
      const original = (await store.read()).records[0]!.result;
      const saved = await call(
        'result',
        { ...ref, result: { privateText: 'Retained plan response.' }, reply: false },
        true,
      );
      assert.equal(saved.status, 'recorded');
      const record = (await store.read()).records[0]!;
      assert.deepEqual(record.result, original);
      assert.equal(record.progression, undefined);
      assert.equal(record.feedback!.events[0]!.work, undefined);
      assert.equal(creates, 0);
    });
  it('should keep plan feedback in planning and use live work policy without install', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    const context = await call('context', ref, true);
    assert.equal('mode' in context && context.mode, 'plan');
    const held = await call('implementation-context', ref, true);
    assert.equal('reason' in held && held.reason, 'implementation-direction-required');
    await feedbackMode('work');
    const active = await call('implementation-context', ref, true);
    assert.equal(active.status, 'verified');
    await feedbackMode('plan');
    const retained = await call('context', ref, true);
    assert.equal('mode' in retained && retained.mode, 'work');
    assert.equal((await store.read()).records[0]!.result!.outcome, 'plan-ready');
  });
  it('should resume the retained feedback after provider access is repaired', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    const connect = deps.feedbackConnect!;
    deps.feedbackConnect = async (...args) => {
      const provider = await connect(...args);
      provider.comments.getIssueComment = async () => {
        throw Object.assign(new Error('github-notification-request-failed'), {
          providerDiagnostic: providerDiagnostic('github', 'api-request', 'authentication'),
        });
      };
      return provider;
    };
    await call('context', ref, true);
    const failed = (await store.read()).records[0]!.feedback!.events[0]!;
    assert.notEqual(failed.phase, 'blocked');
    assert.equal(failed.providerDiagnostic?.classification, 'authentication');
    deps.feedbackConnect = connect;
    assert.equal((await call('context', ref, true)).status, 'verified');
    assert.equal((await store.read()).records[0]!.feedback!.events.length, 1);
    assert.equal(creates, 0);
  });
  it('should accept explicit implementation direction from approved feedback in plan', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await call('context', ref, true);
    const result = await call(
      'implementation-context',
      {
        ...ref,
        decision: {
          mode: 'work',
          reasons: ['Approved author asks to implement.'],
          plan: 'Implement the requested change.',
        },
      },
      true,
    );
    assert.equal(result.status, 'verified');
    assert.equal((await store.read()).records[0]!.progression?.via, 'operator');
  });
  it('should retain feedback clarification and completed work without overwriting the initial result', async () => {
    await feedbackMode('work');
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await call('context', ref, true);
    const original = (await store.read()).records[0]!.result;
    const decision = {
      mode: 'work',
      reasons: ['Approved revised plan.'],
      plan: 'Use the smaller parser change.',
    };
    await call('implementation-context', { ...ref, decision }, true);
    const result = {
      outcome: 'clarification-needed',
      summary: 'Need a value.',
      fullResult: 'Partial work is retained.',
      questions: ['Which value?'],
    };
    assert.equal(
      (await call('implementation-result', { ...ref, implementationResult: result }, true)).status,
      'recorded',
    );
    assert.equal((await call('implementation-context', ref, true)).status, 'finished');
    const saved = (await store.read()).records[0]!;
    assert.equal(saved.progression?.stage, 'implementation');
    assert.deepEqual(saved.feedback!.events[0]!.work!.result, result);
    assert.deepEqual(saved.result, original);
    await call('result', { ...ref, result: { privateText: 'Which value?' }, reply: false }, true);
    await feedbackMode('plan');
    sent = false;
    ended = true;
    occurrence++;
    comments.push({
      ...comments[0]!,
      nodeId: 'answer',
      databaseId: 43,
      body: '@receiver use the smaller value.',
      createdAt: '2026-10-13T01:01:00Z',
      updatedAt: '2026-10-13T01:01:00Z',
    });
    const next = await call('next');
    assert.equal(next.status, 'feedback-prepared');
    assert.ok('eventId' in next && next.eventId);
    sent = true;
    ended = false;
    turn = 'feedback-answer';
    const context = await call('context', { id, eventId: next.eventId }, true);
    assert.ok('previousFeedbackWork' in context && context.previousFeedbackWork);
    assert.deepEqual(context.previousFeedbackWork[0]!.decision, decision);
    assert.deepEqual(context.previousFeedbackWork[0]!.result, result);
    assert.equal(context.previousFeedbackWork[0]!.privateText, 'Which value?');
    const resumed = await call('implementation-context', { id, eventId: next.eventId }, true);
    assert.equal(resumed.status, 'verified');
    assert.ok('previousFeedbackWork' in resumed && resumed.previousFeedbackWork);
    assert.deepEqual(resumed.previousFeedbackWork[0]!.result, result);
    assert.deepEqual(resumed.previousFeedbackWork, context.previousFeedbackWork);
  });
  it('should require a reasoned auto work decision and bind done feedback to its commit', async () => {
    await feedbackMode('auto');
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await call('context', ref, true);
    const held = await call('implementation-context', ref, true);
    assert.equal('reason' in held && held.reason, 'auto-decision-required');
    const selected = await call(
      'implementation-context',
      {
        ...ref,
        decision: {
          mode: 'work',
          reasons: ['Bounded correction.'],
          plan: 'Correct and test the handler.',
        },
      },
      true,
    );
    assert.equal(selected.status, 'verified');
    const git = deps.git!;
    deps.git = async (cwd, args, signal) =>
      args[0] === 'status'
        ? ''
        : args.join(' ') === 'rev-parse --verify HEAD'
          ? 'c'.repeat(40)
          : git(cwd, args, signal);
    const result = { outcome: 'done', summary: 'Corrected.', fullResult: 'Corrected and tested.' };
    assert.equal(
      (await call('implementation-result', { ...ref, implementationResult: result }, true)).status,
      'recorded',
    );
    const saved = (await store.read()).records[0]!;
    assert.equal(saved.feedback!.events[0]!.work!.head, 'c'.repeat(40));
    assert.equal(saved.progression?.via, 'auto');
    assert.equal((await call('implementation-context', ref, true)).status, 'finished');
    const conflict = await call(
      'implementation-result',
      { ...ref, implementationResult: { ...result, summary: 'Different.' } },
      true,
    );
    assert.equal('code' in conflict && conflict.code, 'feedback-implementation-result-conflict');
  });
  it('should retain the previous policy check even when feedback discovery is cached', async () => {
    const path = join(root, 'workspace', 'agent.yaml');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.github.notifications['issue-assignment'].feedback = false;
    await writeFile(path, JSON.stringify(manifest));
    await call('next');
    const first = deps.now!();
    let now = first + 1000;
    deps.now = () => now;
    // the same native occurrence reuses discovery, but must still save the policy check.
    await call('next');
    assert.equal((await store.read()).records[0]!.feedback!.admission?.observedAt, now);
    manifest.github.notifications['issue-assignment'].feedback = true;
    await writeFile(path, JSON.stringify(manifest));
    now += 1000;
    await call('next');
    assert.equal((await store.read()).records[0]!.feedback!.admission?.after, first + 1000);
  });
  it('should continue scanning after an owner changes during its first checkpoint', async () => {
    const state = await store.read();
    const first = state.records[0]!;
    state.records.push({
      ...structuredClone(first),
      id: 'e'.repeat(64),
      sourceThreadId: 'changed-owner',
    });
    const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
    const visits: string[] = [];
    const scans = await scanCodexFeedback({
      state,
      current,
      provider: await deps.feedbackConnect!(current.workspace, AbortSignal.timeout(1000)),
      occurrence: 'checkpoint-test',
      sourceThreadId: 'intake',
      now: baseline + 70000,
      checkpoint: async (scan) => {
        visits.push(scan.id);
        if (scan.id === first.id) throw new Error('discovery-checkpoint-changed');
      },
    });
    assert.ok(visits.includes('e'.repeat(64)));
    assert.equal(first.feedback, undefined);
    assert.deepEqual(
      scans.map((scan) => [scan.id, scan.feedback.code]),
      [['e'.repeat(64), undefined]],
    );
  });
  async function prepare(author = commenter, body = '@receiver explain this') {
    await call('next');
    comments.push({
      nodeId: 'comment',
      databaseId: 42,
      author,
      body,
      bodyTruncated: false,
      createdAt: '2026-10-13T01:00:00Z',
      updatedAt: '2026-10-13T01:00:00Z',
    });
    occurrence++;
    const result = await call('next');
    assert.equal(result.status, 'feedback-prepared');
    assert.ok('eventId' in result && result.eventId);
    return { id, eventId: result.eventId };
  }
  it('should preserve feedback receipt custody when the scheduler moves to another chat', async () => {
    const ref = await prepare();
    const original = structuredClone((await store.read()).records[0]!.feedback!.events[0]!.attempt);
    const activation = deps.activation!;
    deps.activation = async (...args) => {
      const selected = await activation(...args);
      return {
        ...selected,
        sourceThreadId: 'replacement',
        schedule: selected.schedule && {
          current: { ...selected.schedule.current, sourceThreadId: 'replacement' },
          saved: { ...selected.schedule.saved, sourceThreadId: 'replacement' },
        },
      };
    };
    sent = true;
    turn = 'feedback';
    assert.equal((await call('context', ref, true)).status, 'verified');
    const retained = (await store.read()).records[0]!;
    assert.equal(retained.sourceThreadId, 'intake');
    assert.deepEqual(retained.feedback!.events[0]!.attempt, { ...original, turnId: 'feedback' });
    assert.equal(original?.sourceThreadId, 'intake');
  });

  it('should reactivate unassigned codex feedback in the original chat and retire again on closure', async () => {
    const provider = await deps.feedbackConnect!('', new AbortController().signal);
    const item = await provider.client.getItem('owner', 'repo', 3);
    item.assignees = [];
    const history = await provider.client.listAssignmentEvents('owner', 'repo', 3);
    history.events.push({
      ...history.events[0]!,
      nodeId: 'removed',
      databaseId: 31,
      event: 'unassigned',
      createdAt: new Date(baseline + 65_000).toISOString(),
    });
    comments.push({
      nodeId: 'comment',
      databaseId: 42,
      author: commenter,
      body: '@receiver explain this',
      bodyTruncated: false,
      createdAt: new Date(baseline + 68_000).toISOString(),
      updatedAt: new Date(baseline + 68_000).toISOString(),
    });
    const lifecycle = () =>
      reconcileCodexLifecycle(pluginData, {
        ...deps,
        threadId: 'intake',
        connect: async () => provider.client,
      } as CodexDispatchDependencies);
    await lifecycle();
    const active = (await store.read()).records[0]!;
    assert.equal(active.retirement, undefined);
    assert.equal(active.feedbackReactivation?.assignmentEventId, 'removed');
    assert.equal((await call('next')).status, 'feedback-prepared');
    assert.equal((await store.read()).records[0]!.threadId, 'child');
    occurrence += 60_000;
    await lifecycle();
    assert.equal((await store.read()).records[0]!.retirement, undefined);
    item.state = 'closed';
    occurrence += 60_000;
    await lifecycle();
    assert.equal((await store.read()).records[0]!.retirement?.reason, 'issue-closed');
    assert.equal((await store.read()).records[0]!.feedbackReactivation, undefined);
  });
  it('should require occurrence activation before feedback discovery despite retained-work access', async () => {
    const before = await store.read();
    const activation = deps.activation!;
    deps.activation = async (...args) => {
      if (!args[3]) throw new Error('intake-automation-paused');
      return activation(...args);
    };
    await assert.rejects(call('next'), /intake-automation-paused/u);
    assert.deepEqual(await store.read(), before);
  });

  it('should keep the same admitted feedback event available through parent pause', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    const path = join(root, 'workspace', 'agent.yaml');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.github.notifications['issue-assignment'].enabled = false;
    manifest.github.notifications['allowed-repository-owners'] = [
      { login: 'elsewhere', 'node-id': 'O_elsewhere' },
    ];
    await writeFile(path, JSON.stringify(manifest));
    const paused = await call('context', ref, true);
    assert.equal(paused.status, 'verified', JSON.stringify(paused));
    assert.equal((await store.read()).records[0]!.feedback!.events[0]!.id, ref.eventId);
    manifest.github.notifications['issue-assignment'].enabled = true;
    await writeFile(path, JSON.stringify(manifest));
    const context = await call('context', ref, true);
    assert.equal(context.status, 'verified', JSON.stringify(context));
    assert.equal((await store.read()).records[0]!.feedback!.events[0]!.id, ref.eventId);
  });

  async function recordReply(
    ref: { id: string; eventId: string },
    privateText: string,
    publicText: string,
  ) {
    const saved = await call('result', { ...ref, result: { privateText } }, true);
    assert.equal(saved.status, 'recorded');
    assert.ok('presentation' in saved && saved.presentation?.includes(privateText));
    assert.ok(saved.presentation?.startsWith('> ## 💬 From '));
    assert.ok(saved.presentation?.includes('#issuecomment-42)'));
    const composition = await call('compose', ref, true);
    assert.equal(composition.status, 'composition-ready');
    assert.ok('digest' in composition && composition.digest);
    const candidate = await call(
      'candidate',
      { ...ref, digest: composition.digest, publicText },
      true,
    );
    assert.equal(candidate.status, 'candidate-recorded');
    return composition;
  }
  it('should reconcile a lost announcement receipt before admitting same-account feedback', async () => {
    await call('next');
    const announcement = attemptedAnnouncement(account.nodeId);
    published = announcement.body;
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.delivery = {
        id,
        binding: {
          repositoryId: 'R_repo',
          issueId: 'I_issue',
          threadId: 'child',
          worktree: record.worktree!,
          branch: 'branch',
          base: 'main',
          head: 'a'.repeat(40),
          authorId: account.nodeId,
          policyDigest: 'a'.repeat(64),
        },
        creationAttempted: true,
        reconciled: true,
        attached: true,
        cardAttempts: 1,
        announcement: announcement.state,
      };
      await save();
    });
    for (const [nodeId, databaseId, body] of [
      ['reply', 99, announcement.body],
      ['human', 100, '@receiver explain this'],
    ] as const)
      comments.push({
        nodeId,
        databaseId,
        body,
        author: account,
        bodyTruncated: false,
        createdAt: '2026-10-13T01:00:00Z',
        updatedAt: '2026-10-13T01:00:00Z',
      });
    occurrence++;
    assert.equal((await call('next')).status, 'feedback-prepared');
    assert.deepEqual(
      (await store.read()).records[0]!.feedback!.events.map((event) => event.sourceId),
      ['human'],
    );
    assert.equal(creates, 0);
  });
  it('should finish a quiet discovery cycle when the clock advances during the scan', async () => {
    let time = baseline + 70000;
    deps.now = () => ++time;
    await call('next');
    const state = await store.read();
    assert.equal(state.discoveryCycleAt, undefined);
    assert.equal(state.records[0]!.feedback!.discoveryPending, false);
    assert.ok(Object.keys(state.records[0]!.feedback!.watermarks!).length);
  });
  it('should keep same-account feedback private even when a public candidate is supplied', async () => {
    const ref = await prepare(account);
    sent = true;
    turn = 'feedback';
    const context = await call('context', ref, true);
    assert.equal('publication' in context && context.publication, 'private-only');
    assert.ok('presentation' in context && typeof context.presentation === 'string');
    assert.match(context.presentation, /^> ## 💬 From /u);
    assert.ok(context.presentation.includes('> @receiver explain this'));
    assert.ok(context.presentation.includes('#issuecomment-42)'));
    const result = await call(
      'result',
      {
        ...ref,
        result: { privateText: 'Private answer.', publicText: '@receiver answer to myself.' },
      },
      true,
    );
    assert.equal('publication' in result && result.publication, 'private-only');
    await call('publish', ref, true);
    const event = (await store.read())!.records[0]!.feedback!.events[0]!;
    assert.deepEqual(event.result, { privateText: 'Private answer.' });
    assert.equal(event.phase, 'published');
    assert.equal(creates, 0);
  });
  it('should prepare one send, verify its receipt, retain private analysis and reconcile a lost public write', async () => {
    const ref = await prepare();
    assert.equal((await call('reconcile', ref)).status, 'uncertain');
    assert.equal((await call('next')).status, 'idle');
    sent = true;
    turn = 'feedback';
    const context = await call('context', ref, true);
    assert.equal(context.status, 'verified');
    assert.ok(
      'resultSchema' in context && context.resultSchema && 'properties' in context.resultSchema,
    );
    assert.deepEqual(Object.keys(context.resultSchema.properties), ['privateText']);
    await recordReply(ref, 'Detailed private answer.', 'A concise answer.');
    const preview = await call('publish', ref, true);
    assert.equal(preview.status, 'publication-ready');
    assert.ok('digest' in preview && preview.digest);
    assert.equal(
      'destination' in preview && preview.destination,
      'https://github.com/owner/repo/issues/3',
    );
    assert.match(('body' in preview ? preview.body : '') ?? '', /@contributor/);
    assert.doesNotMatch(JSON.stringify(preview), /Detailed private answer/);
    assert.equal(creates, 0);
    assert.equal((await call('publish', { ...ref, digest: 'stale' }, true)).status, 'waiting');
    assert.equal(creates, 0);
    lost = true;
    const apply = { ...ref, digest: preview.digest };
    assert.equal((await call('publish', apply, true)).status, 'waiting');
    ended = true;
    occurrence++;
    const completed = await call('next');
    assert.equal(completed.status, 'published');
    assert.ok('presentation' in completed && completed.presentation);
    assert.match(completed.presentation, /^> ## 💬 From /u);
    assert.ok(completed.presentation.includes('#issuecomment-42)'));
    assert.ok(
      completed.presentation.indexOf('#issuecomment-42)') <
        completed.presentation.indexOf('## Response'),
    );
    assert.match(completed.presentation, /Detailed private answer/);
    assert.match(completed.presentation, /> A concise answer/);
    assert.match(completed.presentation, /#issuecomment-99/);
    assert.equal(creates, 1);
    const saved = (await store.read())!.records[0]!.feedback!.events[0]!;
    assert.equal(saved.result!.privateText, 'Detailed private answer.');
    assert.equal(saved.receipt!.nodeId, 'reply');
  });
  it('should preview and publish an inline reply only in its retained review thread', async () => {
    const connect = deps.feedbackConnect!;
    const provider = await connect(root, new AbortController().signal);
    const review = reviewFixture({ author: commenter, body: '' });
    const reply = reviewCommentFixture({
      author: commenter,
      replyToId: 70,
      body: '@receiver explain in this thread',
    });
    const parent = reviewCommentFixture({ databaseId: 70, nodeId: 'parent', reviewId: 60 });
    const reviews = reviewClientFixture(review, [reply, parent]);
    reviews.getReviewComments = async () => [reply];
    const getItem = provider.client.getItem;
    provider.client.getItem = async (owner, name, number) =>
      number === 45
        ? {
            ...intakeFixture().item,
            number,
            nodeId: 'PR_delivery',
            itemType: 'pull-request',
            pullRequest: {
              baseRef: 'main',
              baseRepositoryDatabaseId: 10,
              baseRepositoryNodeId: 'R_repo',
              draft: false,
              headRef: 'branch',
              headSha: 'a'.repeat(40),
              merged: false,
            },
          }
        : getItem(owner, name, number);
    provider.comments.reviews = reviews as typeof provider.comments.reviews;
    const roots: number[] = [];
    provider.replies = {
      create: async (_owner: string, _name: string, number: number, rootId: number) => {
        assert.equal(number, 45);
        roots.push(rootId);
        return { nodeId: 'PRRC_published', databaseId: 99 };
      },
      find: async () => undefined,
    } as unknown as typeof provider.replies;
    deps.feedbackConnect = async () => provider;
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.delivery = {
        id,
        binding: {
          repositoryId: 'R_repo',
          issueId: 'I_issue',
          threadId: 'child',
          worktree: record.worktree!,
          branch: 'branch',
          base: 'main',
          head: 'a'.repeat(40),
          authorId: account.nodeId,
          policyDigest: 'a'.repeat(64),
        },
        creationAttempted: true,
        pullRequest: { pullRequestNodeId: 'PR_delivery', pullRequestNumber: 45 },
        reconciled: true,
        attached: true,
        cardAttempts: 1,
      };
      record.feedback = { baseline: { PR_delivery: {} }, events: [] };
      await save();
    });
    const prepared = await call('next');
    assert.equal(prepared.status, 'feedback-prepared');
    assert.ok('eventId' in prepared && prepared.eventId);
    const ref = { id, eventId: prepared.eventId };
    sent = true;
    turn = 'feedback';
    assert.equal((await call('context', ref, true)).status, 'verified');
    assert.equal(
      (await call('result', { ...ref, result: { privateText: 'Full analysis.' } }, true)).status,
      'recorded',
    );
    const composed = await call('compose', ref, true);
    assert.ok('digest' in composed && composed.digest);
    assert.equal(
      (
        await call(
          'candidate',
          { ...ref, digest: composed.digest, publicText: 'Brief answer.' },
          true,
        )
      ).status,
      'candidate-recorded',
    );
    const preview = await call('publish', ref, true);
    assert.ok('digest' in preview && preview.digest);
    assert.equal(
      'destination' in preview && preview.destination,
      'https://github.com/owner/repo/pull/45#discussion_r70',
    );
    const completed = await call('publish', { ...ref, digest: preview.digest }, true);
    assert.equal(completed.status, 'published');
    assert.ok('presentation' in completed && completed.presentation?.includes('#discussion_r99'));
    await call('publish', { ...ref, digest: preview.digest }, true);
    assert.deepEqual(roots, [70]);
    assert.equal(creates, 0);
  });
  for (const debug of [false, true])
    it(`should publish unchanged feedback with debug ${debug}`, async () => {
      const path = join(root, 'workspace', 'agent.yaml');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.debug = !debug;
      manifest.github.notifications['issue-assignment'].feedback = {
        inherit: true,
        skill: 'custom:latin',
        guidance: 'Base guidance.',
      };
      await writeFile(path, JSON.stringify(manifest));
      const overlayPath = join(root, 'workspace', 'agent.local.yaml');
      await writeFile(
        overlayPath,
        JSON.stringify({
          github: {
            notifications: {
              'issue-assignment': { feedback: { guidance: 'Use concise phrasing.' } },
            },
          },
        }),
      );
      const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
      const activation = deps.activation!;
      deps.activation = async (...args) => {
        const result = await activation(...args);
        result.schedule!.current.policyDigest = automationHash(
          current.manifest.github!.notifications,
        );
        result.schedule!.saved.policyDigest = result.schedule!.current.policyDigest;
        return result;
      };
      const ref = await prepare();
      sent = true;
      turn = 'feedback';
      await call('result', { ...ref, result: { privateText: 'Private English answer.' } }, true);
      const composition = await call('compose', ref, true);
      assert.ok('digest' in composition && composition.digest);
      manifest.debug = debug;
      await writeFile(path, JSON.stringify(manifest));
      const candidate = await call(
        'candidate',
        { ...ref, digest: composition.digest, publicText: 'Ita.' },
        true,
      );
      assert.equal(candidate.status, 'candidate-recorded');
      const preview = await call('publish', ref, true);
      assert.ok('digest' in preview && preview.digest);
      const completed = await call('publish', { ...ref, digest: preview.digest }, true);
      assert.equal(completed.status, 'published');
      assert.ok('presentation' in completed && completed.presentation);
      assert.equal(
        completed.presentation.includes('[custom:latin](</trusted/feedback/SKILL.md>)'),
        debug,
      );
      assert.equal(completed.presentation.includes('Use concise phrasing.'), debug);
      if (debug) {
        assert.ok(completed.presentation.includes(`[Inline guidance](<${overlayPath}>)`));
        assert.ok(
          completed.presentation.indexOf('Feedback reply instructions') >
            completed.presentation.indexOf('Published reply'),
        );
      }
      assert.ok(
        completed.presentation.includes(
          '> ## 📤 To [@contributor](https://github.com/contributor)',
        ),
      );
      assert.ok(!published!.includes('Use concise phrasing.'));
      assert.ok(!published!.includes('custom:latin'));
      assert.ok(!published!.includes('Private English'));
    });
  it('should preserve a pending reply after unrelated workflow settings change', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await recordReply(ref, 'Private answer.', 'Public answer.');
    const path = join(root, 'workspace', 'agent.yaml');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.github.notifications['issue-assignment'].mode = 'work';
    manifest.github.notifications['issue-assignment'].implementation = {
      skill: 'custom:implementation',
    };
    manifest.github.notifications.cleanup = { enabled: false, 'grace-minutes': 5 };
    await writeFile(path, JSON.stringify(manifest));
    const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
    const activation = deps.activation!;
    deps.activation = async (...args) => {
      const result = await activation(...args);
      result.schedule!.current.policyDigest = automationHash(
        current.manifest.github!.notifications,
      );
      result.schedule!.saved.policyDigest = result.schedule!.current.policyDigest;
      return result;
    };
    const preview = await call('publish', ref, true);
    assert.equal(preview.status, 'publication-ready');
    assert.ok('digest' in preview && preview.digest);
    assert.equal(
      (await call('publish', { ...ref, digest: preview.digest }, true)).status,
      'published',
    );
    assert.equal(creates, 1);
  });
  it('should reuse one issue observation per authorization and refresh it on the next call', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    const provider = await deps.feedbackConnect!('', new AbortController().signal);
    const read = provider.client.getItem;
    let reads = 0;
    let closed = false;
    provider.client.getItem = async (...args) => {
      reads++;
      const item = await read(...args);
      return closed ? { ...item, state: 'closed' } : item;
    };
    deps.feedbackConnect = async () => provider;
    assert.equal((await call('context', ref, true)).status, 'verified');
    assert.equal(reads, 1);
    closed = true;
    const result = await call('context', ref, true);
    assert.equal(result.status, 'blocked');
    assert.equal('code' in result && result.code, 'dispatch-issue-closed');
    assert.equal(reads, 2);
    assert.equal(creates, 0);
  });
  it('should withhold publication when the admitted source changes', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await recordReply(ref, 'Private answer.', 'Public answer.');
    const preview = await call('publish', ref, true);
    assert.ok('digest' in preview && preview.digest);
    comments[0]!.body = '@receiver a different request';
    const result = await call('publish', { ...ref, digest: preview.digest }, true);
    assert.equal(result.status, 'blocked');
    assert.equal('code' in result && result.code, 'feedback-source-changed');
    assert.equal(creates, 0);
    assert.ok((await store.read())!.records[0]!.feedback!.events[0]!.result);
  });
  it('should require private retention and a current skill selection before accepting a candidate', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    assert.equal((await call('compose', ref, true)).status, 'waiting');
    const bypass = await call(
      'result',
      {
        ...ref,
        result: { privateText: 'Detailed explanation.', publicText: 'Bypass.' },
      },
      true,
    );
    assert.equal('code' in bypass && bypass.code, 'feedback-composition-required');
    await call('result', { ...ref, result: { privateText: 'Detailed explanation.' } }, true);
    const composition = await call('compose', ref, true);
    assert.ok('selection' in composition && composition.selection);
    assert.equal(composition.selection.requestedSkill, 'agent-system:agent-system-feedback-reply');
    assert.equal(
      'privateResponse' in composition && composition.privateResponse,
      'Detailed explanation.',
    );
    assert.ok('verifiedOutcome' in composition && composition.verifiedOutcome?.assessment);
    assert.equal(
      (await call('candidate', { ...ref, digest: 'stale', publicText: 'Reply.' }, true)).status,
      'waiting',
    );
    deps.native!.assessmentSkill = async (_cwd, name) => ({
      name,
      path: '/trusted/feedback/SKILL.md',
      scope: 'user',
      digest: 'a'.repeat(64),
    });
    const changed = await call(
      'candidate',
      { ...ref, digest: composition.digest, publicText: 'Reply.' },
      true,
    );
    assert.equal('code' in changed && changed.code, 'feedback-composition-changed');
    const refreshed = await call('compose', ref, true);
    assert.equal(refreshed.status, 'composition-ready');
    assert.ok('digest' in refreshed && refreshed.digest !== composition.digest);
    assert.equal(
      (
        await call(
          'candidate',
          { ...ref, digest: refreshed.digest, publicText: 'Updated reply.' },
          true,
        )
      ).status,
      'candidate-recorded',
    );

    assert.equal(creates, 0);
    assert.equal(
      (await store.read()).records[0]!.feedback!.events[0]!.result!.privateText,
      'Detailed explanation.',
    );
  });
  it('should retain and display the private response when the selected skill is unavailable', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await call(
      'result',
      { ...ref, result: { privateText: 'Useful evidence and an unresolved question.' } },
      true,
    );
    deps.native!.assessmentSkill = async () => {
      throw new Error('dispatch-assessment-skill-unavailable');
    };
    const reply = await call('compose', ref, true);
    assert.equal('code' in reply && reply.code, 'feedback-skill-unavailable');
    assert.ok('presentation' in reply && reply.presentation?.includes('Useful evidence'));
    assert.ok(reply.presentation?.startsWith('> ## 💬 From '));
    assert.equal(creates, 0);
  });
  it('should permit harmless file references while keeping the existing publisher', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await recordReply(
      ref,
      'Private evidence.',
      'The example references /Users/example/project/README.md.',
    );
    const preview = await call('publish', ref, true);
    assert.ok('digest' in preview && preview.digest);
    assert.equal(
      (await call('publish', { ...ref, digest: preview.digest }, true)).status,
      'published',
    );
    assert.equal(creates, 1);
  });
  it('should allow a child result during provider discovery and discard the stale scan', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    occurrence++;
    const connect = deps.feedbackConnect!;
    let savedDuringRead = false;
    deps.feedbackConnect = async (...args) => {
      const provider = await connect(...args);
      const list = provider.comments.listIssueComments;
      provider.comments.listIssueComments = async (...parameters) => {
        if (!savedDuringRead) {
          savedDuringRead = true;
          const result = await call(
            'result',
            { ...ref, reply: false, result: { privateText: 'Concurrent result.' } },
            true,
          );
          assert.equal(result.status, 'recorded');
        }
        return list(...parameters);
      };
      return provider;
    };
    assert.equal((await call('next')).status, 'idle');
    assert.equal(savedDuringRead, true);
    const feedback = (await store.read()).records[0]!.feedback!;
    assert.equal(feedback.events[0]!.result!.privateText, 'Concurrent result.');
    assert.equal(feedback.events[0]!.phase, 'published');
    assert.notEqual(feedback.scannedAt, String(occurrence));
  });
  for (const stale of [false, true]) {
    it(`should select the oldest queued revision and block only that source when stale is ${stale}`, async () => {
      await call('next');
      for (const [index, updated] of [90000, 80000].entries())
        comments.push({
          nodeId: `comment-${index}`,
          databaseId: 42 + index,
          author: commenter,
          body: '@receiver explain this',
          bodyTruncated: false,
          createdAt: new Date(baseline + index * 1000).toISOString(),
          updatedAt: new Date(baseline + updated).toISOString(),
        });
      if (stale) {
        const connect = deps.feedbackConnect!;
        deps.feedbackConnect = async (...args) => {
          const provider = await connect(...args);
          const read = provider.comments.getIssueComment;
          provider.comments.getIssueComment = async (...parameters) => {
            const source = await read(...parameters);
            return source.databaseId === 43
              ? { ...source, body: '@receiver changed after discovery' }
              : source;
          };
          return provider;
        };
      }
      occurrence++;
      deps.now = () => baseline + 100000;
      const result = await call('next');
      assert.equal(result.status, 'feedback-prepared');
      const events = (await store.read()).records[0]!.feedback!.events;
      const newest = events.find((event) => event.sourceId === 'comment-0')!;
      const oldest = events.find((event) => event.sourceId === 'comment-1')!;
      assert.ok('eventId' in result);
      assert.equal(result.eventId, stale ? newest.id : oldest.id);
      assert.equal(oldest.phase, stale ? 'blocked' : 'prepared');
      assert.equal(newest.phase, stale ? 'prepared' : 'queued');
      if (stale) assert.equal(oldest.code, 'feedback-source-changed');
    });
  }
  it('should queue behind its busy owner and use the same slot when that owner finishes', async () => {
    await call('next');
    await store.exclusive(async (state, save) => {
      state.records[0]!.phase = 'assessing';
      await save();
    });
    comments.push({
      nodeId: 'comment',
      databaseId: 42,
      author: account,
      body: '@receiver explain this',
      bodyTruncated: false,
      createdAt: '2026-10-13T01:00:00Z',
      updatedAt: '2026-10-13T01:00:00Z',
    });
    occurrence++;
    assert.equal((await call('next')).status, 'idle');
    assert.equal((await store.read())!.records[0]!.feedback!.events[0]!.phase, 'queued');
    await store.exclusive(async (state, save) => {
      state.records[0]!.phase = 'complete';
      await save();
    });
    const find = deps.native!.find;
    deps.native!.find = async (input) => ({
      ...(await find(input))!,
      status: 'notLoaded',
      turnStatus: 'interrupted',
      turnEnded: false,
    });
    assert.equal((await call('next')).status, 'idle');
    const queued = (await store.read())!.records[0]!.feedback!.events[0]!;
    assert.equal(queued.phase, 'queued');
    assert.equal(queued.attempt, undefined);
    deps.native!.find = find;
    assert.equal((await call('next')).status, 'feedback-prepared');
  });
  it('should preserve a concurrent publication receipt and exclude its reply on the next scan', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await recordReply(ref, 'Retained explanation.', 'Public answer.');
    const preview = await call('publish', ref, true);
    assert.ok('digest' in preview && preview.digest);
    occurrence++;
    const connect = deps.feedbackConnect!;
    let publishedDuringRead = false;
    deps.feedbackConnect = async (...args) => {
      const provider = await connect(...args);
      const list = provider.comments.listIssueComments;
      provider.comments.listIssueComments = async (...parameters) => {
        if (!publishedDuringRead) {
          publishedDuringRead = true;
          assert.equal(
            (await call('publish', { ...ref, digest: preview.digest }, true)).status,
            'published',
          );
          comments.push({
            nodeId: 'reply',
            databaseId: 99,
            author: account,
            body: '@receiver public answer.',
            bodyTruncated: false,
            createdAt: '2026-10-13T01:00:01Z',
            updatedAt: '2026-10-13T01:00:01Z',
          });
        }
        return list(...parameters);
      };
      return provider;
    };
    assert.equal((await call('next')).status, 'idle');
    assert.equal((await call('next')).status, 'idle');
    const feedback = (await store.read()).records[0]!.feedback!;
    assert.equal(feedback.events.length, 1);
    assert.equal(feedback.events[0]!.receipt!.nodeId, 'reply');
    assert.equal(creates, 1);
  });
  it('should resume an interrupted composition while retaining its private response', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await call('result', { ...ref, result: { privateText: 'Saved before interruption.' } }, true);
    ended = true;
    occurrence++;
    await call('next');
    const event = (await store.read()).records[0]!.feedback!.events[0]!;
    assert.equal(event.phase, 'queued');
    assert.equal(event.code, undefined);
    assert.deepEqual(event.previousTurnIds, ['feedback']);
    const resumed = await call('next');
    assert.equal(resumed.status, 'feedback-prepared');
    assert.equal(event.result!.privateText, 'Saved before interruption.');
    assert.equal(creates, 0);
  });
  for (const outcome of ['ended', 'uncertain', 'capacity'] as const) {
    it(`should revisit queued feedback after an ended turn while respecting ${outcome}`, async () => {
      const first = await prepare();
      sent = true;
      turn = 'feedback';
      ended = true;
      comments.push({ ...comments[0]!, nodeId: 'second', databaseId: 43 });
      if (outcome === 'uncertain') receiptStatus = 'uncertain';
      if (outcome === 'capacity') {
        await store.exclusive(async (state, save) => {
          for (const digit of ['1', '2', '3']) {
            const other = structuredClone(state.records[0]!);
            other.id = digit.repeat(64);
            other.issueKey = digit.repeat(64);
            other.phase = 'assessing';
            delete other.effective;
            delete other.feedback;
            state.records.push(other);
          }
          await save();
        });
      }
      occurrence++;
      const next = await call('next');
      const events = (await store.read()).records[0]!.feedback!.events;
      assert.equal(events.length, 2);
      if (outcome === 'ended') {
        assert.equal(next.status, 'idle');
        assert.equal(events[0]!.phase, 'queued');
        assert.equal(events[1]!.phase, 'queued');
        const repeated = await call('next');
        assert.equal(repeated.status, 'feedback-prepared');
        assert.equal('eventId' in repeated && repeated.eventId, first.eventId);
      } else {
        assert.equal(next.status, 'idle');
        assert.equal(events[1]!.phase, 'queued');
        assert.equal(events[0]!.phase, outcome === 'uncertain' ? 'prepared' : 'queued');
      }
      assert.equal(creates, 0);
    });
  }
  it('should bound same-poll recovery when many queued sources have changed', async () => {
    await prepare();
    sent = ended = true;
    turn = 'feedback';
    for (let index = 1; index < 15; index++)
      comments.push({ ...comments[0]!, nodeId: `comment-${index}`, databaseId: 42 + index });
    const connect = deps.feedbackConnect!;
    deps.feedbackConnect = async (...args) => {
      const provider = await connect(...args);
      provider.comments.getIssueComment = async (_owner, _name, _number, databaseId) => ({
        ...comments.find((comment) => comment.databaseId === databaseId)!,
        body: '@receiver changed after discovery',
      });
      return provider;
    };
    occurrence++;
    await call('next');
    const state = await store.read();
    const events = state.records[0]!.feedback!.events;
    assert.equal(state.run!.actions, 12);
    assert.equal(events.filter((event) => event.phase === 'blocked').length, 12);
    assert.equal(events.filter((event) => event.phase === 'queued').length, 3);
    assert.equal((await call('next')).status, 'budget-exhausted');
    assert.equal(creates, 0);
  });
  it('should respect assignment occupancy in the common pool', async () => {
    await call('next');
    await store.exclusive(async (state, save) => {
      for (const digit of ['1', '2', '3']) {
        const other = structuredClone(state.records[0]!);
        other.id = digit.repeat(64);
        other.issueKey = digit.repeat(64);
        other.phase = 'assessing';
        delete other.effective;
        delete other.feedback;
        state.records.push(other);
      }
      await save();
    });
    comments.push({
      nodeId: 'comment',
      databaseId: 42,
      author: account,
      body: '@receiver explain this',
      bodyTruncated: false,
      createdAt: '2026-10-13T01:00:00Z',
      updatedAt: '2026-10-13T01:00:00Z',
    });
    occurrence++;
    assert.equal((await call('next')).status, 'idle');
    await store.exclusive(async (state, save) => {
      state.records.pop();
      await save();
    });
    assert.equal((await call('next')).status, 'feedback-prepared');
  });
  it('should retain a private-only answer without publishing and release its slot', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    const result = await call(
      'result',
      { ...ref, reply: false, result: { privateText: 'Needs human input.' } },
      true,
    );
    assert.equal(result.status, 'recorded');
    const record = (await store.read())!.records[0]!;
    assert.equal(record.feedback!.events[0]!.phase, 'published');
    assert.ok(record.feedback!.lastServedAt);
    assert.equal(creates, 0);
  });
  it('should withhold sensitive public content while retaining the private response', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await recordReply(ref, 'Retained analysis.', 'password: private-value');
    const reply = await call('publish', ref, true);
    assert.equal(reply.status, 'blocked');
    assert.equal(
      'code' in reply && reply.code,
      'github-notification-publication-secret-safety-rejected',
    );
    assert.equal(creates, 0);
    const saved = (await store.read())!.records[0]!.feedback!.events[0]!;
    assert.equal(saved.result!.privateText, 'Retained analysis.');
    assert.equal(saved.publicationAttempted, undefined);
    assert.equal(saved.phase, 'blocked');
  });
  it('should retain admitted feedback when discovery configuration is removed', async () => {
    await prepare();
    const manifestPath = join(root, 'workspace', 'agent.yaml');
    const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
    await writeFile(
      manifestPath,
      JSON.stringify({
        'schema-version': 1,
        agent: { id: 'receiver' },
        github: {
          username: 'receiver',
          notifications: {
            'schema-version': 2,
            runtimes: ['codex'],
            'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
            'issue-assignment': { allowed: [{ login: 'receiver', 'node-id': 'U_receiver' }] },
          },
        },
      }),
    );
    assert.ok(current.policy);
    assert.equal((await call('next')).status, 'idle');
    assert.notEqual((await store.read())!.records[0]!.feedback!.events[0]!.phase, 'blocked');
  });
  it('should retain a denied native send without another prepared request', async () => {
    await prepare();
    receiptStatus = 'blocked';
    await call('next');
    assert.equal((await store.read())!.records[0]!.feedback!.events[0]!.phase, 'blocked');
    occurrence++;
    assert.equal((await call('next')).status, 'idle');
  });
  it('should preserve native publication denial and bind explicit recovery to the exact draft', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await recordReply(ref, 'Private.', 'Approved reply.');
    ended = true;
    receiptStatus = 'blocked';
    await call('next');
    assert.equal(
      (await store.read())!.records[0]!.feedback!.events[0]!.code,
      'continuation-native-approval-denied',
    );
    occurrence++;
    assert.equal((await call('next')).status, 'idle');
    receiptTurn = turn;
    turn = 'later-human-followup';
    receiptStatus = 'blocked';
    const operator = (digest?: string) =>
      runCodexFeedback(
        pluginData,
        { action: 'publish-approved', ...ref, ...(digest ? { digest } : {}) },
        { ...deps, threadId: 'operator' },
      );
    assert.equal((await call('publish-approved', ref)).status, 'blocked');
    for (const state of ['uncertain', 'unfinished', 'different-turn'] as const) {
      receiptStatus = state === 'uncertain' ? 'uncertain' : 'blocked';
      ended = state !== 'unfinished';
      receiptTurn = state === 'different-turn' ? 'unrelated' : 'feedback';
      const rejected = await operator();
      assert.equal(
        'code' in rejected && rejected.code,
        'feedback-publication-recovery-unavailable',
      );
      assert.equal(creates, 0);
    }
    receiptStatus = 'blocked';
    receiptTurn = 'feedback';
    ended = true;
    const find = deps.native!.find;
    for (const status of ['active', 'notLoaded']) {
      deps.native!.find = async (input) => ({
        ...(await find(input))!,
        status,
        turnStatus: 'interrupted',
        turnEnded: false,
      });
      const busy = await operator();
      assert.equal('code' in busy && busy.code, 'feedback-publication-recovery-unavailable');
      assert.equal(creates, 0);
    }
    deps.native!.find = find;
    const preview = await operator();
    assert.equal(preview.status, 'publication-approval-required');
    assert.ok('digest' in preview && preview.digest);
    assert.equal(creates, 0);
    const stale = await operator('bad-digest');
    assert.equal('code' in stale && stale.code, 'feedback-publication-approval-stale');
    assert.equal(creates, 0);
    assert.equal((await operator(preview.digest)).status, 'published');
    assert.equal((await operator(preview.digest)).status, 'published');
    assert.equal(creates, 1);
    assert.equal(
      (await store.read())!.records[0]!.feedback!.events[0]!.publicationApproval!.by,
      'operator',
    );
  });
});
