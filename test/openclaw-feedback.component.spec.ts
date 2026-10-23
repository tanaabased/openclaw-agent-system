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
import OpenClawDispatchStore, {
  type OpenClawDispatchRecord,
} from '../agent/openclaw-dispatch-state.ts';
import { discoverFeedback, feedbackRevision } from '../agent/feedback-source.ts';
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
    input = {
      record,
      event,
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
              model: 'openai/test',
              thinkingLevel: 'high',
              label: '#3',
              category: 'repo',
            },
          };
        if (method === 'skills.status')
          return {
            skills: skill
              ? ['agent-system-feedback-reply', 'agent-system-issue-implementation'].map(
                  (name) => ({
                    name,
                    eligible: true,
                    modelVisible: true,
                    source: 'openclaw-plugins',
                    filePath: join(root, 'SKILL.md'),
                  }),
                )
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
  it('should keep plan feedback in planning and preserve an explicit implementation stage', async () => {
    input.policy.issueAssignment!.mode = 'plan';
    await start();
    assert.equal(record.progression, undefined);
    assert.equal(event.work, undefined);
    record.work = {
      assessmentDigest: 'a'.repeat(64),
      implementation: { runId: 'original', inputEventId: 'original' },
    };
    record.progression = { stage: 'implementation', via: 'operator', workOwner: 'issue' };
    const context = await action('implementation-context');
    assert.equal(context.status, 'verified');
    assert.equal((record as OpenClawDispatchRecord).progression?.stage, 'implementation');
  });
  for (const mode of ['plan', 'auto'] as const)
    it(`should enter work from approved direction in ${mode} without an extra decision`, async () => {
      input.policy.issueAssignment!.mode = mode;
      record.result = {
        version: 1,
        outcome: 'plan-ready',
        summary: 'Original',
        assessment: 'Original assessment',
        plan: 'Original plan',
        evidence: [],
        progress: { completed: [], remaining: [] },
        decision: { mode: 'plan', reasons: ['Wait for direction.'] },
      };
      source.body = '@receiver Please implement the agreed plan.';
      event.source = JSON.stringify(source);
      event.revision = feedbackRevision(source);
      const initial = await start();
      assert.equal('mode' in initial && initial.mode, mode);
      const original = structuredClone(record.result);
      const context = await action('implementation-context');
      assert.equal(context.status, 'verified');
      assert.equal(record.progression?.via, 'operator');
      assert.equal(record.progression?.stage, 'implementation');
      assert.equal(event.work!.decision, undefined);
      assert.deepEqual(record.result, original);
      assert.equal((await action('implementation-context')).status, 'verified');
      assert.equal(record.feedback!.events.length, 1);
      assert.equal(input.policy.issueAssignment!.mode, mode);
    });
  it('should use live work policy and retain feedback clarification independently', async () => {
    input.policy.issueAssignment!.mode = 'work';
    const original: NonNullable<OpenClawDispatchRecord['result']> = {
      version: 1,
      outcome: 'plan-ready',
      summary: 'Original',
      assessment: 'Original assessment',
      plan: 'Original plan',
      evidence: [],
      progress: { completed: [], remaining: [] },
    };
    record.result = structuredClone(original);
    await start();
    const decision = {
      mode: 'work' as const,
      reasons: ['Approved revised plan.'],
      plan: 'Use the smaller parser change.',
    };
    await action('implementation-context', { decision });
    const result = {
      outcome: 'clarification-needed',
      summary: 'Need a value.',
      fullResult: 'Partial work is retained.',
      questions: ['Which value?'],
    } as const;
    await action('implementation-result', {
      implementationResult: { ...result, questions: [...result.questions] },
    });
    input.policy.issueAssignment!.mode = 'plan';
    const context = await action('context');
    assert.equal('mode' in context && context.mode, 'work');
    assert.equal((await action('implementation-context')).status, 'finished');
    assert.deepEqual(record.result, original);
    assert.deepEqual(event.work!.result, result);
    await action('result', { privateText: 'Which value?', reply: false });
    source = {
      ...source,
      nodeId: 'answer',
      databaseId: 43,
      body: '@receiver use the smaller value.',
      createdAt: '2026-10-13T01:01:00Z',
      updatedAt: '2026-10-13T01:01:00Z',
    };
    await discoverFeedback({
      state: record.feedback!,
      client: provider,
      policy: input.policy,
      owner: 'owner',
      name: 'repo',
      number: 3,
      nodeId: 'I_issue',
      itemType: 'issue',
      now: input.now + 1000,
    });
    event = record.feedback!.events[1]!;
    input.event = event;
    input.caller.runId = `${record.id}:feedback:${event.id}`;
    busy = false;
    const answerContext = await start();
    assert.ok('previousFeedbackWork' in answerContext && answerContext.previousFeedbackWork);
    assert.deepEqual(answerContext.previousFeedbackWork[0]!.decision, decision);
    assert.deepEqual(answerContext.previousFeedbackWork[0]!.result, result);
    assert.equal(answerContext.previousFeedbackWork[0]!.privateText, 'Which value?');
    const resumed = await action('implementation-context');
    assert.equal(resumed.status, 'verified');
    assert.ok('previousFeedbackWork' in resumed && resumed.previousFeedbackWork);
    assert.deepEqual(resumed.previousFeedbackWork[0]!.result, result);
    assert.deepEqual(resumed.previousFeedbackWork, answerContext.previousFeedbackWork);
  });
  it('should require a reasoned auto decision and retain done work at its exact commit', async () => {
    input.policy.issueAssignment!.mode = 'auto';
    await start();
    await assert.rejects(action('implementation-context'), { reason: 'assessment-not-actionable' });
    const selected = await action('implementation-context', {
      decision: {
        mode: 'work',
        reasons: ['Small requested fix.'],
        plan: 'Implement and test the fix.',
      },
    });
    assert.equal(selected.status, 'verified');
    input.connectDelivery = async () => ({
      account: {} as never,
      git: async (args) => (args[0] === 'status' ? '' : 'c'.repeat(40)),
    });
    const result = { outcome: 'done', summary: 'Fixed.', fullResult: 'Fixed and tested.' } as const;
    await action('implementation-result', { implementationResult: result });
    assert.equal(event.work!.head, 'c'.repeat(40));
    assert.equal(record.progression?.via, 'auto');
    assert.equal((await action('implementation-context')).status, 'finished');
    await assert.rejects(
      action('implementation-result', { implementationResult: { ...result, summary: 'Changed.' } }),
      /feedback-implementation-result-conflict/u,
    );
  });
  async function enableFeedbackWork() {
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
    return start();
  }
  for (const lostPush of [false, true])
    it(`should deliver feedback on the same pr with lost push response ${lostPush}`, async () => {
      await enableFeedbackWork();
      let remote = 'c'.repeat(40),
        pushes = 0,
        creates = 0;
      let lost = lostPush;
      const head = 'd'.repeat(40);
      const delivery = record.work!.delivery!;
      delivery.binding.repositoryId = input.intake.repository.nodeId;
      delivery.binding.authorId = account.nodeId;
      const pr = {
        itemNodeId: 'PR',
        number: 7,
        state: 'open',
        baseRef: 'main',
        headRef: 'fix',
        headRepository: 'owner/repo',
        title: delivery.title,
        body: 'Closes #3',
      };
      delivery.body = pr.body;
      input.connectDelivery = async () => ({
        git: async (argv) => {
          if (argv[0] === 'branch') return 'fix';
          if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
          if (argv.includes('--show-toplevel')) return root;
          if (argv[0] === 'rev-parse') return head;
          if (argv[0] === 'rev-list') return '2';
          if (argv[0] === 'ls-remote') return `${remote} refs/heads/fix`;
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
              throw new Error('must not create');
            }
            if (argv.includes('graphql'))
              data = { id: 'PR', closingIssuesReferences: { nodes: [{ id: 'I_issue' }] } };
            else if (endpoint === 'repos/owner/repo/issues/3')
              data = { databaseId: 20, nodeId: 'I_issue', number: 3, title: 'issue' };
            else if (endpoint === 'repos/owner/repo/pulls') data = [pr];
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
            else throw new Error('unexpected request');
            return {
              exitCode: 0,
              stdout: JSON.stringify(data),
              stderr: '',
              timedOut: false,
              truncated: false,
            };
          },
        },
      });
      await action('implementation-context');
      await action('implementation-result', {
        implementationResult: {
          outcome: 'done',
          summary: 'Fixed.',
          fullResult: 'Regression passed.',
        },
      });
      const preview = await action('delivery', { deliveryOperation: 'prepare' });
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
      });
      assert.equal(outcome.status, 'published');
      assert.equal(record.work!.delivery!.pushedHead, head);
      assert.equal(record.work!.delivery!.pullRequest!.pullRequestNumber, 7);
      const replay = await action('delivery', { deliveryOperation: 'prepare' });
      assert.ok('digest' in replay);
      await action('delivery', { deliveryOperation: 'publish', digest: replay.digest });
      assert.equal(pushes, 1);
      assert.equal(creates, 0);
      assert.equal((await action('implementation-context')).status, 'finished');
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
        assert.equal(creates, 0);
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
  it('should resume interrupted composition with saved work and a distinct native request', async () => {
    // Exercise the durable dispatch journal, not only the embedded feedback schema.
    record.phase = 'creating';
    record.context = '{}';
    record.routing = '{}';
    record.routingNote = 'Retained fixture routing.';
    record.effective = { status: 'verified', model: 'openai/test', effort: 'high' };
    const journal = new OpenClawDispatchStore(root, 'd'.repeat(64));
    const originalSave = input.save;
    input.save = async () => {
      await originalSave();
      await journal.exclusive(async (state, save) => {
        state.records = [structuredClone(record)];
        await save();
      });
    };
    await start();
    await action('result', { privateText: 'Retained answer.' });
    const oldRun = event.turn!.runId;
    event.turn!.status = 'completed';
    busy = false;
    const resumed = await advanceFeedbackTurn(input);
    assert.equal(resumed.status, 'feedback-queued');
    assert.equal(event.result!.privateText, 'Retained answer.');
    assert.deepEqual(event.previousTurnIds, [oldRun]);
    assert.equal(sends, 1);
    await advanceFeedbackTurn(input);
    assert.notEqual(event.turn!.runId, oldRun);
    assert.equal(sends, 2);
    assert.equal(writes, 0);
    assert.ok(Value.Check(openclawFeedbackSchema, record.feedback));
    const restored = (await new OpenClawDispatchStore(root, 'd'.repeat(64)).read()).records[0]!;
    assert.equal(restored.feedback!.events[0]!.turn!.runId, oldRun + ':resume:1');
    const mismatched = structuredClone(restored);
    mismatched.feedback!.events[0]!.previousTurnIds = ['unrelated-native-turn'];
    assert.equal(journal.contract.validRecord(mismatched), false);
    await advanceFeedbackTurn(input);
    assert.equal(sends, 2);
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
