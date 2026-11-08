import feedbackPresentation from '../agent/feedback-presentation.ts';
import openClawFeedbackInput from '../agent/openclaw-feedback-input.ts';
import { verifyOpenClawWork } from '../agent/openclaw-work.ts';
import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import {
  openclawFeedbackSchema,
  type OpenClawFeedbackEvent,
} from '../agent/openclaw-feedback-state.ts';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import openClawFeedback, {
  advanceFeedbackTurn,
  type OpenClawFeedbackAction,
  type OpenClawFeedbackProvider,
} from '../agent/openclaw-feedback.ts';
import OpenClawDispatchStore, {
  type OpenClawDispatchRecord,
} from '../agent/openclaw-dispatch-state.ts';
import { discoverFeedback, feedbackRevision } from '../agent/feedback-source.ts';
import openClawCapacity from '../agent/openclaw-capacity.ts';
import { hasDeliveredImplementation } from '../agent/implementation-delivery.ts';
import workflowStatus from '../agent/workflow-status.ts';
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
  let input: Omit<Parameters<typeof openClawFeedback>[0], 'action'> & {
    sourcePresentation?: string;
  };
  let busy: boolean, lost: boolean, uncertain: boolean, revoked: boolean, skill: boolean;
  let sends: number, writes: number, saves: number, destination: string;
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
    destination = '';
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
    // Retained pre-native events continue through their original publication owner.
    delete event.native;
    input = {
      record,
      event,
      sourcePresentation: feedbackPresentation(event, 'owner/repo'),
      provider,
      policy: fixture.policy,
      workspace: root,
      now: Date.now(),
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
  it('should send only the native quoted comment card without workflow instructions or identifiers', async () => {
    event.native = true;
    await advanceFeedbackTurn(input);
    assert.equal(event.turn!.message, feedbackPresentation(event, 'owner/repo'));
    assert.ok(event.turn!.message.split('\n').every((line) => line.startsWith('>')));
    assert.ok(!event.turn!.message.includes(record.id));
    assert.ok(!event.turn!.message.includes(event.id));
  });
  it('should accept an exact queued comment from its actual native execution', async () => {
    event.native = true;
    await advanceFeedbackTurn(input);
    const deliveryRunId = event.turn!.runId;
    (messages[0]!.__openclaw as Record<string, unknown>).runId = 'queued-execution';
    messages.unshift({ role: 'assistant', content: 'unrelated historical context' });
    input.caller.runId = 'queued-execution';
    const discovered = await openClawFeedbackInput(
      record,
      input.caller,
      input.request,
      input.config,
    );
    assert.equal(discovered?.event.id, event.id);
    assert.equal((await action('context')).status, 'verified');
    const feedback = await openClawFeedbackInput(record, input.caller, input.request, input.config);
    assert.equal(feedback?.event.id, event.id);
    assert.equal(feedback?.inputId, 'input');
    assert.equal(event.turn!.runId, deliveryRunId);
    input.caller.runId = 'unrelated-execution';
    await assert.rejects(action('context'), /feedback-owner-caller-required/);
    assert.equal(sends, 1);
    assert.equal(writes, 0);
  });
  it('should refuse ambiguous queued sources even across native history pages', async () => {
    event.native = true;
    await advanceFeedbackTurn(input);
    const second = structuredClone(event);
    second.id = 'd'.repeat(64);
    second.turn = { runId: 'second-delivery', message: 'second comment', status: 'accepted' };
    record.feedback!.events.push(second);
    (messages[0]!.__openclaw as Record<string, unknown>).runId = 'shared-execution';
    input.caller.runId = 'shared-execution';
    const request = input.request;
    input.request = async (method, params) =>
      method === 'chat.history'
        ? {
            sessionId: 'session',
            messages: params.cursor
              ? [
                  {
                    role: 'user',
                    content: 'second comment',
                    __openclaw: {
                      id: 'second-input',
                      runId: 'shared-execution',
                      idempotencyKey: 'second-delivery:user',
                    },
                  },
                ]
              : messages,
            ...(params.cursor ? {} : { olderCursor: 'older-inputs' }),
          }
        : request(method, params);
    await assert.rejects(
      openClawFeedbackInput(record, input.caller, input.request, input.config),
      /feedback-native-input-ambiguous/,
    );
    assert.equal(sends, 1);
    assert.equal(writes, 0);
  });
  for (const change of ['key', 'body', 'session', 'cancelled', 'receipt', 'legacy'])
    it(`should refuse queued feedback with conflicting ${change}`, async () => {
      event.native = true;
      await advanceFeedbackTurn(input);
      const meta = messages[0]!.__openclaw as Record<string, unknown>;
      meta.runId = 'queued-execution';
      input.caller.runId = 'queued-execution';
      if (change === 'legacy') delete event.native;
      if (change === 'key') meta.idempotencyKey = 'different:user';
      if (change === 'body') messages[0]!.content = 'a different comment';
      if (change === 'session') input.caller.sessionId = 'replacement-session';
      if (change === 'cancelled') event.turn!.cancelled = true;
      if (change === 'receipt') {
        const request = input.request;
        input.request = async (method, params) =>
          method === 'chat.history'
            ? {
                sessionId: 'session',
                messages,
                inputReceipts: [
                  { runId: event.turn!.runId, state: 'consumed', consumedByEventId: 'other-input' },
                ],
              }
            : request(method, params);
      }
      await assert.rejects(
        action('context'),
        /feedback-owner-caller-required|dispatch-turn-input-mismatch/,
      );
      assert.equal(sends, 1);
      assert.equal(writes, 0);
    });
  it('should reuse native feedback custody for the initial task transition and preserve cancellation', async () => {
    event.native = true;
    await start();
    const feedback = await openClawFeedbackInput(record, input.caller, input.request, input.config);
    assert.ok(feedback);
    record.result = {
      outcome: 'plan-ready',
      summary: 'Existing actionable plan.',
      fullAssessment: 'Implement the requested change.',
    } as never;
    record.stageReceipt = {} as never;
    const verified = await verifyOpenClawWork({
      record,
      caller: input.caller,
      operator: false,
      feedback: { inputId: feedback.inputId, message: event.source },
      mode: 'plan',
      now: input.now,
      request: input.request,
      config: input.config,
    });
    assert.equal(verified.progression.stage, 'implementation');
    assert.equal(verified.progression.workOwner, 'issue');
    assert.equal(verified.source.inputEventId, feedback.inputId);
    assert.equal(event.work, undefined);
    event.turn!.cancelled = true;
    await assert.rejects(
      openClawFeedbackInput(record, input.caller, input.request, input.config),
      /reply-managed-context-invalid/,
    );
  });
  it('should settle native delivery independently of private results and public replies', async () => {
    event.native = true;
    const before = structuredClone(record);
    const context = await start();
    assert.equal(context.status, 'verified');
    assert.equal('resultSchema' in context, false);
    assert.equal(
      'replyTarget' in context && context.replyTarget,
      'https://github.com/owner/repo/issues/3#issuecomment-42',
    );
    assert.equal(event.work, undefined);
    assert.equal(event.result, undefined);
    assert.deepEqual(record.result, before.result);
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
      assert.equal((await action('context')).status, 'verified');
      assert.equal(
        (
          await action('implementation-context', {
            decision: { mode: 'work', reasons: ['Bounded revision.'], plan: 'Revise the parser.' },
          })
        ).status,
        'verified',
      );
      assert.deepEqual(record.effective, {
        status: 'verified',
        model: sessionSettings.model,
        effort: sessionSettings.thinkingLevel,
      });
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
        const saved = await action('result', {
          privateText: 'Retained plan response.',
          reply: false,
        });
        assert.equal(saved.status, 'recorded');
        assert.equal(record.progression, undefined);
        assert.equal(event.work, undefined);
        assert.equal(writes, 0);
      });
  for (const operation of ['implementation-context', 'implementation-result'] as const)
    it(`should route legacy ${operation} to native context without creating feedback work`, async () => {
      await start();
      const before = structuredClone(record.result);
      const context = await action(operation);
      assert.equal(context.status, 'verified');
      assert.equal('resultSchema' in context, false);
      assert.equal(event.work, undefined);
      assert.deepEqual(record.result, before);
    });
  async function enableFeedbackWork(firstDelivery = false) {
    record.manifestDigest = 'c'.repeat(64);
    record.progression = { stage: 'implementation', via: 'operator' };
    record.result = {
      version: 1,
      outcome: 'plan-ready',
      summary: 'plan',
      assessment: 'plan',
      plan: 'plan',
      evidence: [],
      progress: { completed: [], remaining: [] },
    };
    record.work = {
      assessmentDigest: 'a'.repeat(64),
      delivery: {
        id: 'b'.repeat(64),
        binding: {
          repositoryId: 'R',
          issueId: 'I_issue',
          threadId: 'issue-chat',
          sessionId: 'session',
          worktree: root,
          branch: 'fix',
          base: 'main',
          head: 'a'.repeat(40),
          authorId: account.nodeId,
          policyDigest: 'c'.repeat(64),
        },
        title: 'fix',
        body: 'fix',
        creationAttempted: true,
        reconciled: true,
        pushedHead: 'a'.repeat(40),
        pullRequest: { pullRequestNodeId: 'PR', pullRequestNumber: 7 },
      },
    };
    if (firstDelivery) {
      delete record.work;
      delete record.handoff;
      input.policy.issueAssignment!.pullRequest = { recipients: [] };
    }
    return start();
  }
  for (const [firstDelivery, lostPush] of [
    [false, false],
    [false, true],
    [true, false],
  ])
    it(`should recover retained feedback delivery with first pr ${firstDelivery} and lost push response ${lostPush}`, async () => {
      await enableFeedbackWork(firstDelivery);
      let remote = firstDelivery ? '' : 'c'.repeat(40),
        pushes = 0,
        creates = 0;
      let lost = lostPush;
      const head = 'd'.repeat(40);
      const delivery = record.work?.delivery;
      if (delivery) {
        delivery.binding.repositoryId = input.intake.repository.nodeId;
        delivery.binding.authorId = account.nodeId;
      }
      const pr = {
        itemNodeId: 'PR',
        number: 7,
        state: 'open',
        baseRef: 'main',
        headRef: 'fix',
        headRepository: 'owner/repo',
        title: 'fix',
        body: 'Closes #3',
      };
      if (delivery) delivery.body = pr.body;
      input.connectDelivery = async () => ({
        git: async (argv) => {
          if (argv[0] === 'branch') return 'fix';
          if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
          if (argv.includes('--show-toplevel')) return root;
          if (argv[0] === 'rev-parse') return head;
          if (argv[0] === 'rev-list') return '2';
          if (argv[0] === 'ls-remote') return remote ? `${remote} refs/heads/fix` : '';
          if (argv[0] === 'merge-base')
            assert.deepEqual(argv, ['merge-base', '--is-ancestor', remote, head]);
          if (argv[0] === 'push') {
            pushes++;
            remote = head;
            if (lost) {
              lost = false;
              throw new Error('push-response-lost');
            }
          }
          return '';
        },
        account: {
          identity: account,
          execute: async (argv) => {
            const endpoint = argv.find((arg) => arg.startsWith('repos/'));
            let data: unknown;
            if (argv.includes('POST')) {
              creates++;
              assert.ok(firstDelivery);
              data = pr;
            } else if (argv.includes('graphql'))
              data = { id: 'PR', closingIssuesReferences: { nodes: [{ id: 'I_issue' }] } };
            else if (endpoint === 'repos/owner/repo/issues/3')
              data = { databaseId: 20, nodeId: 'I_issue', number: 3, title: 'issue' };
            else if (endpoint === 'repos/owner/repo/pulls')
              data = firstDelivery && !creates ? [] : [pr];
            else if (endpoint === 'repos/owner/repo/pulls/7')
              data = {
                nodeId: 'PR',
                repositoryId: input.intake.repository.nodeId,
                headRepositoryId: input.intake.repository.nodeId,
                headSha: remote,
                authorId: account.nodeId,
                baseRef: 'main',
                headRef: 'fix',
                state: 'open',
                number: 7,
              };
            else throw new Error('unexpected request: ' + JSON.stringify(argv));
            return {
              exitCode: 0,
              stdout: (argv.includes('--include') ? 'HTTP/2 200\n\n' : '') + JSON.stringify(data),
              stderr: '',
              timedOut: false,
              truncated: false,
            };
          },
        },
      });
      event.work = {
        selection: {
          version: 1,
          requestedSkill: 'agent-system-task-implementation',
          defaultSkill: true,
          observedAt: input.now,
          skill: {
            name: 'agent-system-task-implementation',
            path: join(root, 'SKILL.md'),
            scope: 'user',
            digest: 'f'.repeat(64),
          },
        },
        result: { outcome: 'done', summary: 'Fixed.', fullResult: 'Retained completed repair.' },
        head,
      };
      assert.equal(record.implementationDelivered, undefined);
      const preview = await action('delivery', {
        deliveryOperation: 'prepare',
        title: 'fix',
        body: 'Closes #3',
      });
      assert.ok('digest' in preview);
      if (lostPush) {
        await assert.rejects(
          action('delivery', { deliveryOperation: 'publish', digest: preview.digest }),
          /push-response-lost/u,
        );
        assert.equal(record.work!.delivery!.pushedHead, 'a'.repeat(40));
        assert.equal(record.work!.delivery!.reconciled, true);
        assert.ok(event.workDelivery);
        input.record = record = JSON.parse(JSON.stringify(record));
        input.event = event = record.feedback!.events[0]!;
        const reconciled = await action('delivery', { deliveryOperation: 'reconcile' });
        assert.equal(reconciled.status, 'ready');
        assert.equal(event.workDelivery!.reconciled, true);
        assert.equal(record.work!.delivery!.pushedHead, head);
      }
      const currentPreview = lostPush
        ? await action('delivery', { deliveryOperation: 'prepare' })
        : preview;
      assert.ok('digest' in currentPreview);
      const outcome = await action('delivery', {
        deliveryOperation: 'publish',
        digest: currentPreview.digest,
        title: 'fix',
        body: 'Closes #3',
      });
      assert.equal(outcome.status, 'published');
      assert.equal(record.work!.delivery!.pushedHead, head);
      assert.equal(record.work!.delivery!.pullRequest!.pullRequestNumber, 7);
      assert.equal(record.implementationDelivered, true);
      assert.equal(record.work!.result, undefined);
      assert.equal(event.phase, 'running'); // source-bound feedback reply still has its own owner.
      input.record = record = JSON.parse(JSON.stringify(record));
      input.event = event = record.feedback!.events[0]!;
      assert.equal(record.nativeInactive, false);
      assert.equal(workflowStatus(record), 'active');
      assert.equal(hasDeliveredImplementation(record), true);
      const replay = await action('delivery', { deliveryOperation: 'prepare' });
      assert.ok('digest' in replay);
      await action('delivery', { deliveryOperation: 'publish', digest: replay.digest });
      assert.equal(pushes, 1);
      assert.equal(creates, firstDelivery ? 1 : 0);
      assert.equal((await action('implementation-context')).status, 'verified');
      if (!lostPush) {
        await compose('The repair is pushed; checks are still pending.');
        const retained = structuredClone({ work: event.work, delivery: record.work!.delivery });
        const oldRun = event.turn!.runId;
        const request = input.request;
        input.request = async (method, params) =>
          method === 'agent.wait' && params.runId === oldRun
            ? { runId: oldRun, status: 'error', stopReason: 'aborted' }
            : request(method, params);
        input.operator = true;
        input.caller.runId = 'reply-after-push';
        messages.push({
          role: 'user',
          content: 'Finish the saved reply.',
          __openclaw: {
            id: 'reply-after-push-input',
            idempotencyKey: 'reply-after-push:user',
            senderIsOwner: true,
          },
        });
        assert.equal((await action('context', { resume: true })).status, 'verified');
        const reply = await action('publish');
        assert.ok('digest' in reply);
        assert.equal((await action('publish', { digest: reply.digest })).status, 'published');
        assert.deepEqual({ work: event.work, delivery: record.work!.delivery }, retained);
        assert.equal(pushes, 1);
        assert.equal(creates, firstDelivery ? 1 : 0);
        assert.equal(writes, 1);
      }
      source.body = 'Withdrawn';
      await assert.rejects(
        action('delivery', { deliveryOperation: 'prepare' }),
        /feedback-source-changed/u,
      );
    });
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
  it('should project legacy reply facts without forwarding saved work machinery', async () => {
    await start();
    await action('result', { privateText: 'The fix is ready; hosted checks remain pending.' });
    const selected = await action('compose');
    assert.ok('selection' in selected);
    event.work = {
      selection: selected.selection,
      result: {
        outcome: 'done',
        summary: 'Fixed the handler.',
        fullResult: 'Saved transcript. '.repeat(2000),
      },
      head: 'b'.repeat(40),
      pullRequest: { pullRequestNodeId: 'PR_update', pullRequestNumber: 7 },
    };
    const before = structuredClone(event.work);
    const composed = await action('compose');
    assert.ok('verifiedOutcome' in composed && 'privateResponse' in composed);
    assert.deepEqual(composed.verifiedOutcome, {
      implementation: { outcome: 'done', summary: 'Fixed the handler.' },
      head: before.head,
      delivery: before.pullRequest,
    });
    assert.equal(composed.privateResponse, 'The fix is ready; hosted checks remain pending.');
    assert.deepEqual(event.work, before);
    assert.equal(writes, 0);
  });
  it('should retain a completed legacy input without replaying work for its missing reply', async () => {
    await start();
    await action('result', { privateText: 'Retained answer.' });
    const oldRun = event.turn!.runId;
    event.turn!.status = 'completed';
    busy = false;
    assert.equal((await advanceFeedbackTurn(input)).status, 'feedback-completed');
    assert.equal(event.phase, 'delivered');
    assert.equal(event.result!.privateText, 'Retained answer.');
    await advanceFeedbackTurn(input);
    assert.equal(event.turn!.runId, oldRun);
    assert.equal(sends, 1);
    assert.equal(writes, 0);
  });
  it('should finish a retained reply after a manual stop and explicit owner follow-up', async () => {
    await start();
    await compose('The repair is pushed; checks are still pending.');
    const oldRun = event.turn!.runId;
    const request = input.request;
    busy = false;
    input.request = async (method, params) =>
      method === 'agent.wait' && params.runId === oldRun
        ? { runId: oldRun, status: 'error', stopReason: 'aborted' }
        : request(method, params);
    await assert.rejects(advanceFeedbackTurn(input), /dispatch-turn-cancelled/);
    assert.equal(event.turn!.cancelled, true);
    assert.equal(sends, 1);
    input.caller.runId = 'operator-resume';
    messages.push({
      role: 'user',
      content: 'Finish the saved feedback reply; the repair is already pushed.',
      __openclaw: {
        id: 'resume-input',
        idempotencyKey: 'operator-resume:user',
        senderIsOwner: true,
      },
    });
    busy = true;
    await assert.rejects(action('context'), /feedback-owner-caller-required/);
    input.operator = true;
    assert.equal((await action('context', { resume: true })).status, 'verified');
    assert.equal(
      event.result!.privateText,
      'Full private evidence, implications, uncertainty, and answer.',
    );
    const preview = await action('publish');
    assert.ok('digest' in preview);
    assert.equal((await action('publish', { digest: preview.digest })).status, 'published');
    assert.equal(writes, 1);
    assert.equal(sends, 1);
    assert.equal(event.ownerResumptions![0]!.previousTurn.cancelled, true);
    record.phase = 'creating';
    record.context = '{}';
    record.routing = '{}';
    record.routingNote = 'Retained fixture routing.';
    record.effective = { status: 'verified', model: 'openai/test', effort: 'high' };
    const journal = new OpenClawDispatchStore(root, 'd'.repeat(64));
    await journal.exclusive(async (state, save) => {
      state.records = [structuredClone(record)];
      await save();
    });
    assert.equal(
      (await journal.read()).records[0]!.feedback!.events[0]!.turn!.runId,
      'operator-resume',
    );
    input.caller.runId = oldRun;
    await assert.rejects(action('context', { resume: true }), /feedback-resume-unavailable/);
  });
  for (const failure of [
    'nonowner',
    'missing-input',
    'foreign-session',
    'active-handler',
    'denial',
    'changed-source',
  ] as const)
    it(`should preserve stopped feedback when resume has ${failure}`, async () => {
      await start();
      await compose();
      const original = structuredClone(event.turn);
      const oldRun = event.turn!.runId;
      const request = input.request;
      input.request = async (method, params) =>
        method === 'agent.wait' && params.runId === oldRun
          ? {
              runId: oldRun,
              status: failure === 'active-handler' ? 'timeout' : 'error',
              ...(failure === 'denial' ? { code: 'approval-denied' } : { stopReason: 'aborted' }),
            }
          : request(method, params);
      input.operator = failure !== 'nonowner';
      input.caller.runId = 'resume-input';
      if (failure === 'foreign-session') input.caller.sessionId = 'replacement';
      if (failure === 'changed-source') source.body = 'Changed source.';
      if (failure !== 'missing-input')
        messages.push({
          role: 'user',
          content: 'Finish the saved reply.',
          __openclaw: { id: 'new-input', idempotencyKey: 'resume-input:user', senderIsOwner: true },
        });
      await assert.rejects(
        action('context', { resume: true }),
        /feedback-owner|dispatch-operator-input-unverified|feedback-resume-terminal-unverified|feedback-source-changed/,
      );
      assert.deepEqual(event.turn, original);
      assert.equal(event.ownerResumptions, undefined);
      assert.equal(writes, 0);
      assert.equal(sends, 1);
    });
  it('should reconcile an uncertain reply after explicit resume without another write', async () => {
    await start();
    const digest = await compose();
    lost = true;
    await assert.rejects(action('publish', { digest }), /connection-lost/);
    const oldRun = event.turn!.runId;
    const request = input.request;
    input.request = async (method, params) =>
      method === 'agent.wait' && params.runId === oldRun
        ? { runId: oldRun, status: 'error', stopReason: 'aborted' }
        : request(method, params);
    input.operator = true;
    input.caller.runId = 'resume-input';
    messages.push({
      role: 'user',
      content: 'Finish the saved reply.',
      __openclaw: { id: 'new-input', idempotencyKey: 'resume-input:user', senderIsOwner: true },
    });
    assert.equal((await action('context', { resume: true })).status, 'verified');
    lost = false;
    assert.equal((await action('reconcile')).status, 'published');
    assert.equal(writes, 1);
    assert.equal(sends, 1);
  });
  it('should queue on a busy owner and recover a lost send without another input or session', async () => {
    busy = true;
    lost = true;
    await assert.rejects(advanceFeedbackTurn(input), /connection-lost/);
    assert.equal(event.turn?.status, 'attempted');
    lost = false;
    await advanceFeedbackTurn(input);
    assert.equal(sends, 1);
    assert.equal(event.turn?.status, 'consumed');
    assert.equal(openClawCapacity([record], 3).occupied, 1);
  });
  for (const variant of ['default', 'skill', 'inline', 'file', 'skill-inline', 'skill-file']) {
    it(`should compose and publish issue-owned feedback with ${variant} customization`, async () => {
      const guidance = 'Lead with the result.\nKeep the uncertainty visible.';
      await writeFile(join(root, 'reply-guidance.md'), guidance);
      await mkdir(join(root, 'reply'));
      await writeFile(join(root, 'reply', 'SKILL.md'), 'Explain the result to the issue author.');
      customSkills = [
        {
          name: 'custom-reply',
          filePath: join(root, 'reply', 'SKILL.md'),
          source: 'openclaw-workspace',
          eligible: true,
          modelVisible: true,
        },
      ];
      input.policy.issueAssignment!.assessment = { skill: 'missing-assessment' };
      input.policy.issueAssignment!.implementation = { skill: 'missing-implementation' };
      input.policy.issueAssignment!.feedback = {
        inherit: true,
        allowed: [],
        ...(variant.includes('skill') ? { skill: 'custom-reply' } : {}),
        ...(variant.includes('inline')
          ? { guidance }
          : variant.includes('file')
            ? { guidance: { file: 'reply-guidance.md' } }
            : {}),
      };
      await start();
      const privateText = 'Full private evidence.\nTransport remains untested.';
      await action('result', { privateText });
      const composed = await action('compose');
      assert.ok('selection' in composed && composed.selection && 'digest' in composed);
      assert.equal(
        composed.selection.skill.name,
        variant.includes('skill') ? 'custom-reply' : 'agent-system-github-reply',
      );
      assert.equal(
        composed.selection.guidance?.content,
        variant.includes('inline') ? guidance : undefined,
      );
      assert.ok('privateResponse' in composed);
      assert.equal(composed.privateResponse, privateText);
      assert.equal(event.composition?.skill.digest, composed.selection.skill.digest);
      assert.equal(
        event.composition?.guidance?.content,
        /inline|file/u.test(variant) ? guidance : undefined,
      );
      if (variant.includes('file'))
        assert.equal(composed.selection.guidance?.path, event.composition?.guidance?.path);
      const publicText = 'Result: caller fixed. Transport remains untested.';
      await action('candidate', { digest: composed.digest, publicText });
      const preview = await action('publish');
      assert.ok('digest' in preview);
      assert.equal((await action('publish', { digest: preview.digest })).status, 'published');
      assert.equal(destination, 'item:3');
      assert.equal(event.result!.privateText, privateText);
      assert.ok(published!.body.includes(publicText));
      assert.ok(!published!.body.includes(privateText));
      await action('publish', { digest: preview.digest });
      assert.equal(writes, 1);
    });
  }

  for (const invalid of ['missing', 'disabled', 'hidden', 'ineligible', 'ambiguous']) {
    it(`should recover a ${invalid} explicit reply skill without publishing a default`, async () => {
      input.policy.issueAssignment!.feedback = {
        inherit: true,
        allowed: [],
        skill: 'custom-reply',
      };
      const valid = {
        name: 'custom-reply',
        filePath: join(root, 'SKILL.md'),
        source: 'openclaw-workspace',
        eligible: true,
        modelVisible: true,
      };
      customSkills = [{ ...valid }];
      await start();
      await action('result', { privateText: 'Retain the complete answer.' });
      if (invalid === 'missing') customSkills = [];
      if (invalid === 'disabled') customSkills[0]!.disabled = true;
      if (invalid === 'hidden') customSkills[0]!.modelVisible = false;
      if (invalid === 'ineligible') customSkills[0]!.eligible = false;
      if (invalid === 'ambiguous') customSkills.push({ ...valid });
      await assert.rejects(action('compose'), /skill/u);
      assert.equal(event.composition, undefined);
      assert.equal(writes, 0);
      customSkills = [valid];
      const corrected = await action('compose');
      assert.ok('selection' in corrected && corrected.selection);
      assert.equal(corrected.selection.skill.name, 'custom-reply');
      assert.equal(event.result!.privateText, 'Retain the complete answer.');
      assert.equal(sends, 1);
    });
  }

  it('should retain the full private answer and publish one separately composed attributed reply', async () => {
    const context = await start();
    assert.equal(context.status, 'verified');
    const digest = await compose();
    assert.equal(writes, 0);
    const result = await action('publish', { digest });
    assert.equal(result.status, 'published');
    assert.equal(destination, 'item:3');
    assert.match(String(result.presentation), /Full private evidence/);
    assert.match(
      String(result.presentation),
      /\[Reply ↗\]\(https:\/\/github.com\/owner\/repo\/issues\/3#issuecomment-99\) from \[@receiver\]/,
    );
    assert.ok(!String(result.presentation).includes('Reply published'));
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
  for (const changed of ['issue', 'source'])
    it(`should refresh ${changed} authorization before publishing without repeating the issue read`, async () => {
      await start();
      const digest = await compose();
      const issue = intakeFixture().item;
      let checks = 0;
      input.reauthorize = async () => {
        if (++checks === 2) {
          if (changed === 'issue') issue.state = 'closed';
          else source.body = '@receiver changed request';
        }
        return structuredClone(issue);
      };
      provider.getItem = async () => {
        throw new Error('duplicate issue read');
      };
      await assert.rejects(
        action('publish', { digest }),
        changed === 'issue' ? /feedback-source-owner-changed/ : /feedback-source-changed/,
      );
      assert.equal(checks, 2);
      assert.equal(writes, 0);
    });
  it('should reject feedback results from another native run', async () => {
    await start();
    input.caller.runId = 'foreign';
    await assert.rejects(
      action('result', { privateText: 'forged' }),
      /feedback-owner-caller-required/,
    );
    assert.equal(event.result, undefined);
  });
  it('should retain reply authority when unrelated work settings change', async () => {
    await start();
    const digest = await compose();
    input.policy.issueAssignment!.mode = 'work';
    input.policy.issueAssignment!.implementation = { skill: 'custom:implementation' };
    assert.equal((await action('publish', { digest })).status, 'published');
    assert.equal(writes, 1);
  });
  it('should block changed source and explicit revocation while retaining an admitted reply through pause', async () => {
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
    input.policy.issueAssignment!.feedback = { inherit: false, allowed: [] };
    await assert.rejects(action('publish', { digest }), /workflow-policy-held/);
    assert.equal(writes, 0);
    input.policy.issueAssignment!.feedback = { inherit: true, allowed: [actor] };
    input.policy.issueAssignment!.paused = true;
    assert.equal((await action('publish', { digest })).status, 'published');
    assert.equal(writes, 1);
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
    event.phase = 'blocked';
    event.code = 'feedback-composition-changed';
    const refreshed = await action('compose');
    assert.equal(refreshed.status, 'composition-ready');
    assert.ok('digest' in refreshed && refreshed.digest !== selection.digest);
    assert.equal(
      (await action('candidate', { digest: refreshed.digest, publicText: 'Updated reply.' }))
        .status,
      'candidate-recorded',
    );

    assert.equal(writes, 0);
  });
  it('should keep self feedback private', async () => {
    source.author = account;
    event.source = JSON.stringify(source);
    const { feedbackRevision } = await import('../agent/feedback-source.ts');
    event.revision = feedbackRevision(source);
    await start();
    const result = await action('result', { privateText: 'Private answer.' });
    assert.equal('publication' in result && result.publication, 'private-only');
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
    input.reauthorize = async () => intakeFixture().item;
    provider.getItem = async (_owner, _name, number) => {
      assert.equal(number, 4);
      return {
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
      };
    };
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
    delete event.native;
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
