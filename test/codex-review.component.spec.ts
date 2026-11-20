import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import codexReview, { type CodexReviewDependencies } from '../agent/tasks/review/codex-review.ts';
import type { GitHubPullRequestReview } from '../channels/github/provider/review-types.ts';
import { reviewEventState } from '../channels/github/provider/review-draft.ts';
import type { ReviewCI } from '../channels/github/provider/review-ci.ts';
import codexDispatchFixture from './codex-dispatch-fixture.ts';
import { account, fixturePullRequest } from './github-intake-fixture.ts';
import { reviewFixture, reviewClientFixture } from './github-review-fixtures.ts';
import runCodexFeedback, {
  type CodexFeedbackDependencies,
} from '../agent/tasks/feedback/codex-feedback.ts';
import { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import CodexDispatchStore from '../agent/tasks/dispatch/codex-dispatch-state.ts';

describe('agent/tasks/review native first review', () => {
  const f = codexDispatchFixture();
  let deps: CodexReviewDependencies;
  let ci: ReviewCI;
  let reviews: GitHubPullRequestReview[];
  let writes: number;
  let authorized: boolean;
  const target = 'https://github.com/owner/repo/pull/3';
  beforeEach(async () => {
    const pr = fixturePullRequest(f.fixture);
    pr.draft = false;
    ci = { head: pr.headSha, state: 'running', passing: false };
    reviews = [];
    writes = 0;
    authorized = true;
    await writeFile(
      join(f.workspace, 'agent.yaml'),
      JSON.stringify({
        ...f.manifest,
        github: {
          ...f.manifest.github,
          'review-request': { allowed: [{ login: account.login, 'node-id': account.nodeId }] },
        },
      }),
    );
    deps = {
      codexHome: f.codexHome,
      threadId: 'review-coordinator',
      native: f.deps.native,
      git: f.deps.git,
      readCleanupConfiguration: f.deps.readCleanupConfiguration,
      activation: async () => ({ threadId: 'review-coordinator', nativeId: 'native-intake' }),
      claimClient: {
        verify: async () => {},
        list: async () => [],
        create: async () => {
          throw new Error('local route must not publish a claim');
        },
        update: async () => {},
        remove: async () => {},
      },
      connect: async () => ({
        identity: account,
        resolveIdentity: async (value) =>
          value === 'U_operator'
            ? { login: 'operator', nodeId: 'U_operator', type: 'User' }
            : account,
        resolveIdentities: async (values) =>
          values.map((value) =>
            value === 'U_operator'
              ? { login: 'operator', nodeId: 'U_operator', type: 'User' }
              : account,
          ),
        getItem: f.fixture.client.getItem,
        getRepository: f.fixture.client.getRepository,
        discoverAssigned: f.fixture.client.discoverAssigned,
        listAssignmentEvents: f.fixture.client.listAssignmentEvents,
        discoverReviewRequests: async () => ({
          candidates: [
            {
              nodeId: f.fixture.item.nodeId,
              databaseId: f.fixture.item.databaseId,
              itemType: 'pull-request',
              number: 3,
              repositoryPath: '/repos/owner/repo',
              updatedAt: f.fixture.item.updatedAt,
            },
          ],
          incomplete: false,
          totalCount: 1,
          truncated: false,
          nextPage: 1,
        }),
        reviewRequests: {
          current: async () =>
            authorized
              ? {
                  nodeId: 'E_review',
                  databaseId: 33,
                  event: 'review_requested',
                  createdAt: '2020-01-01T00:00:00Z',
                  requester: account,
                  reviewer: account,
                }
              : undefined,
        },
        getReviewCI: async () => ci,
        getReviewRoutingContext: async () => ({ source: target, linkedIssueStatus: 'missing' }),
        reviews: {
          listReviews: async () => ({ values: reviews, nextPage: 1 }),
          getReviewComments: async () => [],
          submit: async (_owner, _name, _number, head, draft) => {
            writes++;
            const review = reviewFixture({
              author: account,
              body: draft.body,
              commitId: head,
              state: reviewEventState[draft.event],
              url: target + '#pullrequestreview-81',
            });
            reviews.push(review);
            return review;
          },
        },
      }),
    };
  });
  const call = (operation: string, input: Record<string, unknown> = {}, threadId = deps.threadId) =>
    codexReview(f.pluginData, { action: 'review', operation, ...input }, { ...deps, threadId });

  it('should retain an old request quietly through running ci and publish the first review after failure', async () => {
    const scan = await call('scan');
    assert.equal(scan.status, 'observed');
    assert.equal((await call('scan')).status, 'observed');
    assert.equal((await call('next', { projects: f.projects })).status, 'unchanged');
    assert.equal((await call('next', { projects: f.projects })).status, 'unchanged');
    assert.equal(writes, 0);
    ci.state = 'settled';
    assert.equal((await call('next', { projects: f.projects })).status, 'routing-required');
    const prepared = await call('prepare', {
      target,
      assessment: { complexity: 'medium', reason: 'Review interacting concerns.' },
    });
    assert.equal(prepared.status, 'prepared');
    assert.equal((await call('reconcile', { target })).status, 'creation-uncertain');
    f.created();
    const context = await call('context', {}, 'issue-thread');
    assert.equal(context.status, 'verified'); // child begins before coordinator bookkeeping
    assert.equal((await call('reconcile', { target })).status, 'reconciled');
    const result = await call(
      'publish',
      {
        draft: {
          event: 'REQUEST_CHANGES',
          body: '@operator Fix the demonstrated failed assertion.',
          comments: [],
        },
      },
      'issue-thread',
    );
    assert.equal(result.status, 'published');
    assert.equal(writes, 1);
    assert.equal((await call('reconcile', {}, 'issue-thread')).status, 'reconciled');
    assert.equal(writes, 1);
  });

  it('should retain a removed request without launching or publishing', async () => {
    await call('scan');
    authorized = false;
    ci.state = 'settled';
    assert.equal((await call('next', { projects: f.projects })).status, 'unchanged');
    assert.equal(writes, 0);
  });

  async function start() {
    ci.state = 'settled';
    await call('scan');
    await call('next', { projects: f.projects });
    await call('prepare', {
      target,
      assessment: { complexity: 'medium', reason: 'Contained review.' },
    });
    f.created();
    await call('reconcile', { target });
  }

  it('should deliver changed settled ci to the same idle reviewer once before its first publication', async () => {
    await start();
    Object.assign(f.native!, { status: 'idle', turnEnded: true });
    ci.state = 'running';
    assert.equal((await call('next', { projects: f.projects })).status, 'unchanged');
    assert.equal((await call('next', { projects: f.projects })).status, 'unchanged');
    ci.state = 'settled';
    const result = await call('next', { projects: f.projects });
    assert.equal(result.status, 'evidence-prepared');
    deps.continuationNative = async () => ({ status: 'uncertain' });
    assert.equal((await call('reconcile', { target })).status, 'input-uncertain');
    deps.continuationNative = async () => ({
      status: 'verified',
      turnId: 'second-turn',
      ended: true,
    });
    assert.equal((await call('reconcile', { target })).status, 'reconciled');
    assert.equal((await call('next', { projects: f.projects })).status, 'unchanged');
    assert.equal(writes, 0);
  });

  it('should honor operator model selections without requiring a request or activating a schedule', async () => {
    authorized = false;
    deps.native = {
      ...deps.native!,
      operatorInput: async () => ({ turnId: 'operator-turn', inputId: 'operator-input' }),
    };
    assert.equal(
      (await call('launch', { target, overrides: { model: 'openai/gpt-6-astra' } }, 'operator'))
        .status,
      'admitted',
    );
    ci.state = 'settled';
    assert.equal(
      (await call('next', { target, projects: f.projects }, 'operator')).status,
      'routing-required',
    );
    const result = await call(
      'prepare',
      { target, assessment: { complexity: 'low', reason: 'Small review.' } },
      'operator',
    );
    assert.equal(result.status, 'prepared');
    const records = (await f.readDispatchState()).records as Array<{ request?: { model: string } }>;
    assert.equal(records[0]!.request!.model, 'gpt-6-astra');
  });

  it('should preserve native preparation denials through later scans', async () => {
    ci.state = 'settled';
    await call('scan');
    await call('next', { projects: f.projects });
    deps.native = {
      ...deps.native!,
      intakeDenial: async () => ({
        sourceThreadId: 'review-coordinator',
        turnId: 'first',
        callId: 'denied',
        operation: 'prepare',
        automatic: true,
      }),
    };
    await assert.rejects(
      call('prepare', { target, assessment: { complexity: 'medium', reason: 'Contained.' } }),
      /review-native-approval-denied/,
    );
    deps.native = { ...deps.native!, intakeDenial: async () => undefined };
    assert.equal((await call('next', { projects: f.projects })).status, 'obstacles');
    assert.equal(writes, 0);
  });

  it('should deliver authorized reviewer feedback through the existing exact-source owner without issue assignment', async () => {
    const path = join(f.workspace, 'agent.yaml');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    delete manifest.github['issue-assignment'];
    manifest.github['review-request'].allowed.push({ login: 'operator', 'node-id': 'U_operator' });
    await writeFile(path, JSON.stringify(manifest));
    await start();
    Object.assign(f.native!, { status: 'idle', turnEnded: true });
    const current = await selectCodexTaskContext(f.pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records[0]!.feedback = { startedAt: 0, baseline: {}, events: [] };
      await save();
    });
    const source = {
      nodeId: 'C_explanation',
      databaseId: 77,
      author: { login: 'operator', nodeId: 'U_operator', type: 'User' },
      body: '@receiver Could you explain the failing case?',
      bodyTruncated: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const authority = {
      workflow: 'review-request' as const,
      automationId: 'native-intake',
      sourceThreadId: 'review-coordinator',
      policyDigest: current.digest,
      definitionDigest: current.digest,
    };
    const feedbackDeps: CodexFeedbackDependencies = {
      ...f.deps,
      threadId: 'review-coordinator',
      activation: async () => ({
        sourceThreadId: authority.sourceThreadId,
        schedule: {
          current: authority,
          saved: { ...authority, version: 1, capabilities: ['feedback', 'publication'] },
        },
      }),
      feedbackConnect: async (workspace, signal) => {
        const provider = await f.deps.feedbackConnect!(workspace, signal);
        return {
          ...provider,
          comments: {
            ...provider.comments,
            identity: account,
            listIssueComments: async () => ({ comments: [source], truncated: false }),
            getIssueComment: async () => source,
            reviews: {
              ...reviewClientFixture(reviewFixture(), []),
              listReviews: async () => ({ values: [], nextPage: 1 }),
            },
          },
        } as unknown as typeof provider;
      },
      continuationNative: async () => ({
        status: 'verified',
        turnId: 'feedback-turn',
        ended: false,
      }),
    };
    const result = await runCodexFeedback(f.pluginData, { action: 'next' }, feedbackDeps);
    assert.equal(result.status, 'feedback-prepared');
    assert.ok('id' in result && 'eventId' in result);
    Object.assign(f.native!, { turnId: 'feedback-turn', status: 'active', turnEnded: false });
    const context = await runCodexFeedback(
      f.pluginData,
      { action: 'context', id: result.id, eventId: result.eventId },
      { ...feedbackDeps, threadId: 'issue-thread' },
    );
    assert.equal(context.status, 'verified');
    assert.ok('issueStage' in context && context.issueStage === 'review');
    assert.ok('replyTarget' in context && context.replyTarget === target + '#issuecomment-77');
  });

  it('should retain active review custody on closure and use the shared retirement protection', async () => {
    await start();
    await f.writeCleanup(0);
    f.fixture.item.state = 'closed';
    const current = await selectCodexTaskContext(f.pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.lifecycleCheckedAt;
      await save();
    });
    await call('next', { projects: f.projects });
    const record = (await store.read()).records[0]!;
    assert.equal(record.retirement?.reason, 'issue-closed');
    assert.equal(record.retirement?.code, 'retirement-native-work-unresolved');
    assert.equal(record.reviewAdmission?.issue.nodeId, f.fixture.item.nodeId);
    assert.equal(record.retirement?.archiveAttempt, undefined);
  });

  it('should reject caller and binding overrides before native or provider work', async () => {
    for (const input of [{ id: 'other' }, { agentId: 'other' }, { workspace: '/other' }])
      await assert.rejects(call('scan', input), /review-request-invalid/);
    await assert.rejects(
      call('publish', { draft: { event: 'COMMENT', body: 'Unowned.', comments: [] } }, 'operator'),
      /manual callers must not require a heartbeat/,
    );
    assert.equal(writes, 0);
  });
});
