import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import feedbackPresentation from '../agent/feedback-presentation.ts';
import { discoverFeedback, feedbackRevision } from '../agent/feedback-source.ts';
import openClawCapacity from '../agent/openclaw-capacity.ts';
import { type OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import openClawFeedbackInput from '../agent/openclaw-feedback-input.ts';
import {
  openclawFeedbackSchema,
  type OpenClawFeedbackEvent,
} from '../agent/openclaw-feedback-state.ts';
import openClawFeedback, {
  advanceFeedbackTurn,
  type OpenClawFeedbackAction,
  type OpenClawFeedbackProvider,
} from '../agent/openclaw-feedback.ts';
import { verifyOpenClawWork } from '../agent/openclaw-work.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import { intakeFixture } from './github-intake-fixture.ts';
import { reviewCommentFixture } from './github-review-fixtures.ts';

const actor = { login: 'operator', nodeId: 'U_operator', type: 'User' };
describe('agent/openclaw-feedback', () => {
  let root: string, record: OpenClawDispatchRecord, event: OpenClawFeedbackEvent;
  let source: GitHubCanonicalIssueComment, provider: OpenClawFeedbackProvider;
  let input: Omit<Parameters<typeof openClawFeedback>[0], 'action'> & {
    sourcePresentation?: string;
  };
  let busy: boolean, lost: boolean, uncertain: boolean, revoked: boolean, skill: boolean;
  let sends: number, writes: number, saves: number;
  let published: { nodeId: string; databaseId: number; body: string } | undefined;
  let messages: Record<string, unknown>[];
  let terminal: boolean;
  let sessionSettings: { model: string; thinkingLevel: string };
  let customSkills: Array<Record<string, unknown>>;
  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/openclaw-feedback-'));
    await writeFile(join(root, 'SKILL.md'), '# reply fixture');
    busy = lost = uncertain = revoked = terminal = false;
    skill = true;
    customSkills = [];
    sessionSettings = { model: 'openai/test', thinkingLevel: 'high' };
    sends = writes = saves = 0;
    published = undefined;
    messages = [];
    const fixture = intakeFixture();
    fixture.policy.issueAssignment!.allowed.push(actor);
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
        published = { nodeId: 'reply', databaseId: 99, body };
        if (uncertain) published = undefined;
        if (lost || uncertain) throw new Error('connection-lost');
        return published!;
      },
      replies: {
        find: async () => (published ? reviewCommentFixture(published) : undefined),
        create: async (_o, _n, number, parent, body) => {
          writes++;
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
      sourcePresentation: feedbackPresentation(event, 'owner/repo'),
      provider,
      policy: fixture.policy,
      config: {},
      intake: {
        repository: fixture.repository,
        issue: fixture.item,
        assignment: { actor },
      } as unknown as IntakeRecord,
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
              ...sessionSettings,
              label: '#3',
              category: 'repo',
            },
          };
        if (method === 'skills.status')
          return {
            skills: skill
              ? [
                  ...customSkills,
                  ...['agent-system-github-reply', 'agent-system-task-implementation'].map(
                    (name) => ({
                      name,
                      eligible: true,
                      modelVisible: true,
                      source: 'openclaw-plugins',
                      filePath: join(root, 'SKILL.md'),
                    }),
                  ),
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
  it('should send only the native unquoted comment card without workflow instructions or identifiers', async () => {
    await advanceFeedbackTurn(input);
    assert.equal(event.turn!.message, feedbackPresentation(event, 'owner/repo'));
    assert.ok(!event.turn!.message.startsWith('>'));
    assert.ok(!event.turn!.message.includes(record.id));
    assert.ok(!event.turn!.message.includes(event.id));
  });
  it('should answer a delivered comment from a later run without execution metadata', async () => {
    await advanceFeedbackTurn(input);
    const deliveryRunId = event.turn!.runId;
    // OpenClaw 2026.10.6 CI: consumed user has a delivery key, no runId, and no pending receipt.
    assert.equal((messages[0]!.__openclaw as Record<string, unknown>).runId, undefined);
    input.caller.runId = 'queued-execution';
    assert.equal(
      await openClawFeedbackInput(record, input.caller, input.request, input.config),
      undefined,
    );
    assert.equal((await action('context')).status, 'verified');
    const feedback = await openClawFeedbackInput(record, input.caller, input.request, input.config);
    assert.equal(feedback?.event.id, event.id);
    assert.equal(feedback?.inputId, 'input');
    assert.equal(event.turn!.runId, deliveryRunId);
    assert.equal(event.turn!.executionRunId, undefined);
    assert.deepEqual(record.feedback!.context, {
      runId: 'queued-execution',
      eventId: event.id,
      inputEventId: 'input',
    });
    input.caller.runId = 'later-run';
    assert.equal(
      await openClawFeedbackInput(record, input.caller, input.request, input.config),
      undefined,
    );
    assert.equal((await action('context')).status, 'verified');
    assert.equal(sends, 1);
    assert.equal(writes, 0);
  });
  for (const execution of ['delivery', 'queued'] as const)
    it(`should preserve ${execution} consumption while a later native turn reads the selected feedback`, async () => {
      await advanceFeedbackTurn(input);
      const originalRun = event.turn!.runId;
      const executionRun = execution === 'delivery' ? originalRun : 'original-queued-execution';
      (messages[0]!.__openclaw as Record<string, unknown>).runId = executionRun;
      input.caller.runId = 'operator-retry';
      const context = await action('context');
      assert.equal(context.status, 'verified');
      for (let read = 0; read < 2; read++) {
        const selected = await openClawFeedbackInput(
          record,
          input.caller,
          input.request,
          input.config,
        );
        assert.equal(selected?.inputId, 'input');
        assert.equal(selected?.event.id, event.id);
      }
      assert.equal(event.turn!.runId, originalRun);
      assert.equal(event.turn!.executionRunId, execution === 'delivery' ? undefined : executionRun);
      assert.equal(record.feedback!.context?.runId, 'operator-retry');
      assert.equal(sends, 1);
      assert.equal(writes, 0);
    });
  it('should select an exact delivered source when several comments are available', async () => {
    await advanceFeedbackTurn(input);
    const second = structuredClone(event);
    second.id = 'd'.repeat(64);
    second.turn = { runId: 'second-delivery', message: 'second comment', status: 'accepted' };
    record.feedback!.events.push(second);
    messages.push({
      role: 'user',
      content: 'second comment',
      __openclaw: {
        id: 'second-input',
        idempotencyKey: 'second-delivery:user',
      },
    });
    input.caller.runId = 'queued-execution';
    assert.equal(
      await openClawFeedbackInput(record, input.caller, input.request, input.config),
      undefined,
    );
    const selected = await openClawFeedbackInput(
      record,
      input.caller,
      input.request,
      input.config,
      second.id,
    );
    assert.equal(selected?.event.id, second.id);
    assert.equal(selected?.inputId, 'second-input');
    assert.equal(record.feedback!.context, undefined);
    await action('context');
    assert.equal(
      (await openClawFeedbackInput(record, input.caller, input.request, input.config))?.event.id,
      event.id,
    );
  });
  for (const change of ['key', 'body', 'session', 'cancelled', 'receipt', 'pending'])
    it(`should refuse queued feedback with conflicting ${change}`, async () => {
      await advanceFeedbackTurn(input);
      const meta = messages[0]!.__openclaw as Record<string, unknown>;
      input.caller.runId = 'queued-execution';
      if (change === 'key') meta.idempotencyKey = 'different:user';
      if (change === 'body') messages[0]!.content = 'a different comment';
      if (change === 'session') input.caller.sessionId = 'replacement-session';
      if (change === 'cancelled') event.turn!.cancelled = true;
      if (change === 'receipt' || change === 'pending') {
        const request = input.request;
        input.request = async (method, params) =>
          method === 'chat.history'
            ? {
                sessionId: 'session',
                messages,
                inputReceipts: [
                  {
                    runId: event.turn!.runId,
                    state: change === 'pending' ? 'pending' : 'consumed',
                    consumedByEventId: 'other-input',
                  },
                ],
              }
            : request(method, params);
      }
      await assert.rejects(
        action('context'),
        /feedback-owner-caller-required|dispatch-turn-input-mismatch|reply-managed-context-invalid|dispatch-turn-delivery-unverified/,
      );
      assert.equal(sends, 1);
      assert.equal(writes, 0);
    });
  it('should reuse native feedback custody for the initial task transition and preserve cancellation', async () => {
    await start();
    const feedback = await openClawFeedbackInput(record, input.caller, input.request, input.config);
    assert.ok(feedback);
    const verified = await verifyOpenClawWork({
      record,
      caller: input.caller,
      operator: false,
      feedback: { inputId: feedback.inputId, message: event.source },
      mode: 'plan',
      now: Date.now(),
      request: input.request,
      config: input.config,
    });
    assert.equal(verified.progression.stage, 'implementation');
    assert.equal(verified.source.inputEventId, feedback.inputId);
    event.turn!.cancelled = true;
    await assert.rejects(
      openClawFeedbackInput(record, input.caller, input.request, input.config),
      /reply-managed-context-invalid/,
    );
  });
  it('should settle consumed native input without waiting for its answer or guessing its execution', async () => {
    const request = input.request;
    input.request = async (method, params) => {
      assert.notEqual(method, 'agent.wait', 'delivery does not wait for the responder');
      return request(method, params);
    };
    assert.equal((await advanceFeedbackTurn(input)).status, 'feedback-completed');
    assert.equal(event.phase, 'delivered');
    assert.equal(event.turn!.status, 'consumed');
    assert.equal(event.turn!.consumedByEventId, 'input');
    assert.equal(event.turn!.executionRunId, undefined);
    assert.equal(event.turn!.replyEventId, undefined);
    assert.equal(record.nativeInactive, false);
    assert.equal(openClawCapacity([record], 1).occupied, 1);
    assert.equal(sends, 1);
    assert.equal(writes, 0);
    input.request = async () => {
      throw new Error('settled delivery needs no further native reads');
    };
    assert.equal((await advanceFeedbackTurn(input)).status, 'feedback-completed');
    assert.equal(sends, 1);
  });
  it('should keep queued native input pending until its exact consumption is verified', async () => {
    const request = input.request;
    input.request = async (method, params) => {
      assert.notEqual(method, 'agent.wait');
      const result = await request(method, params);
      if (method !== 'chat.history' || !event.turn) return result;
      return {
        ...(result as Record<string, unknown>),
        messages: [],
        inputReceipts: [{ runId: event.turn.runId, state: 'pending', queued: true }],
        pendingInputs: { total: 1 },
      };
    };
    assert.equal((await advanceFeedbackTurn(input)).status, 'feedback-pending');
    assert.equal(event.phase, 'running');
    assert.equal(event.turn!.status, 'accepted');
    input.request = request;
    assert.equal((await advanceFeedbackTurn(input)).status, 'feedback-completed');
    assert.equal(event.turn!.status, 'consumed');
    assert.equal(sends, 1);
  });
  for (const failure of ['cancelled', 'session', 'input'] as const)
    it(`should not settle native delivery with ${failure} evidence`, async () => {
      const request = input.request;
      input.request = async (method, params) => {
        const result = await request(method, params);
        if (method !== 'chat.history' || !event.turn) return result;
        return {
          ...(result as Record<string, unknown>),
          ...(failure === 'session' ? { sessionId: 'foreign-session' } : {}),
          ...(failure === 'input'
            ? { messages: messages.map((message) => ({ ...message, content: 'another input' })) }
            : {}),
          ...(failure === 'cancelled'
            ? { inputReceipts: [{ runId: event.turn.runId, state: 'pending', cancelled: true }] }
            : {}),
        };
      };
      await assert.rejects(
        advanceFeedbackTurn(input),
        /dispatch-turn-(cancelled|history-unverified|input-mismatch)/,
      );
      assert.notEqual(event.phase, 'delivered');
      assert.equal(sends, 1);
    });
  it('should settle native delivery independently of private results and public replies', async () => {
    structuredClone(record);
    const context = await start();
    assert.equal(context.status, 'verified');
    assert.equal('resultSchema' in context, false);
    assert.equal(
      'replyTarget' in context && context.replyTarget,
      'https://github.com/owner/repo/issues/3#issuecomment-42',
    );
    event.turn!.status = 'completed';
    busy = false;
    assert.equal((await advanceFeedbackTurn(input)).status, 'feedback-completed');
    await advanceFeedbackTurn(input);
    assert.equal(sends, 1);
    assert.equal(event.phase, 'delivered');
    assert.equal(writes, 0);
  });
  for (const change of [{ model: 'openai/operator-model' }, { thinkingLevel: 'low' }])
    it(`should retain feedback authority after operator ${'model' in change ? 'model' : 'thinking'} tuning`, async () => {
      input.policy.issueAssignment!.mode = 'work';
      await start();
      const original = structuredClone(record.request);
      Object.assign(sessionSettings, change);
      const context = await action('context');
      assert.equal(context.status, 'verified');
      assert.ok('mode' in context && context.mode === 'work');
      assert.deepEqual(record.request, original);
      assert.equal(sends, 1);
      assert.equal(writes, 0);
    });
  for (const mode of ['plan', 'auto'] as const)
    for (const message of ['Why this approach?', 'Keep the smaller approach in the plan.'])
      it(`should retain ${mode} input without implementation for ${message.toLowerCase()}`, async () => {
        input.policy.issueAssignment!.mode = mode;
        source.body = `@receiver ${message}`;
        event.source = JSON.stringify(source);
        event.revision = feedbackRevision(source);
        const context = await start();
        assert.equal(context.status, 'verified');
        assert.equal(record.progression, undefined);
        assert.equal(writes, 0);
      });
  it('should queue on a busy owner and recover a lost send without another input or session', async () => {
    busy = true;
    lost = true;
    await assert.rejects(advanceFeedbackTurn(input), /connection-lost/);
    assert.equal(event.turn?.status, 'attempted');
    lost = false;
    await advanceFeedbackTurn({
      ...input,
      sourcePresentation: undefined,
      authorizeInput: async () => {
        throw new Error('source unavailable after send');
      },
    });
    assert.equal(sends, 1);
    assert.equal(event.turn?.status, 'consumed');
    assert.equal(openClawCapacity([record], 3).occupied, 1);
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
    operator.feedback = { baseline: {}, events: [] };
    const idle = structuredClone(record);
    idle.id = 'e'.repeat(64);
    idle.feedback = { baseline: {}, events: [] };
    idle.nativeInactive = true;
    record.nativeInactive = false;
    operator.nativeInactive = false;
    assert.deepEqual(openClawCapacity([record, operator, idle], 3), { occupied: 2, available: 1 });
    event.phase = 'blocked';
    assert.equal(openClawCapacity([record], 3).occupied, 1);
    event.turn!.inactive = true;
    record.nativeInactive = true;
    assert.deepEqual(openClawCapacity([record, operator, idle], 3), { occupied: 1, available: 2 });
  });
});
