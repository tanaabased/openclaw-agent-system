import assert from 'node:assert/strict';
import { pendingRecoveryFeedback } from '../agent/issue-task-recovery.ts';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseCleanupConfiguration } from '../agent/cleanup-configuration.ts';
import reconcileCodexLifecycle from '../agent/codex-assignment-lifecycle.ts';
import { runCodexDispatch, type CodexDispatchDependencies } from '../agent/codex-dispatch.ts';
import reportDispatch from '../agent/codex-dispatch-reporting.ts';
import { scanCodexFeedback } from '../agent/codex-feedback-scan.ts';
import discoveryCheckpoint from '../agent/discovery-checkpoint.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import commentProviderFixture from './github-comment-provider-fixture.ts';
import hydrateImplementation, { type Field } from './implementation-material-fixture.ts';

import { attemptedAnnouncement } from './delivery-announcement-fixture.ts';

import { automationHash } from '../agent/automation-hash.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import runCodexFeedback, { type CodexFeedbackDependencies } from '../agent/codex-feedback.ts';
import { runCodexIntake, selectCodexIntake } from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { account, baseline, intakeFixture } from './github-intake-fixture.ts';
import {
  reviewClientFixture,
  reviewCommentFixture,
  reviewFixture,
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
  let receiptStatus: 'verified' | 'blocked' | 'uncertain' | 'mismatch';
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
          'schema-version': 3,
          runtimes: ['codex'],
          routing: ['owner/*'],
          'issue-assignment': {
            mode: 'plan',
            allowed: [
              { login: 'receiver', 'node-id': 'U_receiver' },
              { login: commenter.login, 'node-id': commenter.nodeId },
            ],
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
        context: JSON.stringify({ source: 'https://github.com/owner/repo/issues/3' }),
        routing: 'routing',
        id,
        intakeId: admitted.id,
        issueKey: automationHash([
          admitted.scope,
          admitted.receiving.nodeId,
          admitted.repository.nodeId,
          admitted.issue.nodeId,
        ]),
        sourceThreadId: 'intake',

        createdAt: baseline,
        manifestDigest: current.digest,
        threadId: 'child',
        worktree,
        issueBranch: { attemptId: id, name: 'issue-work', phase: 'ready' },
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
      readCleanupConfiguration: async () => parseCleanupConfiguration(),
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
        intakeDenial: async () => undefined,
        intakeBoundary: async () => 'routing-command',
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
          : receiptStatus === 'mismatch'
            ? {
                status: 'mismatch',
                code: 'continuation-send-mismatch',
                callId: 'send',
                requestDigest: id,
                turnId: receiptTurn ?? turn,
                latestTurnId: receiptTurn ?? turn,
                ended,
              }
            : !sent || receiptStatus === 'uncertain'
              ? { status: 'uncertain' }
              : { status: 'verified', turnId: receiptTurn ?? turn, ended },
      git: async (_cwd, args) =>
        args[0] === 'remote'
          ? 'https://github.com/owner/repo.git'
          : args[0] === 'branch'
            ? 'issue-work'
            : commonDir,
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
    manifest.github['issue-assignment'].mode = mode;
    await writeFile(path, JSON.stringify(manifest));
  }
  for (const mode of ['plan', 'work', 'auto'] as const)
    it(`should expose ${mode} feedback as native context without a per-comment implementation owner`, async () => {
      await feedbackMode(mode);
      const ref = await prepare();
      sent = true;
      turn = 'feedback';
      await store.exclusive(async (state, save) => {
        state.records[0]!.nativeWork = {
          selection: {
            version: 1,
            requestedSkill: 'old-implementation',
            defaultSkill: false,
            observedAt: baseline,
            skill: {
              name: 'old-implementation',
              path: '/old/SKILL.md',
              scope: 'user',
              digest: 'a'.repeat(64),
            },
            guidance: {
              source: 'inline',
              content: 'Obsolete implementation instructions.',
              digest: 'b'.repeat(64),
            },
          },
        };
        await save();
      });
      const before = (await store.read()).records[0]!;
      for (const action of ['context']) {
        const context = await call(action, ref, true);
        assert.equal(context.status, 'verified');
        assert.equal('mode' in context && context.mode, mode);
        assert.deepEqual('continuationRequest' in context && context.continuationRequest, {
          action: 'context',
          id: ref.id,
        });
        assert.equal('resultSchema' in context, false);
        assert.equal('implementation' in context, false);
        assert.equal(
          JSON.stringify(context).includes('Obsolete implementation instructions.'),
          false,
        );
      }
      const after = (await store.read()).records[0]!;
      assert.deepEqual(after.progression, before.progression);
    });
  for (const code of ['dispatch-denial-execution-unresolved', 'dispatch-denial-scope-unresolved'])
    it('should scope queued feedback correctly around ' + code, async () => {
      await prepare();
      await store.exclusive(async (state, save) => {
        const unrelated = structuredClone(state.records[0]!);
        unrelated.id = 'c'.repeat(64);
        unrelated.issueKey = 'b'.repeat(64);
        unrelated.issueBranch!.attemptId = unrelated.id;
        delete unrelated.threadId;
        delete unrelated.worktree;
        delete unrelated.feedback;

        unrelated.creationAfterItemId = 'exact-create-boundary';
        state.records.push(unrelated);
        // leave the comment admitted but not yet submitted to its chat.
        const event = state.records[0]!.feedback!.events[0]!;
        delete event.attempt;
        event.phase = 'queued';
        await save();
      });
      const provider = await deps.feedbackConnect!('', new AbortController().signal);
      const dispatchDeps: CodexDispatchDependencies = {
        ...deps,
        threadId: 'intake',
        connect: async () => provider.client,
        readCleanupConfiguration: async () => {
          throw new Error('unrelated retirement unavailable');
        },
      };
      dispatchDeps.native = {
        ...deps.native!,
        intakeDenial: async () => {
          throw new Error(code);
        },
      };
      const response = await runCodexDispatch(pluginData, 'next', {}, dispatchDeps);
      assert.ok(response && 'status' in response);
      assert.equal(
        response.status,
        code === 'dispatch-denial-scope-unresolved' ? 'waiting' : 'feedback-prepared',
        JSON.stringify(response),
      );
      const held = (await store.read()).records.find((record) => record.id === 'c'.repeat(64))!;

      assert.equal(held.retry, undefined);
      assert.equal(held.threadId, undefined);
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
  it('should retain the previous policy check even when feedback discovery is cached', async () => {
    const path = join(root, 'workspace', 'agent.yaml');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const previousActors = manifest.github['issue-assignment'].allowed;
    manifest.github['issue-assignment'].allowed = [];
    manifest.github['issue-assignment'].reviewers = [];
    await writeFile(path, JSON.stringify(manifest));
    await call('next');
    const first = deps.now!();
    let now = first + 1000;
    deps.now = () => now;
    // the same native occurrence reuses discovery, but must still save the policy check.
    await call('next');
    assert.equal((await store.read()).records[0]!.feedback!.admission?.observedAt, now);
    manifest.github['issue-assignment'].allowed = previousActors;
    await writeFile(path, JSON.stringify(manifest));
    now += 1000;
    await call('next');
    assert.equal((await store.read()).records[0]!.feedback!.admission?.after, first + 1000);
  });
  for (const failure of ['none', 'provider', 'node', 'type'] as const) {
    it(`should handle closed pr discovery with ${failure} while preserving feedback`, async () => {
      const unavailable = ['provider', 'node', 'type'].includes(failure);
      await prepare();
      const state = await store.read();
      const owner = state.records[0]!;
      owner.pullRequestLink = { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 };
      owner.feedback!.baseline.PR_7 = {};
      owner.feedback!.watermarks = { ...owner.feedback!.watermarks, PR_7: baseline };
      owner.feedback!.discovery = {
        PR_7: { since: baseline, startedAt: baseline + 1, reads: {} },
        PR_other: { since: baseline, startedAt: baseline + 1, reads: {} },
      };
      const before = structuredClone(owner.feedback!);
      const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
      const provider = await deps.feedbackConnect!(current.workspace, new AbortController().signal);
      provider.comments.reviews = {
        listReviews: async () => ({ values: [], nextPage: 1 }),
        listComments: async () => ({ values: [], nextPage: 1 }),
        getReview: async () => {
          throw new Error('no reviews');
        },
        getComment: async () => {
          throw new Error('no review comments');
        },
        getReviewComments: async () => [],
      } as unknown as typeof provider.comments.reviews;
      const getItem = provider.client.getItem.bind(provider.client);
      let reopened = false;
      provider.client.getItem = async (o, n, number) => {
        if (number !== 7) return getItem(o, n, number);
        if (failure === 'provider') throw new Error('feedback-provider-unavailable');
        const item = await getItem(o, n, 3);
        if (failure === 'type')
          return { ...item, number: 7, nodeId: 'PR_7', itemType: 'issue', pullRequest: undefined };
        return {
          ...item,
          number: 7,
          nodeId: failure === 'node' ? 'PR_foreign' : 'PR_7',
          itemType: 'pull-request',
          state: reopened ? 'open' : 'closed',
          pullRequest: {
            baseRef: 'main',
            baseRepositoryDatabaseId: 10,
            baseRepositoryNodeId: 'R_repo',
            headRef: 'issue-work',
            headSha: 'a'.repeat(40),
            draft: false,
            merged: false,
          },
        };
      };
      const scans = await scanCodexFeedback({
        state,
        current,
        provider,
        occurrence: 'closed-pr',
        now: baseline + 71000,
        checkpoint: async () => {},
      });
      const feedback = scans[0]!.feedback;
      assert.equal(feedback.discovery?.PR_other, undefined);
      assert.deepEqual(feedback.baseline.PR_7, before.baseline.PR_7);
      assert.equal(feedback.watermarks?.PR_7, baseline);
      assert.equal(JSON.stringify(feedback.events), JSON.stringify(before.events));
      if (unavailable) assert.deepEqual(feedback.discovery?.PR_7, before.discovery!.PR_7);
      else {
        assert.equal(feedback.discovery?.PR_7, undefined);
        reopened = true;
        const next = await scanCodexFeedback({
          state,
          current,
          provider,
          occurrence: 'reopened-pr',
          now: baseline + 72000,
          checkpoint: async () => {},
        });
        assert.ok(next[0]!.feedback.watermarks!.PR_7! > baseline);
        assert.equal(next[0]!.feedback.discovery?.PR_7, undefined);
      }
    });
  }
  for (const association of ['relinked', 'unlinked'] as const) {
    it(`should discard ${association} pr scratch durably without querying the old source`, async () => {
      await prepare();
      const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
      await store.exclusive(async (state, save) => {
        const owner = state.records[0]!;
        owner.pullRequestLink =
          association === 'unlinked' ? null : { pullRequestNodeId: 'PR_8', pullRequestNumber: 8 };
        owner.feedback!.baseline.PR_7 = {};
        owner.feedback!.watermarks = { ...owner.feedback!.watermarks, PR_7: baseline };
        owner.feedback!.discovery = {
          PR_7: {
            since: baseline,
            startedAt: baseline + 1,
            reads: { 'comments:1': JSON.stringify({ comments: [], truncated: false }) },
          },
        };
        await save();
      });
      const before = structuredClone((await store.read()).records[0]!.feedback!);
      const provider = await deps.feedbackConnect!(current.workspace, new AbortController().signal);
      const getItem = provider.client.getItem.bind(provider.client);
      const calls: number[] = [];
      provider.client.getItem = async (owner, name, number) => {
        calls.push(number);
        assert.notEqual(number, 7, 'deselected source must not need a closure read');
        const item = await getItem(owner, name, number === 8 ? 3 : number);
        return number === 8
          ? {
              ...item,
              number: 8,
              nodeId: 'PR_8',
              itemType: 'pull-request',
              state: 'closed',
              pullRequest: {
                baseRef: 'main',
                baseRepositoryDatabaseId: 10,
                baseRepositoryNodeId: 'R_repo',
                headRef: 'issue-work',
                headSha: 'a'.repeat(40),
                draft: false,
                merged: false,
              },
            }
          : item;
      };
      for (let pass = 0; pass < 2; pass++) {
        store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
        await scanCodexFeedback({
          state: await store.read(),
          current,
          provider,
          occurrence: `pr-association-${pass}`,
          now: baseline + 71000 + pass,
          checkpoint: (scan) => discoveryCheckpoint(store, scan),
        });
        const feedback = (await store.read()).records[0]!.feedback!;
        assert.equal(feedback.discovery?.PR_7, undefined);
        assert.deepEqual(feedback.baseline.PR_7, before.baseline.PR_7);
        assert.equal(feedback.watermarks?.PR_7, baseline);
        assert.deepEqual(feedback.events, before.events);
        assert.equal(feedback.discoveryPending, false);
      }
      assert.equal(calls.includes(8), association === 'relinked');
    });
  }
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
  it('should isolate missing feedback admission during discovery and queued delivery', async () => {
    const ref = await prepare();
    const before = (await store.read()).records[0]!;
    const missingId = 'e'.repeat(64);
    await store.exclusive(async (state, save) => {
      const missing = structuredClone(before);
      missing.id = missingId;
      missing.issueKey = missingId;
      missing.intakeId = 'f'.repeat(64);
      missing.issueBranch!.attemptId = missingId;
      // Both records have a retained prepared send; neither may be sent again.
      state.records.unshift(missing);
      await save();
    });
    occurrence++;
    const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
    const scans = await scanCodexFeedback({
      state: await store.read(),
      current,
      provider: await deps.feedbackConnect!(current.workspace, new AbortController().signal),
      occurrence: 'missing-admission',
      now: baseline + 71000,
    });
    assert.equal(
      scans.find((scan) => scan.id === missingId)!.feedback.code,
      'feedback-admission-missing',
    );
    assert.equal(scans.find((scan) => scan.id === ref.id)!.feedback.code, undefined);
    sent = true;
    turn = 'feedback';
    const next = await call('next');
    assert.equal(next.status, 'idle');
    const state = await store.read();
    assert.equal(
      state.records.find((record) => record.id === ref.id)!.feedback!.events[0]!.phase,
      'delivered',
    );
    const missing = state.records.find((record) => record.id === missingId)!;
    assert.equal(missing.feedback!.events[0]!.phase, 'delivered');
    assert.equal(missing.feedback!.events[0]!.code, undefined);
    assert.deepEqual(missing.feedback!.events[0]!.attempt, {
      ...before.feedback!.events[0]!.attempt,
      turnId: 'feedback',
    });
    assert.equal(creates, 0);
  });

  for (const malformed of [false, true]) {
    it(`should ${malformed ? 'retain a safe parsing cause and continue another record' : 'discover approved feedback after a bot comment'}`, async () => {
      const state = await store.read();
      const first = state.records[0]!;
      const peer = { ...structuredClone(first), id: 'e'.repeat(64) };
      state.records.push(peer);
      const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
      const provider = await deps.feedbackConnect!(current.workspace, new AbortController().signal);
      const raw = {
        nodeId: 'IC_human',
        databaseId: 42,
        author: commenter,
        body: '@receiver explain this',
        bodyLength: 22,
        createdAt: new Date(baseline + 68000).toISOString(),
        updatedAt: new Date(baseline + 68000).toISOString(),
      };
      const bot = {
        ...raw,
        nodeId: 'IC_bot',
        databaseId: 41,
        author: {
          login: malformed ? 'bad/private-login' : 'netlify[bot]',
          nodeId: 'BOT_netlify',
          type: 'Bot',
        },
      };
      let reads = 0;
      provider.comments = commentProviderFixture(() => (++reads === 1 ? [bot, raw] : [raw]));
      for (const record of state.records)
        record.feedback = { startedAt: baseline, baseline: {}, events: [] };
      const scans = await scanCodexFeedback({
        state,
        current,
        provider,
        occurrence: 'bot-regression',
        now: baseline + 70000,
      });
      assert.equal(scans.length, 2);
      assert.equal(
        scans[0]!.feedback.code,
        malformed ? 'github-response-invalid-issue-comment-author-login' : undefined,
      );
      assert.deepEqual(
        scans[0]!.feedback.events.map((event) => event.sourceId),
        malformed ? [] : ['IC_human'],
      );
      assert.equal(scans[1]!.feedback.code, undefined);
      assert.deepEqual(
        scans[1]!.feedback.events.map((event) => event.sourceId),
        ['IC_human'],
      );
      assert.equal(JSON.stringify(scans).includes('bad/private-login'), false);
    });
  }

  async function feedbackReport(fresh = true) {
    const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
    return store.exclusive(async (state, save) => {
      const input = {
        automationId: 'automation',
        currentTimeIso: new Date(baseline).toISOString(),
      };
      if (fresh) state.run = { id: `report-${occurrence}`, ...input, actions: 12 };
      return reportDispatch(input, {
        state,
        admitted: (await current.store.read())!,
        intakeStore: current.store,
        now: baseline + 70000 + occurrence,
        slots: 2,
        save,
      });
    });
  }
  it('should report verified feedback once without making report publication a prerequisite for work', async () => {
    const ref = await prepare();
    const prepared = await feedbackReport();
    assert.ok('response' in prepared && typeof prepared.response === 'string');
    assert.doesNotMatch(prepared.response, /Feedback delivered to chat/);
    assert.equal((await store.read()).records[0]!.feedback!.events[0]!.intakeReportedAt, undefined);
    sent = true;
    turn = 'feedback';
    await call('context', ref, true);
    const delivered = (await store.read()).records[0]!.feedback!.events[0]!;
    assert.equal(delivered.phase, 'delivered');
    assert.equal(delivered.intakeReportedAt, undefined);
    // no final report is published; issue work already consumed its native input.
    occurrence++;
    const report = await feedbackReport();
    assert.ok('response' in report && typeof report.response === 'string');
    assert.match(
      report.response,
      /Feedback delivered to chat:.*owner\/repo#3.*codex:\/\/threads\/child.*1 item/,
    );
    assert.doesNotMatch(report.response, /DONT_NOTIFY|nothing new to report/);
    assert.deepEqual(await feedbackReport(false), report);
    const current = await selectCodexIntake(pluginData, { codexHome: deps.codexHome });
    store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const repeated = await feedbackReport();
    assert.ok('response' in repeated && typeof repeated.response === 'string');
    assert.doesNotMatch(repeated.response, /Feedback delivered to chat/);
    assert.equal((await call('next')).status, 'idle');
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
    const prompt = (await store.read()).records[0]!.feedback!.events.find(
      (event) => event.id === result.eventId,
    )!.attempt!.request.prompt;
    assert.ok(!prompt.startsWith('>'));
    assert.ok(!prompt.includes(id));
    assert.ok(!prompt.includes(result.eventId));
    return { id, eventId: result.eventId };
  }

  function senderHistory(items: Record<string, unknown>[] = []) {
    deps.nativeRequest = async (method, params) => {
      assert.equal(params.threadId, 'intake');
      if (method === 'thread/turns/list')
        return {
          data: Array.from({ length: occurrence + 1 }, (_, index) => {
            const id = occurrence - index;
            return {
              id: String(id),
              startedAt: 100 + id * 10,
              completedAt: id === occurrence ? null : 105 + id * 10,
              status: id === occurrence ? 'inProgress' : 'completed',
            };
          }).slice(0, params.limit === 1 ? 1 : undefined),
          nextCursor: null,
        };
      assert.equal(method, 'thread/items/list');
      return {
        data: [
          { id: 'command', type: 'commandExecution', status: 'completed' },
          ...(params.turnId === '1' ? items : []),
        ].map((item) => ({ turnId: params.turnId, item })),
        nextCursor: null,
      };
    };
  }

  it('should recover preparation lost before send and deliver the exact retained comment once', async () => {
    const raw = JSON.parse((await store.file.read())!);
    raw.records[0].routingNote = 'unused';
    raw.records[0].reservationVersion = 1;
    await store.file.write(JSON.stringify(raw));
    const ref = await prepare(
      commenter,
      '@receiver implement option 1.\nKeep `quoted` text and $variables.',
    );
    const original = (await store.read()).records[0]!.feedback!.events[0]!.attempt!;
    senderHistory();
    // The first coordinator turn ends without executing the send or saving transient JS state.
    occurrence++;
    const recovered = await call('next');
    assert.equal(recovered.status, 'feedback-prepared');
    assert.ok('nativeHandoff' in recovered);
    assert.ok('request' in recovered);
    assert.deepEqual(recovered.request, original.request);
    assert.equal(recovered.eventId, ref.eventId);
    assert.equal(
      (await store.read()).records[0]!.feedback!.events[0]!.attempt!.sourceTurnId,
      String(occurrence),
    );
    const deliveries: unknown[] = [];
    await runInNewContext('(async () => {' + recovered.nativeHandoff + '})()', {
      text: () => {},
      tools: {
        mcp__codex_app__send_message_to_thread: async (request: unknown) => {
          deliveries.push(JSON.parse(JSON.stringify(request)));
          sent = true;
          turn = 'feedback';
          // Simulate an accepted native send whose response is lost before reconciliation.
          throw new Error('response lost');
        },
      },
    }).catch((error: Error) => assert.match(error.message, /response lost/));
    assert.deepEqual(deliveries, [original.request]);
    await call('reconcile', ref);
    assert.equal((await store.read()).records[0]!.feedback!.events[0]!.phase, 'delivered');
    occurrence++;
    assert.equal((await call('next')).status, 'idle');
    assert.equal(deliveries.length, 1);
    const saved = JSON.parse((await store.file.read())!).records[0];
    assert.equal(saved.routingNote, 'unused');
    assert.equal(saved.reservationVersion, 1);
  });

  for (const outcome of ['possible-send', 'denied', 'missing-history'] as const) {
    it(`should retain ${outcome} feedback without preparing a duplicate`, async () => {
      const ref = await prepare();
      const original = (await store.read()).records[0]!.feedback!.events[0]!.attempt!;
      if (outcome === 'possible-send')
        senderHistory([
          {
            id: 'send',
            type: 'mcpToolCall',
            server: 'codex_app',
            tool: 'send_message_to_thread',
            status: 'failed',
            arguments: original.request,
          },
        ]);
      if (outcome === 'denied') {
        receiptStatus = 'blocked';
        senderHistory();
      }
      occurrence++;
      assert.equal((await call('next')).status, 'idle');
      const event = (await store.read()).records[0]!.feedback!.events[0]!;
      assert.deepEqual(event.attempt!.request, original.request);
      assert.equal(event.attempt!.id, original.id);
      assert.equal(
        event.code,
        outcome === 'denied' ? 'continuation-native-approval-denied' : 'feedback-send-unresolved',
      );
      if (outcome !== 'denied') assert.equal((await call('reconcile', ref)).status, 'uncertain');
      const report = await feedbackReport();
      assert.ok('response' in report && typeof report.response === 'string');
      assert.doesNotMatch(report.response, /Feedback delivered to chat/);
      assert.equal(
        (await store.read()).records[0]!.feedback!.events[0]!.intakeReportedAt,
        undefined,
      );
    });
  }

  it('should never mark a mismatched native send as delivered', async () => {
    const ref = await prepare();
    const attempt = (await store.read()).records[0]!.feedback!.events[0]!.attempt!;
    sent = true;
    turn = 'feedback';
    receiptStatus = 'mismatch';
    senderHistory([
      {
        id: 'send',
        type: 'mcpToolCall',
        server: 'codex_app',
        tool: 'send_message_to_thread',
        status: 'completed',
        arguments: attempt.request,
      },
    ]);
    const result = await call('reconcile', ref);
    const event = (await store.read()).records[0]!.feedback!.events[0]!;
    assert.equal(result.status, 'uncertain');
    assert.equal(event.phase, 'prepared');
    assert.equal(event.code, 'feedback-send-unresolved');
    assert.deepEqual(event.attempt!.request, attempt.request);
  });

  it('should reauthorize an unsent comment before recovering its native send', async () => {
    await prepare();
    senderHistory();
    comments[0]!.body = '@receiver changed direction';
    comments[0]!.updatedAt = '2026-10-13T02:00:00Z';
    occurrence++;
    await call('next');
    const event = (await store.read()).records[0]!.feedback!.events[0]!;
    assert.equal(event.attempt, undefined);
    assert.equal(event.phase, 'blocked');
    assert.equal(event.code, 'feedback-source-changed');
    assert.equal(pendingRecoveryFeedback(event), false);
  });
  it('should keep a native denial stopped when later receipt history is unavailable', async () => {
    const ref = await prepare();
    receiptStatus = 'blocked';
    await call('reconcile', ref);
    const original = (await store.read()).records[0]!.feedback!.events[0]!;
    receiptStatus = 'uncertain';
    senderHistory();
    occurrence++;
    assert.equal((await call('next')).status, 'idle');
    assert.equal((await call('reconcile', ref)).status, 'blocked');
    assert.deepEqual((await store.read()).records[0]!.feedback!.events[0], original);
  });
  it('should deliver native conversation once without a feedback result or a reply gate', async () => {
    const before = (await store.read()).records[0]!;
    const ref = await prepare(commenter, '@receiver why this approach?');
    sent = true;
    turn = 'feedback';
    const context = await call('context', ref, true);
    assert.equal(context.status, 'verified');
    assert.equal('resultSchema' in context, false);
    assert.equal(
      'replyTarget' in context && context.replyTarget,
      'https://github.com/owner/repo/issues/3#issuecomment-42',
    );
    const during = (await store.read()).records[0]!;
    assert.equal(during.feedback!.events[0]!.phase, 'delivered');
    assert.notEqual(during.nativeInactive, true);
    assert.deepEqual(during.progression, before.progression);
    ended = true;
    occurrence++;
    await call('next');
    const after = (await store.read()).records[0]!;
    assert.equal(after.feedback!.events[0]!.phase, 'delivered');
    assert.equal((await call('next')).status, 'idle');
    assert.equal(creates, 0);
  });
  it('should preserve completed delivery and recovery eligibility when its source is edited', async () => {
    const ref = await prepare(commenter, '@receiver initial question');
    sent = true;
    turn = 'feedback';
    assert.equal((await call('context', ref, true)).status, 'verified');
    const original = structuredClone((await store.read()).records[0]!.feedback!.events[0]!);
    assert.equal(original.phase, 'delivered');
    comments[0]!.body = '@receiver edited question';
    comments[0]!.updatedAt = '2026-10-13T02:00:00Z';
    const stale = await call('context', ref, true);
    assert.equal(stale.status, 'blocked');
    assert.equal('code' in stale && stale.code, 'feedback-source-changed');
    assert.deepEqual((await store.read()).records[0]!.feedback!.events[0], original);
    assert.equal(pendingRecoveryFeedback(original), false);
    ended = true;
    occurrence++;
    const next = await call('next');
    assert.equal(next.status, 'feedback-prepared');
    const events = (await store.read()).records[0]!.feedback!.events;
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], original);
    assert.equal(pendingRecoveryFeedback(events[1]!), true);
  });

  it('should settle verified native delivery while its response is still running', async () => {
    await prepare(commenter, '@receiver why this approach?');
    await store.exclusive(async (state, save) => {
      state.records[0]!.nativeInactive = true;
      state.records[0]!.feedback!.events[0]!.code = 'continuation-history-incomplete';
      await save();
    });
    sent = true;
    turn = 'feedback';
    ended = false;
    occurrence++;
    assert.equal((await call('next')).status, 'idle');
    const record = (await store.read()).records[0]!;
    const event = record.feedback!.events[0]!;
    assert.equal(event.phase, 'delivered');
    assert.equal(event.attempt!.turnId, 'feedback');
    assert.equal(event.code, undefined);
    assert.notEqual(record.nativeInactive, true);
    assert.equal(creates, 0);
    deps.continuationNative = async () => {
      throw new Error('settled delivery must not be polled');
    };
    occurrence++;
    assert.equal((await call('next')).status, 'idle');
    assert.deepEqual((await store.read()).records[0]!.feedback!.events[0], event);
  });
  it('should deliver a native question without requiring repository access', async () => {
    deps.git = async () => {
      throw new Error('checkout unavailable');
    };
    await rm((await store.read()).records[0]!.worktree!, { recursive: true, force: true });
    const ref = await prepare(commenter, '@receiver what is the status?');
    sent = true;
    turn = 'feedback';
    assert.equal((await call('context', ref, true)).status, 'verified');
  });
  it('should settle retained delivery without provider access or creation metadata', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.request;
      delete state.records[0]!.worktree;
      await save();
    });
    deps.feedbackConnect = async () => {
      throw new Error('provider unavailable');
    };
    deps.native!.find = async () => {
      throw new Error('creation history unavailable');
    };
    await call('reconcile', ref);
    const event = (await store.read()).records[0]!.feedback!.events[0]!;
    assert.equal(event.phase, 'delivered');
    assert.equal(event.attempt!.turnId, 'feedback');
  });
  it('should reject a changed native receipt during coordinator reconciliation', async () => {
    const ref = await prepare();
    await store.exclusive(async (state, save) => {
      state.records[0]!.feedback!.events[0]!.attempt!.turnId = 'original';
      await save();
    });
    sent = true;
    turn = 'different';
    await call('reconcile', ref);
    const event = (await store.read()).records[0]!.feedback!.events[0]!;
    assert.equal(event.phase, 'blocked');
    assert.equal(event.code, 'feedback-turn-changed');
    assert.equal(event.attempt!.turnId, 'original');
  });
  it('should reselect delivered feedback in a later turn and publish one source-bound reply', async () => {
    const ref = await prepare(commenter, '@receiver please explain.');
    sent = true;
    turn = 'feedback';
    await call('context', ref, true);
    receiptTurn = turn;
    ended = true;
    turn = 'operator-retry';
    assert.equal((await call('context', ref, true)).status, 'verified');
    await replyTransport();
    const target = 'https://github.com/owner/repo/issues/3#issuecomment-42';
    assert.equal(
      (
        await call(
          'reply',
          { operation: 'compose', target, privateText: 'Recovered answer.' },
          true,
        )
      ).status,
      'composition-ready',
    );
    await call('reply', { operation: 'candidate', target, publicText: 'The answer.' }, true);
    assert.equal((await call('reply', { operation: 'publish', target }, true)).status, 'published');
    assert.equal((await call('reply', { operation: 'publish', target }, true)).status, 'published');
    assert.equal(creates, 1);
    assert.equal((await store.read()).records[0]!.feedback!.events[0]!.attempt!.turnId, 'feedback');
  });
  async function replyTransport() {
    const workspace = join(root, 'workspace');
    const path = join(root, 'SKILL.md');
    await writeFile(path, '# configured reply');
    deps.replyConnection = async () => ({
      request: async (method) => {
        if (method === 'thread/read') return { thread: { id: 'child' } };
        if (method === 'thread/turns/list') return { data: [{ id: turn, status: 'inProgress' }] };
        if (method === 'thread/items/list')
          return {
            data: [
              {
                turnId: turn,
                item: {
                  type: 'functionCallOutput',
                  namespace: 'codex_app',
                  name: 'send_message_to_thread',
                  output: 'native delegation',
                },
              },
            ],
          };
        if (method === 'skills/list')
          return {
            data: [
              {
                cwd: workspace,
                errors: [],
                skills: [
                  {
                    name: 'agent-system:agent-system-github-reply',
                    path,
                    scope: 'user',
                    enabled: true,
                  },
                ],
              },
            ],
          };
        throw new Error('unexpected native call: ' + method);
      },
      close: async () => {},
    });
  }
  it('should compose and publish native feedback through the reply skill without a private-result checkpoint', async () => {
    const ref = await prepare(commenter, '@receiver please explain.');
    sent = true;
    turn = 'feedback';
    await call('context', ref, true);
    await replyTransport();
    const find = deps.native!.find;
    deps.native!.find = async (input) => ({ ...(await find(input))!, cwd: '/another-checkout' });
    const compose = await call(
      'reply',
      {
        operation: 'compose',
        target: 'https://github.com/owner/repo/issues/3',
        privateText: 'The explanation.',
      },
      true,
    );
    assert.equal(compose.status, 'composition-ready');
    assert.ok('selection' in compose);
    await call('reply', { operation: 'candidate', publicText: 'The answer.' }, true);
    assert.equal((await call('reply', { operation: 'publish' }, true)).status, 'published');
    assert.equal(creates, 1);
    receiptStatus = 'uncertain';
    await assert.rejects(
      call(
        'reply',
        {
          operation: 'compose',
          target: 'https://github.com/owner/repo/issues/3#issuecomment-42',
          privateText: 'Unverified delegation.',
        },
        true,
      ),
      /feedback-input-unverified/,
    );
    assert.equal(creates, 1);
  });
  for (const setting of ['model', 'effort'] as const)
    it(`should preserve feedback after operator ${setting} tuning without overriding settings`, async () => {
      const before = (await store.read()).records[0]!;
      const find = deps.native!.find;
      let tuned = setting === 'model' ? 'another-model' : 'low';
      deps.native!.find = async (input) => ({ ...(await find(input))!, [setting]: tuned });
      const ref = await prepare();
      const attempt = (await store.read()).records[0]!.feedback!.events[0]!.attempt!;
      assert.equal('model' in attempt.request, false);
      assert.equal('thinking' in attempt.request, false);
      sent = true;
      turn = 'feedback';
      tuned = setting === 'model' ? 'third-model' : 'medium';
      assert.equal((await call('context', ref, true)).status, 'verified');
      await feedbackMode('work');
      assert.equal((await call('context', ref, true)).status, 'verified');
      const after = (await store.read()).records[0]!;
      assert.deepEqual(after.request, before.request);
      assert.equal(after.routing, before.routing);
      assert.deepEqual(after.effective, {
        status: 'verified',
        model: setting === 'model' ? tuned : 'model',
        effort: setting === 'effort' ? tuned : 'high',
      });
      assert.equal(creates, 0);
    });

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
  it('should not reset assignment bookkeeping when processing feedback', async () => {
    await store.exclusive(async (state, save) => {
      state.run = {
        id: 'assignment-run',
        automationId: 'automation',
        currentTimeIso: new Date(baseline).toISOString(),
        actions: 9,
      };
      await save();
    });
    const before = (await store.read()).run;
    await prepare();
    assert.deepEqual((await store.read()).run, before);
  });

  it('should keep the same admitted feedback event available through parent pause', async () => {
    const ref = await prepare();
    sent = true;
    turn = 'feedback';
    const path = join(root, 'workspace', 'agent.yaml');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.github['issue-assignment'].paused = true;
    manifest.github.routing = ['elsewhere/*'];
    await writeFile(path, JSON.stringify(manifest));
    const paused = await call('context', ref, true);
    assert.equal(paused.status, 'verified', JSON.stringify(paused));
    assert.equal((await store.read()).records[0]!.feedback!.events[0]!.id, ref.eventId);
    manifest.github['issue-assignment'].paused = false;
    await writeFile(path, JSON.stringify(manifest));
    const context = await call('context', ref, true);
    assert.equal(context.status, 'verified', JSON.stringify(context));
    assert.equal((await store.read()).records[0]!.feedback!.events[0]!.id, ref.eventId);
  });

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
        },
        creationAttempted: true,
        reconciled: true,
        attached: true,
      };
      record.announcement = announcement.state;
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
        createdAt: new Date(baseline + 70001).toISOString(),
        updatedAt: new Date(baseline + 70001).toISOString(),
      });
    occurrence++;
    const response = await call('next');
    assert.equal(
      response.status,
      'feedback-prepared',
      JSON.stringify({
        response,
        feedback: (await store.read()).records[0]!.feedback,
      }),
    );
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
  it('should preserve the incoming body and attribution without outer quotes or a private result', async () => {
    const body =
      '@receiver **question** for @Octo-Cat\n\n> quoted context\n\n```ts\nconst value = "@code";\n```\n\nperson@example.com';
    const ref = await prepare(account, body);
    const attempt = (await store.read()).records[0]!.feedback!.events[0]!.attempt!;
    assert.ok(
      attempt.request.prompt.startsWith('[@receiver](https://github.com/receiver) **question**'),
    );
    assert.ok(attempt.request.prompt.includes('[@Octo-Cat](https://github.com/Octo-Cat)'));
    assert.ok(attempt.request.prompt.includes('const value = "@code";'));
    assert.ok(attempt.request.prompt.includes('person@example.com'));
    assert.ok(attempt.request.prompt.includes('> quoted context'));
    assert.ok(attempt.request.prompt.includes('#issuecomment-42)'));
    sent = true;
    turn = 'feedback';
    const context = await call('context', ref, true);
    assert.equal('publication' in context && context.publication, 'private-only');
    assert.ok('presentation' in context && typeof context.presentation === 'string');
    assert.ok(attempt.request.prompt.startsWith(context.presentation));
    assert.ok(context.presentation.includes('from [@receiver]'));
    assert.ok('source' in context);
    assert.equal(context.source.body, body);
    const retained = (await store.read()).records[0]!.feedback!.events[0]!;
    assert.equal(JSON.parse(retained.source).body, body);
    assert.equal(creates, 0);
  });
  for (const kind of ['inline', 'group'] as const)
    it(`should preserve ${kind} review feedback through native context and publication`, async () => {
      const connect = deps.feedbackConnect!;
      const provider = await connect(root, new AbortController().signal);
      const review = reviewFixture({
        author: commenter,
        body: kind === 'group' ? '@receiver address every finding' : '',
      });
      const reply = reviewCommentFixture({
        author: commenter,
        replyToId: 70,
        body: '@receiver explain in this thread',
      });
      const parent = reviewCommentFixture({
        databaseId: 70,
        nodeId: 'parent',
        reviewId: review.databaseId,
      });
      const findings =
        kind === 'group'
          ? Array.from({ length: 12 }, (_, i) =>
              reviewCommentFixture({
                author: commenter,
                nodeId: `finding-${i}`,
                databaseId: 100 + i,
                body: `finding ${i}: ` + 'complete evidence '.repeat(300),
                diffHunk: '+ code\n'.repeat(1600),
              }),
            )
          : [reply];
      const reviews = reviewClientFixture(review, [...findings, parent]);
      reviews.getReviewComments = async () => findings;
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
      let publishedReply: { nodeId: string; databaseId: number; body: string } | undefined;
      provider.replies = {
        create: async (
          _owner: string,
          _name: string,
          number: number,
          rootId: number,
          body: string,
        ) => {
          assert.equal(number, 45);
          roots.push(rootId);
          return (publishedReply = { nodeId: 'PRRC_published', databaseId: 99, body });
        },
        find: async () => publishedReply,
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
          },
          creationAttempted: true,
          pullRequest: { pullRequestNodeId: 'PR_delivery', pullRequestNumber: 45 },
          reconciled: true,
          attached: true,
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
      const context = await call('context', ref, true);
      assert.equal(context.status, 'verified');
      if (kind === 'group') {
        assert.ok('contextMaterials' in context && context.contextMaterials);
        const before = (await store.read()).records[0]!;
        const restored = await hydrateImplementation(context, (request) =>
          call('context', request, true),
        );
        assert.ok(typeof restored.presentation === 'string');
        assert.ok(restored.presentation.includes('[@receiver](https://github.com/receiver)'));
        for (const finding of findings) assert.ok(JSON.stringify(restored).includes(finding.body));
        assert.deepEqual((await store.read()).records[0], before);
        const request = (context.contextMaterials as { fields: Field[] }).fields[0]!.request;
        const material = request.material as { path: string[]; digest: string; offset: number };
        await assert.rejects(
          call('context', { ...request, material: { ...material, digest: '0'.repeat(64) } }, true),
          /material-stale/,
        );
        assert.notEqual((await call('context', request)).status, 'material');
        return;
      }
      assert.ok('presentation' in context && typeof context.presentation === 'string');
      assert.ok(context.presentation.includes('[@receiver](https://github.com/receiver)'));
      await replyTransport();
      const composed = await call(
        'reply',
        {
          operation: 'compose',
          target: `https://github.com/owner/repo/pull/45#discussion_r${reply.databaseId}`,
          privateText: 'Full analysis.',
        },
        true,
      );
      assert.ok('selection' in composed);
      await call(
        'reply',
        {
          operation: 'candidate',
          publicText: 'Brief answer.',
        },
        true,
      );
      const completed = await call('reply', { operation: 'publish' }, true);
      assert.equal(completed.status, 'published');
      assert.equal((await call('reply', { operation: 'reconcile' }, true)).status, 'published');
      assert.deepEqual(roots, [70]);
      assert.equal(creates, 0);
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
      deps.now = () => baseline + 100000;
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
    comments.push({
      nodeId: 'comment',
      databaseId: 42,
      author: account,
      body: '@receiver explain this',
      bodyTruncated: false,
      createdAt: '2026-10-13T01:00:00Z',
      updatedAt: '2026-10-13T01:00:00Z',
    });
    const find = deps.native!.find;
    deps.native!.find = async (input) => ({
      ...(await find(input))!,
      status: 'active',
      turnStatus: 'inProgress',
      turnEnded: false,
    });
    occurrence++;
    assert.equal((await call('next')).status, 'idle');
    assert.equal((await store.read())!.records[0]!.feedback!.events[0]!.phase, 'queued');
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
  for (const outcome of ['ended', 'uncertain', 'mismatch', 'capacity'] as const) {
    it(`should revisit queued feedback after an ended turn while respecting ${outcome}`, async () => {
      const first = await prepare();
      sent = true;
      turn = 'feedback';
      ended = true;
      comments.push({ ...comments[0]!, nodeId: 'second', databaseId: 43 });
      if (outcome === 'uncertain' || outcome === 'mismatch') receiptStatus = outcome;
      if (outcome === 'capacity') {
        await store.exclusive(async (state, save) => {
          for (const digit of ['1', '2', '3']) {
            const other = structuredClone(state.records[0]!);
            other.id = digit.repeat(64);
            delete other.issueBranch;
            other.issueKey = digit.repeat(64);

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
      assert.equal(next.status, 'feedback-prepared');
      assert.equal(
        events[0]!.phase,
        ['uncertain', 'mismatch'].includes(outcome) ? 'prepared' : 'delivered',
      );
      assert.equal(events[1]!.phase, 'prepared');
      assert.notEqual('eventId' in next && next.eventId, first.eventId);
      assert.equal(creates, 0);
    });
  }
  it('should reject changed sources without consuming the assignment action budget', async () => {
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
    assert.equal(state.run, undefined);
    assert.equal(events.filter((event) => event.phase === 'blocked').length, 14);
    assert.equal(events.filter((event) => event.phase === 'delivered').length, 1);
    assert.equal(events.filter((event) => event.phase === 'queued').length, 0);
    assert.equal((await call('next')).status, 'idle');
    assert.equal(creates, 0);
  });
  it('should deliver feedback independently of assignment occupancy', async () => {
    await call('next');
    await store.exclusive(async (state, save) => {
      for (const digit of ['1', '2', '3']) {
        const other = structuredClone(state.records[0]!);
        other.id = digit.repeat(64);
        delete other.issueBranch;
        other.issueKey = digit.repeat(64);

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
    assert.equal((await call('next')).status, 'feedback-prepared');
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
          'schema-version': 3,
          runtimes: ['codex'],
          routing: ['owner/*'],
          'issue-assignment': { allowed: [{ login: 'receiver', 'node-id': 'U_receiver' }] },
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
});
