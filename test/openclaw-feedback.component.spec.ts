import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import {
  openclawFeedbackSchema,
  type OpenClawFeedbackEvent,
} from '../agent/openclaw-feedback-state.ts';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import openClawFeedback, {
  advanceFeedbackTurn,
  type OpenClawFeedbackAction,
  type OpenClawFeedbackProvider,
} from '../agent/openclaw-feedback.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import { discoverFeedback } from '../agent/feedback-source.ts';
import { verifyOpenClawOperator } from '../agent/openclaw-work.ts';
import openClawCapacity from '../agent/openclaw-capacity.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import {
  reviewFixture,
  reviewCommentFixture,
  reviewClientFixture,
} from './github-review-fixtures.ts';
import { account, intakeFixture } from './github-intake-fixture.ts';

const actor = { login: 'operator', nodeId: 'U_operator', type: 'User' };
describe('agent/openclaw-feedback', () => {
  let root: string, record: OpenClawDispatchRecord, event: OpenClawFeedbackEvent;
  let source: GitHubCanonicalIssueComment, provider: OpenClawFeedbackProvider;
  let input: Omit<Parameters<typeof openClawFeedback>[0], 'action'>;
  let busy: boolean, lost: boolean, uncertain: boolean, revoked: boolean, skill: boolean;
  let sends: number, writes: number, saves: number, destination: string;
  let published: { nodeId: string; databaseId: number; body: string } | undefined;
  let messages: Record<string, unknown>[];
  let terminal: boolean;
  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/openclaw-feedback-'));
    await writeFile(join(root, 'SKILL.md'), '# reply fixture');
    busy = lost = uncertain = revoked = terminal = false;
    skill = true;
    sends = writes = saves = 0;
    destination = '';
    published = undefined;
    messages = [];
    const fixture = intakeFixture();
    fixture.policy.issueAssignment!.feedback = { inherit: true, allowed: [actor] };
    source = {
      nodeId: 'C',
      databaseId: 42,
      author: actor,
      body: '@receiver explain this',
      bodyTruncated: false,
      createdAt: '2026-10-13T01:00:00Z',
      updatedAt: '2026-10-13T01:00:00Z',
    };
    record = {
      id: 'a'.repeat(64),
      intakeId: 'b'.repeat(64),
      issueKey: 'c'.repeat(64),
      sourceThreadId: 'intake',
      phase: 'complete',
      createdAt: 0,
      manifestDigest: 'old-assessment-policy',
      threadId: 'issue-chat',
      worktree: root,
      request: {
        key: 'issue-chat',
        agentId: 'receiver',
        idempotencyKey: 'a'.repeat(64),
        label: '#3',
        category: 'repo',
        cwd: root,
        model: 'openai/test',
        thinkingLevel: 'high',
      },
      sessionCreation: {
        attempted: true,
        verified: true,
        sessionId: 'session',
        sourceSessionId: 'intake',
        sourceRunId: 'run',
        sourceToolCallId: 'call',
      },
      handoff: { at: 1, by: 'operator', turnId: 'operator' },
      feedback: { baseline: { I_issue: {} }, events: [] },
    };
    provider = {
      ...fixture.client,
      getItemContext: async () => ({
        title: 'issue',
        body: '',
        comments: [],
        labels: [],
        truncated: false,
      }),
      listIssueComments: async () => ({ comments: [source], truncated: false }),
      getIssueComment: async () => source,
      findOwnIssueComment: async () => published,
      createIssueComment: async (_o, _n, number, body) => {
        writes++;
        destination = `item:${number}`;
        published = { nodeId: 'reply', databaseId: 99, body };
        if (uncertain) published = undefined;
        if (lost || uncertain) throw new Error('connection-lost');
        return published!;
      },
      replies: {
        find: async () => (published ? reviewCommentFixture(published) : undefined),
        create: async (_o, _n, number, parent, body) => {
          writes++;
          destination = `review:${number}:${parent}`;
          published = { nodeId: 'reply', databaseId: 99, body };
          return reviewCommentFixture(published);
        },
      },
    };
    await discoverFeedback({
      state: record.feedback!,
      client: provider,
      policy: fixture.policy,
      owner: 'owner',
      name: 'repo',
      number: 3,
      nodeId: 'I_issue',
      itemType: 'issue',
      now: Date.now(),
    });
    event = record.feedback!.events[0]!;
    input = {
      record,
      event,
      provider,
      policy: fixture.policy,
      workspace: root,
      now: Date.now(),
      config: {},
      intake: { repository: fixture.repository, issue: fixture.item } as unknown as IntakeRecord,
      caller: {
        sessionKey: 'issue-chat',
        sessionId: 'session',
        runId: `${record.id}:feedback:${event.id}`,
        toolCallId: 'tool',
      },
      assertCurrent: async () => {
        if (revoked) throw new Error('feedback-authority-revoked');
      },
      save: async () => {
        assert.ok(Value.Check(openclawFeedbackSchema, record.feedback));
        saves++;
      },
      request: async (method, params) => {
        if (method === 'sessions.describe')
          return {
            session: {
              key: 'issue-chat',
              agentId: 'receiver',
              sessionId: 'session',
              workspaceDir: root,
              model: 'openai/test',
              thinkingLevel: 'high',
              label: '#3',
              category: 'repo',
            },
          };
        if (method === 'skills.status')
          return {
            skills: skill
              ? [
                  {
                    name: 'agent-system-feedback-reply',
                    eligible: true,
                    modelVisible: true,
                    source: 'openclaw-plugins',
                    filePath: join(root, 'SKILL.md'),
                  },
                ]
              : [],
          };
        if (method === 'chat.send') {
          assert.equal(event.turn?.status, 'attempted');
          assert.ok(saves > 0);
          sends++;
          busy = true;
          messages.push({
            role: 'user',
            content: params.message,
            idempotencyKey: `${params.idempotencyKey}:user`,
            __openclaw: {
              id: 'input',
              idempotencyKey: `${params.idempotencyKey}:user`,
              senderIsOwner: true,
            },
          });
          if (lost) throw new Error('connection-lost');
          return { runId: params.idempotencyKey, status: 'started' };
        }
        if (method === 'chat.history')
          return {
            sessionId: 'session',
            messages,
            inputReceipts: [],
            pendingInputs: { total: 0 },
            sessionInfo: { hasActiveRun: busy, activeLeafEntryId: 'current-leaf' },
          };
        if (method === 'agent.wait')
          return { runId: params.runId, status: terminal ? 'ok' : 'timeout' };
        throw new Error(`unexpected method ${method}`);
      },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const action = async (
    operation: OpenClawFeedbackAction['operation'],
    extra: Partial<OpenClawFeedbackAction> = {},
  ) =>
    openClawFeedback({
      ...input,
      action: { action: 'feedback', operation, id: record.id, eventId: event.id, ...extra },
    });
  async function start() {
    await advanceFeedbackTurn(input);
    return action('context');
  }
  async function compose(text = 'The existing handler preserves the original result.') {
    await action('result', {
      privateText: 'Full private evidence, implications, uncertainty, and answer.',
    });
    const selected = await action('compose');
    assert.ok('digest' in selected);
    await action('candidate', { digest: selected.digest, publicText: text });
    const preview = await action('publish');
    assert.ok('digest' in preview);
    return preview.digest;
  }
  it('should queue on a busy owner and recover a lost send without another input or session', async () => {
    busy = true;
    assert.equal((await advanceFeedbackTurn(input)).status, 'feedback-queued');
    assert.equal(sends, 0);
    busy = false;
    lost = true;
    await assert.rejects(advanceFeedbackTurn(input), /connection-lost/);
    assert.equal(event.turn?.status, 'attempted');
    lost = false;
    await advanceFeedbackTurn(input);
    assert.equal(sends, 1);
    assert.equal(event.turn?.status, 'consumed');
    assert.equal(openClawCapacity([record], 3).occupied, 1);
  });
  it('should retain the full private answer and publish one separately composed attributed reply', async () => {
    const context = await start();
    assert.equal(context.status, 'verified');
    const digest = await compose();
    assert.equal(writes, 0);
    const result = await action('publish', { digest });
    assert.equal(result.status, 'published');
    assert.equal(destination, 'item:3');
    assert.match(String(result.presentation), /Full private evidence/);
    assert.match(String(result.presentation), /To.*operator/);
    assert.equal(writes, 1);
    await action('publish', { digest });
    assert.equal(writes, 1);
  });
  it('should reconcile a lost publication without another create and retain uncertainty when absent', async () => {
    await start();
    const digest = await compose();
    lost = true;
    await assert.rejects(action('publish', { digest }), /connection-lost/);
    assert.equal(event.publicationAttempted, true);
    lost = false;
    assert.equal((await action('reconcile')).status, 'published');
    assert.equal(writes, 1);
    event.phase = 'responded';
    delete event.receipt;
    published = undefined;
    assert.equal((await action('reconcile')).status, 'uncertain');
    assert.equal(writes, 1);
  });
  it('should prevent feedback from claiming operator authority despite owner metadata and old grants', async () => {
    await start();
    await assert.rejects(
      verifyOpenClawOperator({
        record,
        caller: input.caller,
        operator: true,
        request: input.request,
        config: {},
      }),
      /dispatch-operator-followup-required/,
    );
    input.caller.runId = 'foreign';
    await assert.rejects(
      action('result', { privateText: 'forged' }),
      /feedback-owner-caller-required/,
    );
    assert.equal(event.result, undefined);
  });
  it('should block changed source author mention policy and assignment before publishing', async () => {
    await start();
    const digest = await compose();
    const original = structuredClone(source);
    for (const changed of [
      { body: 'mention removed' },
      { author: { ...actor, nodeId: 'other' } },
      { body: '@receiver edited question' },
    ]) {
      Object.assign(source, changed);
      await assert.rejects(
        action('publish', { digest }),
        /feedback-source-(?:changed|author-changed|no-longer-eligible)/,
      );
      Object.assign(source, original);
    }
    revoked = true;
    await assert.rejects(action('publish', { digest }), /feedback-authority-revoked/);
    revoked = false;
    input.policy.issueAssignment!.feedback = false;
    await assert.rejects(action('publish', { digest }), /feedback-authority-changed/);
    assert.equal(writes, 0);
    assert.match(event.result!.privateText, /Full private/);
  });
  it('should require the selected skill and reject changed content or stale composition', async () => {
    await start();
    await action('result', { privateText: 'Complete retained response.' });
    skill = false;
    await assert.rejects(action('compose'), /skill-unavailable/);
    skill = true;
    const selection = await action('compose');
    assert.ok('digest' in selection);
    await assert.rejects(
      action('candidate', { digest: '0'.repeat(64), publicText: 'wrong digest' }),
      /composition-stale/,
    );
    await writeFile(join(root, 'SKILL.md'), '# changed skill');
    await assert.rejects(
      action('candidate', { digest: selection.digest, publicText: 'reply' }),
      /composition-changed/,
    );
    assert.equal(writes, 0);
  });
  it('should keep self feedback private', async () => {
    source.author = account;
    event.source = JSON.stringify(source);
    const { feedbackRevision } = await import('../agent/feedback-source.ts');
    event.revision = feedbackRevision(source);
    await start();
    assert.equal(
      (await action('result', { privateText: 'Private answer.' })).publication,
      'private-only',
    );
    assert.equal(writes, 0);
  });
  it('should reject disclosure before marking any public attempt', async () => {
    await start();
    await assert.rejects(compose('password=private-value'), /not safe to publish/);
    assert.equal(event.publicationAttempted, undefined);
    assert.equal(writes, 0);
  });
  it('should reply to the exact original review thread and preserve outdated code context', async () => {
    const review = reviewFixture({ author: actor, body: '' });
    const reply = reviewCommentFixture({
      author: actor,
      body: '@receiver explain the old line',
      replyToId: 70,
    });
    const parent = reviewCommentFixture({ databaseId: 70, nodeId: 'parent', reviewId: 60 });
    Object.assign(provider, { reviews: reviewClientFixture(review, [reply, parent]) });
    provider.reviews!.getReviewComments = async () => [reply];
    provider.getItem = async () => ({
      ...intakeFixture().item,
      itemType: 'pull-request',
      nodeId: 'PR',
      number: 4,
      pullRequest: {
        baseRef: 'main',
        baseRepositoryDatabaseId: 10,
        baseRepositoryNodeId: 'R_repo',
        draft: false,
        headRef: 'task',
        headSha: 'a'.repeat(40),
        merged: false,
      },
    });
    record.work = {
      assessmentDigest: 'd'.repeat(64),
      delivery: {
        id: 'd'.repeat(64),
        binding: {
          repositoryId: 'R_repo',
          issueId: 'I_issue',
          sessionId: 'session',
          threadId: 'issue-chat',
          worktree: root,
          branch: 'task',
          base: 'main',
          head: 'a'.repeat(40),
          authorId: account.nodeId,
          policyDigest: 'd'.repeat(64),
        },
        title: 'delivery',
        body: 'body',
        creationAttempted: true,
        reconciled: true,
        pullRequest: { pullRequestNodeId: 'PR', pullRequestNumber: 4 },
      },
    };
    record.feedback = { baseline: { PR: {} }, events: [] };
    await discoverFeedback({
      state: record.feedback,
      client: provider,
      policy: input.policy,
      owner: 'owner',
      name: 'repo',
      number: 4,
      nodeId: 'PR',
      itemType: 'pull-request',
      now: Date.now(),
    });
    event = record.feedback.events.find((e) => e.sourceId === reply.nodeId)!;
    input.event = event;
    input.caller.runId = `${record.id}:feedback:${event.id}`;
    const context = await start();
    assert.ok('reviewContext' in context);
    assert.match(JSON.stringify(context.reviewContext), /originalLine/);
    const digest = await compose();
    await action('publish', { digest });
    assert.equal(destination, 'review:4:70');
  });
  it('should retain verified input custody when a long answer moves the input outside the history tail', async () => {
    await start();
    await action('result', { privateText: 'Complete response retained before composition.' });
    messages = [];
    assert.equal((await action('compose')).status, 'composition-ready');
    messages = [
      {
        role: 'user',
        content: 'changed input',
        idempotencyKey: `${event.turn!.runId}:user`,
        __openclaw: { id: 'input', idempotencyKey: `${event.turn!.runId}:user` },
      },
    ];
    await assert.rejects(action('compose'), /dispatch-turn-input-mismatch/);
  });
  it('should share three slots and count a busy owner once regardless of queued comments', async () => {
    await start();
    record.feedback!.events.push({
      ...event,
      id: 'f'.repeat(64),
      turn: undefined,
      phase: 'queued',
    });
    const operator = structuredClone(record);
    operator.id = 'd'.repeat(64);
    operator.feedback = { baseline: {}, events: [], activity: { busy: true, observedAt: 1 } };
    const idle = structuredClone(record);
    idle.id = 'e'.repeat(64);
    idle.feedback = { baseline: {}, events: [] };
    assert.deepEqual(openClawCapacity([record, operator, idle], 3), { occupied: 2, available: 1 });
    event.phase = 'blocked';
    assert.equal(openClawCapacity([record], 3).occupied, 1);
    event.turn!.inactive = true;
    assert.deepEqual(openClawCapacity([record, operator, idle], 3), { occupied: 1, available: 2 });
  });
});
