import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import codexDirectInput from '../agent/codex-direct-input.ts';
import { runCodexIntake } from '../agent/codex-intake.ts';
import codexLiveTurn from '../agent/codex-live-turn.ts';
import { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import runCodexDelivery from '../agent/tasks/delivery/codex-delivery.ts';
import reconcileCodexLifecycle from '../agent/tasks/dispatch/codex-assignment-lifecycle.ts';
import { codexItemOccupied } from '../agent/tasks/dispatch/codex-capacity.ts';
import { codexWorkObservationHandoff } from '../agent/tasks/dispatch/codex-dispatch-handoff.ts';
import CodexDispatchStore from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import runCodexFeedback from '../agent/tasks/feedback/codex-feedback.ts';
import { feedbackRevision } from '../agent/tasks/feedback/feedback-source.ts';
import codexContinuationNative from '../agent/tasks/implementation/codex-continuation-native.ts';
import runCodexContinuation from '../agent/tasks/implementation/codex-continuation.ts';
import codexImplementationEntry from '../agent/tasks/implementation/codex-implementation-entry.ts';
import workflowStatus from '../agent/tasks/workflow-status.ts';
import codexDispatchFixture from './codex-dispatch-fixture.ts';
import { fixturePullRequest, removeFixtureAssignment } from './github-intake-fixture.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

describe('agent/codex task-continuation', () => {
  const fixtureState = codexDispatchFixture();
  it('should show the original checkout and effective base through the codex assessment adapter', async () => {
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({ ...fixtureState.manifest, debug: true }),
    );
    await fixtureState.prepare();
    fixtureState.created();
    fixtureState.fixture.repository.defaultBranch = 'release';
    const child = { threadId: 'issue-thread' };
    const known = await fixtureState.renderAssessment(fixtureState.result, child);
    assert.match(
      String(known.presentation),
      new RegExp(`${fixtureState.commit} \\(origin/main\\)`),
    );
    assert.match(String(known.presentation), /PR base.*`release`/);
    const failed = await fixtureState.renderAssessment(fixtureState.result, {
      ...child,
      connect: async () => {
        throw Error('optional metadata unavailable');
      },
    });
    assert.match(String(failed.presentation), new RegExp(fixtureState.commit));
    assert.match(String(failed.presentation), /PR base.*`unknown`/);
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({ ...fixtureState.manifest, debug: false }),
    );
    const hidden = await fixtureState.renderAssessment(fixtureState.result, {
      ...child,
      connect: async () => {
        assert.fail('debug off must not connect');
      },
    });
    assert.doesNotMatch(String(hidden.presentation), /Checkout starting point|PR base/);
  });

  it('should keep revised plans and questions inside the issue while releasing its slot', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: 'issue-thread' },
    });
    await fixtureState.next();
    await fixtureState.report();
    const child = { threadId: 'issue-thread' };
    await fixtureState.renderAssessment(fixtureState.result, child);
    fixtureState.now += 300001;
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    await fixtureState.renderAssessment(
      {
        outcome: 'clarification-needed',
        summary: 'Decide retention.',
        questions: ['How long?'],
      },
      child,
    );
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnEnded = true;
    await fixtureState.next();
    const output = await fixtureState.report();
    assert.match(String(output.response), /DONT_NOTIFY/);
    assert.match(String(output.response), /Slots:\*\* 0\/2/);
    assert.doesNotMatch(
      String(output.response),
      /How long|Plan ready|Decide retention|clarification/i,
    );
  });

  it('should enter issue work from a verified native answer to the original clarification', async () => {
    const question = {
      outcome: 'clarification-needed',
      summary: 'Choose approach.',
      questions: ['Which approach?'],
    };
    const work = await fixtureState.workIssue(
      question,
      'Follow the answer.',
      'company:implement',
      'plan',
    );
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    assert.equal((await work.run('next')).status, 'reconciled');
    const source = {
      nodeId: 'C_answer',
      databaseId: 42,
      author: fixtureState.fixture.client.identity,
      body: '@receiver Use the smaller approach and implement it.',
      bodyTruncated: false,
      createdAt: '2026-10-13T01:00:00Z',
      updatedAt: '2026-10-13T01:00:00Z',
    };
    work.receive();
    const attempt = {
      id: 'f'.repeat(64),
      sourceThreadId: 'intake-thread',
      sourceTurnId: 'scan',
      beforeTurnId: 'assessment',
      turnId: fixtureState.native!.turnId!,
      request: { threadId: fixtureState.native!.id, prompt: 'Verified feedback input.' },
    };
    const provider = await fixtureState.deps.feedbackConnect!(
      fixtureState.workspace,
      AbortSignal.timeout(10000),
    );
    provider.comments.getIssueComment = async () => source;
    work.continuation.feedbackConnect = async () => provider;
    await store.exclusive(async (state, save) => {
      state.records[0]!.feedback = {
        baseline: {},
        events: [
          {
            id: 'e'.repeat(64),
            sourceId: source.nodeId,
            nodeId: fixtureState.fixture.item.nodeId,
            number: 3,
            itemType: 'issue',
            source: JSON.stringify(source),
            revision: feedbackRevision(source),
            createdAt: fixtureState.now,
            phase: 'running',
            attempt,
          },
        ],
      };
      await save();
    });
    const context = await work.run('context', {}, true);
    assert.equal(context.status, 'verified', JSON.stringify(context));
    const retained = (await store.read()).records[0]!;
    assert.equal(retained.progression?.via, 'operator');
  });

  it('should inspect operational facts without replaying retained plans or prompts', async () => {
    const work = await fixtureState.workIssue(
      fixtureState.result,
      'Historical implementation guidance.',
    );
    work.receive();
    await work.run('context', {}, true);
    const store = await fixtureState.workStore();
    const before = await store.read();
    const inspection = await fixtureState.request('inspect');
    const record = (inspection.records as Array<Record<string, unknown>>)[0]!;
    assert.equal(record.id, work.id);
    assert.equal(record.threadId, fixtureState.native!.id);
    assert.equal(record.worktree, before.records[0]!.worktree);
    assert.equal(record.workflowStatus, workflowStatus(before.records[0]!));
    assert.deepEqual(record.progression, before.records[0]!.progression);
    for (const text of ['Historical implementation guidance.', before.records[0]!.request!.prompt])
      assert.equal(JSON.stringify(inspection).includes(text), false, text);
    assert.equal('result' in record, false);
    assert.equal('continuation' in record, false);
    assert.equal('context' in record, false);
    assert.deepEqual(await store.read(), before);
  });

  it('should leave ended conversations to their host without preparing more work', async () => {
    const work = await fixtureState.workIssue(
      null,
      'Follow the conversation.',
      'company:implement',
      'plan',
    );
    const store = await fixtureState.workStore();
    const before = (await store.read()).records[0]!;
    for (const turnStatus of ['completed', 'failed', 'interrupted']) {
      fixtureState.native!.turnStatus = turnStatus;
      fixtureState.native!.turnEnded = true;
      const response = await work.run('next');
      assert.equal(response.status, 'reconciled');
      assert.equal('request' in response, false);
    }
    const after = (await store.read()).records[0]!;
    assert.deepEqual(after.request, before.request);
    assert.equal(after.progression, undefined);
  });

  it('should return native continuation guidance to an unrelated verified operator without releasing effects', async () => {
    const work = await fixtureState.workIssue();
    await work.run('context', {}, true);
    const store = await fixtureState.workStore();
    await store.exclusive(async (state, save) => {
      state.records.push({
        ...structuredClone(state.records[0]!),
        id: 'b'.repeat(64),
        issueKey: 'c'.repeat(64),
        intakeId: 'c'.repeat(64),
        threadId: 'operator',
      });
      state.records[0]!.denial = {
        sourceThreadId: 'intake-thread',
        turnId: 'denied',
        callId: 'denied',
        operation: 'prepare',
        automatic: true,
        observedAt: fixtureState.now,
      };
      await save();
    });
    const before = await store.read();
    const operatorInput = work.continuation.native!.operatorInput;
    for (const action of ['retry', 'retry-denied']) {
      await assert.rejects(work.run(action, {}, true), /continuation-operator-caller-required/);
      work.continuation.native!.operatorInput = async () => {
        throw new Error('reply-native-user-input-required');
      };
      await assert.rejects(work.run(action, {}, 'operator'), /reply-native-user-input-required/);
      work.continuation.native!.operatorInput = operatorInput;
      const response = await work.run(action, {}, 'operator');
      assert.equal(response.status, 'native');
      assert.ok('threadId' in response);
      assert.equal(response.threadId, before.records[0]!.threadId);
      assert.deepEqual((await store.read()).records, before.records);
    }
  });

  for (const mode of ['work', 'auto'] as const)
    it(`should enter ${mode} in the initial native turn without recording an assessment`, async () => {
      const work = await fixtureState.workIssue(
        null,
        'Use the current conversation.',
        'company:implement',
        mode,
      );
      fixtureState.native!.status = 'active';
      fixtureState.native!.turnStatus = 'inProgress';
      fixtureState.native!.turnEnded = false;
      const decision =
        mode === 'auto' ? { mode: 'work', reasons: ['Requirements are clear.'] } : undefined;
      const assessmentContext = await fixtureState.request(
        'context',
        { id: work.id },
        { threadId: fixtureState.native!.id },
      );
      assert.deepEqual(assessmentContext.continuationRequest, {
        action: 'context',
        id: work.id,
      });
      const context = await runCodexContinuation(
        fixtureState.pluginData,
        {
          ...(assessmentContext.continuationRequest as object),
          ...(decision ? { decision } : {}),
        },
        { ...work.continuation, threadId: fixtureState.native!.id },
      );
      assert.equal(context.status, 'verified', JSON.stringify(context));
      assert.ok('continuationRequest' in context);
      assert.ok('deliveryPrepareRequest' in context);
      assert.deepEqual(context.deliveryPrepareRequest, { action: 'prepare', id: work.id });
      const delivery = await runCodexDelivery(
        fixtureState.pluginData,
        { ...context.deliveryPrepareRequest, title: 'One poem', body: 'The completed poem.' },
        {
          codexHome: fixtureState.codexHome,
          threadId: fixtureState.native!.id,
          native: fixtureState.deps.native,
          git: (cwd, argv, signal) =>
            argv[0] === 'rev-list'
              ? Promise.resolve('1')
              : fixtureState.deps.git!(cwd, argv, signal),
          connect: async () => ({
            client: await fixtureState.deps.connect!(
              fixtureState.workspace,
              new AbortController().signal,
            ),
            account: {
              identity: fixtureState.fixture.client.identity,
              execute: async () => {
                throw new Error('preparation must not publish');
              },
            },
          }),
        },
      );
      assert.equal(delivery.status, 'prepared');
      assert.ok('publishRequest' in delivery && delivery.publishRequest);
      assert.equal('id' in delivery.publishRequest, false);
      assert.ok(!fixtureState.gitCalls.some((argv) => argv.includes('push')));
      const resumed = await runCodexContinuation(
        fixtureState.pluginData,
        context.continuationRequest,
        {
          ...work.continuation,
          threadId: fixtureState.native!.id,
        },
      );
      assert.equal(resumed.status, 'verified', JSON.stringify(resumed));
      const record = (await (await fixtureState.workStore()).read()).records[0]!;
      assert.equal(record.progression?.via, mode);
      assert.deepEqual(record.implementationDecision, decision);
      const restored = await hydrateImplementation(context, async (read) =>
        work.run('context', read, true),
      );
      const review = restored.initialReview as {
        decision: unknown;
        presentationRequest: { target: string; cards?: string[] };
      };
      assert.ok(review);
      assert.deepEqual(review.decision, decision);
      assert.equal(review.presentationRequest.target, 'https://github.com/owner/repo/issues/3');
      assert.equal(review.presentationRequest.cards, undefined);
      assert.equal((await work.run('next')).status, 'reconciled');
    });

  for (const mode of ['work', 'auto', 'plan'] as const)
    it(`should resume managed ${mode} through implementation entry without promoting delegated input`, async () => {
      const work = await fixtureState.workIssue(
        null,
        'Continue the authorized task.',
        'company:implement',
        mode,
      );
      const store = await fixtureState.workStore();
      const original = (await store.read()).records[0]!;
      const assessmentContext = await fixtureState.request(
        'context',
        { id: work.id },
        { threadId: fixtureState.native!.id },
      );
      // Startup ended before implementation; compaction is followed by a native resume send.
      work.receive();
      fixtureState.native!.turnId = 'post-compaction-turn';
      fixtureState.native!.followUpUserTurn = true;
      let items: Record<string, unknown>[] = [
        { type: 'userMessage', id: 'earlier-user', content: 'Earlier conversation.' },
        {
          type: 'functionCallOutput',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          id: 'resume',
          output: 'Continue.',
        },
      ];
      const readNative = async (method: string) => {
        if (method === 'thread/read') return { thread: { id: fixtureState.native!.id } };
        if (method === 'thread/turns/list')
          return { data: [{ id: fixtureState.native!.turnId, status: 'inProgress' }] };
        if (method === 'thread/items/list')
          return { data: items.map((item) => ({ turnId: fixtureState.native!.turnId, item })) };
        throw new Error('unexpected native method: ' + method);
      };
      work.continuation.native!.operatorInput = (threadId) =>
        codexDirectInput(readNative, threadId);
      work.continuation.continuationNative = codexContinuationNative(readNative);
      const enter = (scope?: 'local' | 'pull-request') =>
        fixtureState.request(
          'implementation',
          {
            operation: 'context',
            target: 'https://github.com/owner/repo/issues/3',
            path: (assessmentContext.project as { path: string }).path,
            scope,
          },
          { ...work.continuation, threadId: fixtureState.native!.id },
        );
      if (mode === 'plan') {
        await assert.rejects(enter(), /continuation-managed-issue-required/);
        assert.equal((await store.read()).records[0]!.progression, undefined);
        assert.equal((await store.read()).records[0]!.issueBranch, undefined);
        return;
      }
      const initial = await enter();
      if (mode === 'work') {
        assert.equal(initial.status, 'verified', JSON.stringify(initial));
        assert.equal((await store.read()).records[0]!.progression?.via, 'work');
      } else {
        assert.equal(initial.status, 'policy-held', JSON.stringify(initial));
        assert.equal(initial.reason, 'auto-decision-required');
        assert.equal((await store.read()).records[0]!.progression, undefined);
        const decided = await runCodexContinuation(
          fixtureState.pluginData,
          {
            ...(initial.continuationRequest as object),
            decision: { mode: 'work', reasons: ['Bounded requested change.'] },
          },
          { ...work.continuation, threadId: fixtureState.native!.id },
        );
        assert.equal(decided.status, 'verified', JSON.stringify(decided));
      }
      const entered = (await store.read()).records[0]!;
      const config = JSON.parse(await readFile(join(fixtureState.workspace, 'agent.yaml'), 'utf8'));
      config.github['issue-assignment'].mode = 'plan';
      await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(config));
      fixtureState.native!.turnId = 'second-resume';
      assert.equal((await enter('pull-request')).status, 'verified');
      const resumed = (await store.read()).records[0]!;
      assert.deepEqual(resumed.progression, entered.progression);
      assert.deepEqual(resumed.request, original.request);
      assert.deepEqual(resumed.issueBranch, entered.issueBranch);
      assert.equal(resumed.threadId, original.threadId);
      assert.equal(resumed.worktree, original.worktree);
      await store.exclusive(async (state, save) => {
        (state.records[0]!.nativeWork ?? state.records[0]!.nativeWork)!.scope = 'local';
        await save();
      });
      await assert.rejects(enter('pull-request'), /reply-native-user-input-required/);
      assert.equal((await enter()).publicationAuthorized, false);
      items.push({
        type: 'mcpToolCall',
        status: 'failed',
        error: { message: 'user rejected MCP tool call' },
      });
      await assert.rejects(enter(), /reply-native-approval-denied/);
      items = items.slice(0, -1);
      await store.exclusive(async (state, save) => {
        const current = state.records[0]!;
        if (current.nativeWork) current.nativeWork.cancelled = true;
        else current.nativeWork!.cancelled = true;
        await save();
      });
      assert.equal((await enter()).reason, 'implementation-cancelled');
    });

  it('should wait for an auto decision in the same conversation without creating another turn', async () => {
    const work = await fixtureState.workIssue(
      null,
      'Assess the request.',
      'company:implement',
      'auto',
    );
    fixtureState.native!.status = 'active';
    fixtureState.native!.turnStatus = 'inProgress';
    fixtureState.native!.turnEnded = false;
    assert.equal((await work.run('context', {}, true)).status, 'policy-held');
    assert.equal(
      (
        await work.run(
          'context',
          { decision: { mode: 'plan', reasons: ['Need an answer.'] } },
          true,
        )
      ).status,
      'policy-held',
    );
    assert.equal((await work.run('next')).status, 'reconciled');
    assert.equal(
      (
        await work.run(
          'context',
          { decision: { mode: 'work', reasons: ['The answer resolves the question.'] } },
          true,
        )
      ).status,
      'verified',
    );
  });

  for (const setting of ['model', 'effort'] as const)
    it(`should preserve the native ${setting} selection and original creation receipt`, async () => {
      const work = await fixtureState.workIssue();
      const store = await fixtureState.workStore();
      const before = (await store.read()).records[0]!;
      work.receive();
      fixtureState.native![setting] = setting === 'model' ? 'gpt-6-luna' : 'low';
      assert.equal((await work.run('context', {}, true)).status, 'verified');
      const after = (await store.read()).records[0]!;
      assert.deepEqual(after.request, before.request);
      assert.equal(after.routing, before.routing);
      assert.deepEqual(after.effective, {
        status: 'verified',
        model: fixtureState.native!.model,
        effort: fixtureState.native!.effort,
      });
    });

  it('should reconsider an existing codex routing failure without reset or reassignment', async () => {
    const selected = await fixtureState.next();
    const store = await fixtureState.workStore();
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.blocker = 'model-routing-not-configured';
      delete record.retry;
      delete record.retryAfter;
      await save();
    });
    const resumed = await fixtureState.next();
    assert.equal(resumed.status, 'routing-required');
    assert.equal(resumed.id, selected.id);
    assert.equal((await store.read()).records.length, 1);
  });

  it('should dispatch an independent codex assignment beside a damaged record', async () => {
    const selected = await fixtureState.next();
    const store = await fixtureState.workStore();
    const raw = await store.read();
    const damaged = {
      ...raw.records[0]!,
      id: 'd'.repeat(64),
      intakeId: 'd'.repeat(64),
      issueKey: 'e'.repeat(64),
      threadId: 'damaged-chat',
      worktree: '/damaged',
      createdAt: 'invalid',
      routingNote: 'unused',
    };
    await store.file.write(JSON.stringify({ ...raw, records: [...raw.records, damaged] }));
    const prepared = await fixtureState.request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'independent task',
      assessment: { complexity: 'medium', reason: 'bounded work' },
    });
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    const saved = JSON.parse(await readFile(store.path, 'utf8'));
    assert.deepEqual(saved.records[1], damaged);
    assert.equal(saved.isolatedRecords, undefined);
  });

  it('should read and advance a healthy codex task beside a malformed slim record', async () => {
    const work = await fixtureState.workIssue(null);
    work.receive();
    const store = await fixtureState.workStore();
    const raw = await store.read();
    const damaged = {
      id: 'd'.repeat(64),
      intakeId: 'd'.repeat(64),
      issueKey: 'e'.repeat(64),
      sourceThreadId: 'other-coordinator',
      threadId: 'damaged-chat',
      createdAt: 1,
      manifestDigest: 'other',
      delivery: {
        id: 'c'.repeat(64),
        binding: {
          repositoryId: 'repository',
          issueId: 'damaged-issue',
          threadId: 'damaged-chat',
          worktree: '/damaged',
          branch: 'damaged-branch',
          base: 'main',
          head: 'f'.repeat(40),
          authorId: 'author',
        },
        creationAttempted: true,
        reconciled: false,
        title: 42,
        pendingPush: { previousHead: '', head: 'f'.repeat(40) },
      },
    };
    const third = {
      id: 'f'.repeat(64),
      intakeId: 'f'.repeat(64),
      issueKey: damaged.issueKey,
      sourceThreadId: 'other-coordinator',
      threadId: 'third-chat',
      createdAt: 1,
      manifestDigest: 'other',
    };
    await store.file.write(JSON.stringify({ ...raw, records: [...raw.records, damaged, third] }));
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    const saved = JSON.parse(await readFile(store.path, 'utf8'));
    assert.ok(saved.records[0].progression);
    assert.deepEqual(saved.records.slice(1), [damaged, third]);
    await assert.rejects(store.read(), /dispatch-state-invalid/);
  });

  it('should preserve implementation permission through policy edits without nudging the chat', async () => {
    const work = await fixtureState.workIssue(null);
    work.receive();
    await work.run('context', {}, true);
    const store = await fixtureState.workStore();
    const before = (await store.read()).records[0]!;
    const changed = JSON.parse(await readFile(join(fixtureState.workspace, 'agent.yaml'), 'utf8'));
    Object.assign(changed.github['issue-assignment'], { paused: true, allowed: [], mode: 'plan' });
    await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(changed));
    work.continuation.activation = async () => {
      throw new Error('native work must not require a schedule');
    };
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    const after = (await store.read()).records[0]!;
    assert.deepEqual(after.progression, before.progression);
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.worktree, before.worktree);
  });

  it('should make a live mode change effective on native input without creating a handoff', async () => {
    const work = await fixtureState.workIssue(
      null,
      'Current instructions.',
      'company:implement',
      'plan',
    );
    const changed = JSON.parse(await readFile(join(fixtureState.workspace, 'agent.yaml'), 'utf8'));
    changed.github['issue-assignment'].mode = 'work';
    await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(changed));
    assert.equal((await work.run('next')).status, 'reconciled');
    assert.equal(
      (await (await fixtureState.workStore()).read()).records[0]!.progression,
      undefined,
    );
    work.receive();
    assert.equal((await work.run('context', {}, true)).status, 'verified');
  });

  it('should preserve a current native denial without manufacturing a retry or clearing history', async () => {
    const work = await fixtureState.workIssue();
    work.receive();
    await work.run('context', {}, true);
    const store = await fixtureState.workStore();
    const before = (await store.read()).records[0]!;
    work.continuation.continuationNative = async () => ({
      status: 'blocked',
      code: 'continuation-native-approval-denied',
    });
    const stopped = await work.run('context', {}, true);
    assert.equal(stopped.status, 'unresolved');
    assert.equal('code' in stopped && stopped.code, 'continuation-native-approval-denied');
    assert.equal((await work.run('next')).status, 'reconciled');
    const after = (await store.read()).records[0]!;
    assert.deepEqual(after.progression, before.progression);
  });

  for (const mode of ['work', 'auto'] as const)
    it(`should admit and assess ${mode} before resolving unavailable implementation dependencies`, async () => {
      const select = fixtureState.deps.native!.assessmentSkill;
      fixtureState.deps.native!.assessmentSkill = async (cwd, id) => {
        if (id === 'company:implement') throw new Error('workflow-stage-skill-unavailable');
        return select(cwd, id);
      };
      const work = await fixtureState.workIssue(
        {
          ...fixtureState.result,
          ...(mode === 'auto' ? { decision: { mode: 'work', reasons: ['Bounded task.'] } } : {}),
        },
        'Follow the plan.',
        'company:implement',
        mode,
      );
      assert.ok(fixtureState.native!.id);
      const state = await (await fixtureState.workStore()).read();
      assert.equal(state.records[0]!.nativeWork, undefined);
      work.receive();
      const direction =
        mode === 'auto' ? { decision: { mode: 'work', reasons: ['Bounded task.'] } } : {};
      await assert.rejects(work.run('context', direction, true), /skill-unavailable/);
      fixtureState.deps.native!.assessmentSkill = select;
      assert.equal((await work.run('context', direction, true)).status, 'verified');
    });

  it('should resolve the current implementation skill and surface an unavailable selection', async () => {
    const work = await fixtureState.workIssue();
    work.receive();
    const select = work.continuation.native!.assessmentSkill;
    work.continuation.native!.assessmentSkill = async () => {
      throw new Error('workflow-stage-skill-unavailable');
    };
    await assert.rejects(work.run('context', {}, true), /skill-unavailable/);
    work.continuation.native!.assessmentSkill = async (cwd, id) => ({
      ...(await select(cwd, id)),
      path: '/changed/SKILL.md',
    });
    const context = await work.run('context', {}, true);
    assert.equal(
      'implementation' in context && context.implementation?.skill.path,
      '/changed/SKILL.md',
    );
  });

  for (const scope of ['local', 'pull-request'] as const)
    it(`should route ${scope} input to its issue instead of a historical feedback owner`, async () => {
      await fixtureState.workIssue();
      const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      await store.exclusive(async (state, save) => {
        state.records[0]!.progression = {
          stage: 'implementation',
          via: 'work',
        };
        await save();
      });
      const routed = await codexImplementationEntry(
        fixtureState.pluginData,
        { action: 'implementation', operation: 'context', scope },
        {
          ...fixtureState.deps,
          threadId: fixtureState.native!.id,
          replyConnection: async () => ({
            request: async () => assert.fail('managed work must not fall back to manual entry'),
            close: async () => {},
          }),
        },
      );
      assert.equal(routed.status, 'managed');
      assert.ok('owner' in routed);
      assert.deepEqual(routed.owner, {
        id: (await store.read()).records[0]!.id,
      });
    });

  for (const [mode, isolatedReader] of [
    ['work', false],
    ['work', true],
    ['auto', false],
    ['auto', true],
  ] as const)
    it(`should hand ${mode} directly from assessment to implementation without a coordinator send with isolated reader ${isolatedReader}`, async () => {
      const assessment = {
        ...fixtureState.result,
        reviewSummary:
          'You would see the result immediately. Docs clarify it; tests cover the missing return.',
        ...(mode === 'auto' ? { decision: { mode: 'work' as const, reasons: ['Ready.'] } } : {}),
      };
      const work = await fixtureState.workIssue(
        assessment,
        'Follow the plan.',
        'company:implement',
        mode,
      );
      fixtureState.native!.status = 'active';
      fixtureState.native!.turnStatus = 'inProgress';
      fixtureState.native!.turnEnded = false;
      const turnId = fixtureState.native!.turnId;
      const recorded = await fixtureState.renderAssessment(assessment, {
        threadId: fixtureState.native!.id,
      });
      assert.equal(recorded.status, 'formatted');
      assert.ok(String(recorded.presentation).includes(assessment.reviewSummary));
      if (isolatedReader) {
        fixtureState.native!.status = 'notLoaded';
        fixtureState.native!.turnStatus = 'interrupted';
        fixtureState.native!.turnEnded = false;
        let readReceived = false;
        work.continuation.observeTurn = codexLiveTurn(async (method, input) => {
          if (method === 'thread/turns/list')
            return { data: [{ id: turnId, status: 'interrupted', completedAt: null }] };
          assert.equal(input.turnId, turnId);
          return {
            data: [
              { turnId, item: { id: 'routing-command', type: 'commandExecution' } },
              ...(readReceived
                ? [
                    {
                      turnId,
                      item: {
                        id: 'owner-observation',
                        type: 'mcpToolCall',
                        server: 'codex_app',
                        tool: 'read_thread',
                        status: 'completed',
                        arguments: {
                          threadId: fixtureState.native!.id,
                          turnLimit: 1,
                          includeOutputs: false,
                        },
                        result: {
                          content: [
                            {
                              type: 'text',
                              text: JSON.stringify({
                                schemaVersion: 1,
                                thread: {
                                  id: fixtureState.native!.id,
                                  kind: 'codex',
                                  hostId: 'local',
                                  status: { type: 'active' },
                                },
                                page: { order: 'newest_first' },
                                turns: [{ id: turnId, status: 'inProgress', completedAt: null }],
                              }),
                            },
                          ],
                        },
                      },
                    },
                    {
                      turnId,
                      item: {
                        id: 'sandbox-retry',
                        type: 'commandExecution',
                        status: 'failed',
                        exitCode: 1,
                        output: JSON.stringify({ code: 'codex-host-access-required' }),
                      },
                    },
                  ]
                : []),
            ],
          };
        });
        const pending = await work.run(
          'context',
          assessment.decision ? { decision: assessment.decision } : {},
          true,
        );
        assert.equal(pending.status, 'observation-required', JSON.stringify(pending));
        assert.deepEqual('request' in pending && pending.request, {
          tool: 'read_thread',
          arguments: { threadId: fixtureState.native!.id, turnLimit: 1, includeOutputs: false },
        });
        assert.equal(
          (
            await work.run(
              'context',
              assessment.decision ? { decision: assessment.decision } : {},
              true,
            )
          ).status,
          'observation-required',
        );
        assert.equal((await work.run('next')).status, 'reconciled');
        const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
        const state = await new CodexDispatchStore(
          current.store.location.root,
          current.store.location.scope,
        ).read();
        assert.notEqual(state.records[0]!.progression?.stage, 'implementation');
        const handoff = codexWorkObservationHandoff(pending, {
          argv: [
            '/node',
            '/runtime.js',
            'continuation',
            'context',
            '--plugin-data',
            fixtureState.pluginData,
          ],
          input: {
            action: 'context',
            ...(assessment.decision ? { decision: assessment.decision } : {}),
          },
        }) as { nativeHandoff: string };
        let nativeReads = 0;
        let transitions = 0;
        await runInNewContext(`(async () => { ${handoff.nativeHandoff} })()`, {
          text: () => {},
          tools: {
            mcp__codex_app__read_thread: async (input: unknown) => {
              assert.deepEqual(JSON.parse(JSON.stringify(input)), {
                threadId: fixtureState.native!.id,
                turnLimit: 1,
                includeOutputs: false,
              });
              nativeReads++;
              readReceived = true;
              return { content: [] };
            },
            exec_command: async (input: { cmd: string }) => {
              transitions++;
              const semantic = JSON.parse(input.cmd.split('\n')[1]!);
              assert.deepEqual(semantic, {
                action: 'context',
                ...(assessment.decision ? { decision: assessment.decision } : {}),
              });
              const continued = await work.run('context', semantic, true);
              assert.equal(continued.status, 'verified', JSON.stringify(continued));
              return { exit_code: 0, output: JSON.stringify(continued) };
            },
          },
        });
        assert.equal(nativeReads, 1);
        assert.equal(transitions, 1);
      }
      const verified = await work.run(
        'context',
        assessment.decision ? { decision: assessment.decision } : {},
        true,
      );
      assert.equal(verified.status, 'verified', JSON.stringify(verified));
      assert.equal('assessment' in verified, false);
      assert.equal(
        'implementation' in verified && verified.implementation?.skill.name,
        'company:implement',
      );
      const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      const started = (await store.read()).records[0]!;
      assert.equal(started.progression!.via, mode);
      assert.equal(
        (
          await work.run(
            'context',
            assessment.decision ? { decision: assessment.decision } : {},
            true,
          )
        ).status,
        'verified',
      );
      assert.equal((await work.run('next')).status, 'reconciled');
      const saved = await work.run(
        'result',
        { result: { outcome: 'done', summary: 'Done.', fullResult: 'Validated.' } },
        true,
      );
      assert.equal(saved.status, 'native');
      assert.equal(
        (
          await work.run(
            'context',
            assessment.decision ? { decision: assessment.decision } : {},
            true,
          )
        ).status,
        'verified',
      );
      assert.equal(fixtureState.native!.turnId, turnId);
      fixtureState.native!.status = 'idle';
      fixtureState.native!.turnStatus = 'completed';
      fixtureState.native!.turnEnded = true;
      const recovery = await work.run('next');
      assert.equal(recovery.status, 'reconciled');
      assert.equal('request' in recovery, false);
    });

  for (const resumed of [false, true])
    it(`should publish an assigned ${resumed ? 'resumed question' : 'initial plan'} update without treating delegation as human input`, async () => {
      await writeFile(join(fixtureState.root, 'SKILL.md'), '# status composer');
      const prepared = await fixtureState.prepare();
      fixtureState.created();
      await fixtureState.request('reconcile', {
        id: prepared.id,
        receipt: { threadId: fixtureState.native!.id },
      });
      const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      const before = await store.read();
      const owner = before.records[0]!;
      const escape = (value: string) =>
        value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
      const creation = {
        id: 'creation',
        type: 'functionCallOutput',
        namespace: 'codex_app',
        name: 'create_thread',
        output: `<codex_delegation>\n  <source_thread_id>${escape(owner.sourceThreadId)}</source_thread_id>\n  <input>${escape(owner.request!.prompt)}</input>\n</codex_delegation>`,
      };
      const resume = {
        ...creation,
        id: 'resume',
        name: 'send_message_to_thread',
        output: 'Continue the existing task.',
      };
      const inputItem = resumed ? resume : creation;
      let items: Record<string, unknown>[] = [inputItem];
      const turnId = resumed ? 'post-compaction-turn' : 'first-turn';
      let writes = 0;
      let posted: { nodeId: string; databaseId: number; body: string } | undefined;
      const provider = {
        ...fixtureState.fixture.client,
        getItemContext: async () => {
          throw new Error('unexpected planning read');
        },
        listIssueComments: async () => ({ comments: [], truncated: false }),
        getIssueComment: async () => {
          throw new Error('unexpected source read');
        },
        findOwnIssueComment: async () => posted,
        createIssueComment: async (_o: string, _n: string, _number: number, body: string) => {
          writes++;
          posted = { nodeId: 'C_update', databaseId: 9, body };
          return posted;
        },
        replies: {
          find: async () => undefined,
          create: async () => {
            throw new Error('unexpected inline reply');
          },
        },
      };
      const nativeDeps = {
        ...fixtureState.deps,
        threadId: fixtureState.native!.id,
        replyProvider: async () => provider,
        replyConnection: async () => ({
          close: async () => {},
          request: async (method: string, params: Record<string, unknown>) => {
            if (method === 'thread/read') return { thread: { id: fixtureState.native!.id } };
            if (method === 'thread/turns/list')
              return {
                data: [
                  {
                    id: params.sortDirection === 'asc' ? 'first-turn' : turnId,
                    status: 'inProgress',
                  },
                ],
              };
            if (method === 'thread/items/list')
              return { data: items.map((item) => ({ turnId, item })) };
            if (method === 'skills/list')
              return {
                data: [
                  {
                    cwd: fixtureState.workspace,
                    errors: [],
                    skills: [
                      {
                        name: 'agent-system:agent-system-github-reply',
                        path: join(fixtureState.root, 'SKILL.md'),
                        scope: 'user',
                        enabled: true,
                      },
                    ],
                  },
                ],
              };
            throw new Error('unexpected native method: ' + method);
          },
        }),
      };
      const call = (operation: string, extra: object = {}) =>
        runCodexFeedback(
          fixtureState.pluginData,
          { action: 'reply', operation, ...extra },
          nativeDeps,
        );
      const target = 'https://github.com/owner/repo/issues/3';
      const context = { purpose: 'status-update', target };
      await assert.rejects(
        call('compose', { target, privateText: 'Unscoped reply.' }),
        /reply-native-user-input-required/,
      );
      items = [];
      await assert.rejects(call('context', context), /reply-native-user-input-required/);
      items = [inputItem];
      const find = fixtureState.deps.native!.find;
      fixtureState.deps.native!.find = async () => undefined;
      await assert.rejects(call('context', context), /reply-managed-context-invalid/);
      fixtureState.deps.native!.find = find;
      items.push({
        type: 'mcpToolCall',
        status: 'failed',
        error: { message: 'user rejected MCP tool call' },
      });
      await assert.rejects(call('context', context), /reply-native-approval-denied/);
      items = [inputItem];
      fixtureState.native!.cwd = fixtureState.root;
      assert.equal((await call('context', context)).status, 'status-update-context');
      await assert.rejects(
        call('context', { ...context, target: 'https://github.com/owner/repo/issues/4' }),
        /reply-target-diverged/,
      );
      const read = await call('context', context);
      assert.ok('observation' in read && typeof read.observation === 'string');
      const composed = await call('compose', {
        ...context,
        privateText: resumed ? 'Which poem form and subject?' : 'Use the smaller approach.',
        update: {
          facts: [
            {
              reference: 'first-turn',
              text: resumed ? 'Which poem form and subject?' : 'Use the smaller approach.',
            },
          ],
        },
      });
      assert.equal(composed.status, 'composition-ready');
      assert.ok('target' in composed && composed.target === target);
      const publicText = resumed
        ? 'Which poem form and subject should I use?'
        : 'The plan is to use the smaller approach.';
      const candidate = await call('candidate', { ...context, publicText });
      assert.equal(candidate.status, 'candidate-recorded');
      assert.ok('publication' in candidate && candidate.publication === 'workflow-authorized');
      assert.equal((await call('publish', { ...context, publicText })).status, 'published');
      assert.equal((await call('reconcile', { ...context, publicText })).status, 'published');
      assert.equal(writes, 1);
      assert.deepEqual(await store.read(), before);
    });

  it('should reuse live managed ownership for status updates without restarting assessment or implementation', async () => {
    await writeFile(join(fixtureState.root, 'SKILL.md'), '# status composer');
    await fixtureState.workIssue(
      fixtureState.result,
      'Follow the plan.',
      'company:implement',
      'plan',
    );
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const before = await store.read();
    const provider = {
      ...(await fixtureState.deps.connect!(fixtureState.workspace, AbortSignal.timeout(1000))),
      listIssueComments: async () => ({ comments: [], truncated: false }),
      getIssueComment: async () => {
        throw new Error('unexpected source read');
      },
      findOwnIssueComment: async () => undefined,
      createIssueComment: async () => {
        throw new Error('unexpected publication');
      },
      replies: {
        find: async () => undefined,
        create: async () => {
          throw new Error('unexpected inline reply');
        },
      },
    };
    const nativeDeps = {
      ...fixtureState.deps,
      threadId: fixtureState.native!.id,
      replyProvider: async () => provider,
      replyConnection: async () => ({
        request: async (method: string) => {
          if (method === 'thread/read') return { thread: { id: fixtureState.native!.id } };
          if (method === 'thread/turns/list')
            return { data: [{ id: 'later-operator-turn', status: 'inProgress' }] };
          if (method === 'thread/items/list')
            return {
              data: [
                {
                  turnId: 'later-operator-turn',
                  item: { type: 'userMessage', id: 'operator', content: 'Draft a status update.' },
                },
              ],
            };
          if (method === 'skills/list')
            return {
              data: [
                {
                  cwd: fixtureState.workspace,
                  errors: [],
                  skills: [
                    {
                      name: 'agent-system:agent-system-github-reply',
                      path: join(fixtureState.root, 'SKILL.md'),
                      scope: 'user',
                      enabled: true,
                    },
                  ],
                },
              ],
            };
          throw new Error(`unexpected native method: ${method}`);
        },
        close: async () => {},
      }),
    };
    const target = 'https://github.com/owner/repo/issues/3';
    const read = await runCodexFeedback(
      fixtureState.pluginData,
      { action: 'reply', operation: 'context', purpose: 'status-update', target },
      nativeDeps,
    );
    assert.ok('observation' in read && typeof read.observation === 'string');
    assert.ok('entry' in read && read.entry === 'managed');
    const composed = await runCodexFeedback(
      fixtureState.pluginData,
      {
        action: 'reply',
        operation: 'compose',
        purpose: 'status-update',
        target,
        privateText: 'Retained progress.',
        update: {
          facts: [
            {
              reference: 'operator',
              text: 'Use the smaller approach.',
            },
          ],
        },
      },
      nativeDeps,
    );
    assert.equal(composed.status, 'composition-ready');
    assert.deepEqual(await store.read(), before);
    fixtureState.native!.cwd = fixtureState.root;
    const moved = await runCodexFeedback(
      fixtureState.pluginData,
      { action: 'reply', operation: 'context', purpose: 'status-update', target },
      nativeDeps,
    );
    assert.ok('entry' in moved && moved.entry === 'managed');
    assert.ok('observation' in moved && moved.observation === read.observation);
    assert.deepEqual(await store.read(), before);
  });

  it('should include a github plan revision in direct planning context without entering work', async () => {
    const work = await fixtureState.workIssue(
      fixtureState.result,
      'Follow the plan.',
      'company:implement',
      'plan',
    );
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records[0]!.feedback = {
        baseline: {},
        events: [
          {
            id: 'a'.repeat(64),
            sourceId: 'plan-comment',
            nodeId: 'issue',
            number: 3,
            itemType: 'issue',
            source: '{}',
            revision: 'b'.repeat(64),
            createdAt: 1,
            phase: 'delivered',
          },
        ],
      };
      await save();
    });
    const response = await fixtureState.request(
      'context',
      { id: work.id },
      { threadId: fixtureState.native!.id },
    );
    assert.equal(response.status, 'verified');
    assert.equal(response.feedbackWork, undefined);
    assert.equal((await store.read()).records[0]!.progression, undefined);
  });

  for (const scenario of ['approved', 'unapproved', 'unavailable', 'reassignment'] as const) {
    it(`should retain the codex owner and stage unless removal is approved: ${scenario}`, async () => {
      const work = await fixtureState.workIssue();
      await work.run('next');
      work.receive();
      const before = await work.run('context', {}, true);
      assert.ok('issueStage' in before);
      const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      const original = (await store.read()).records[0]!;
      const event = removeFixtureAssignment(fixtureState.fixture);
      if (scenario === 'unapproved' || scenario === 'reassignment')
        event.actor = { ...event.actor, nodeId: 'U_outsider', login: 'outsider' };
      if (scenario === 'unavailable')
        fixtureState.fixture.client.listAssignmentEvents = async () => {
          throw new Error('provider-unavailable');
        };
      if (scenario === 'approved')
        await assert.rejects(work.run('context', {}, true), /assignment-removed/);
      else {
        const after = await work.run('context', {}, true);
        assert.equal(after.status, 'verified');
        assert.ok('assignmentObservation' in after && after.assignmentObservation?.missing);
        assert.ok('issueStage' in after);
        assert.equal(after.issueStage, before.issueStage);
        assert.ok('assignmentWarning' in after && after.assignmentWarning);
        assert.match(after.assignmentWarning.summary, /assignment is missing/i);
        if (scenario === 'reassignment') {
          fixtureState.fixture.item.assignees = [fixtureState.fixture.client.identity];
          fixtureState.fixture.events.push({
            ...event,
            nodeId: 'E_reassigned',
            databaseId: 32,
            event: 'assigned',
            createdAt: '2026-10-07T10:03:00Z',
          });
          const restored = await work.run('context', {}, true);
          assert.ok('assignmentObservation' in restored && !restored.assignmentObservation);
        }
      }
      fixtureState.now += 60_000;
      await reconcileCodexLifecycle(fixtureState.pluginData, fixtureState.deps);
      const saved = (await store.read()).records[0]!;
      assert.equal(
        saved.retirement?.reason,
        scenario === 'approved' ? 'assignment-removed' : undefined,
      );
      if (scenario !== 'approved')
        assert.equal(codexItemOccupied(saved), codexItemOccupied(original));
      assert.equal(saved.threadId, original.threadId);
      assert.equal(saved.worktree, original.worktree);
      assert.deepEqual(saved.progression, original.progression);
      assert.ok(saved);
      assert.equal(
        fixtureState.gitCalls.some((argv) => argv.includes('remove')),
        false,
      );
    });
  }

  it('should preserve implementation through intake-only policy changes', async () => {
    const work = await fixtureState.workIssue();
    work.receive();
    await work.run('context', {}, true);
    const changed = JSON.parse(await readFile(join(fixtureState.workspace, 'agent.yaml'), 'utf8'));
    Object.assign(changed.github['issue-assignment'], {
      paused: true,
      allowed: [],
      mode: 'plan',
    });
    await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(changed));
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    fixtureState.fixture.item.assignees = [];
    const unresolved = await work.run('context', {}, true);
    assert.equal(unresolved.status, 'verified');
    assert.ok('assignmentObservation' in unresolved);
    assert.equal(unresolved.assignmentObservation?.code, 'assignment-removal-evidence-conflicting');
  });

  for (const mode of ['plan', 'auto'] as const) {
    it(`should enter managed ${mode} through exact direct operator input without a new send or assessment`, async () => {
      const assessment = {
        ...fixtureState.result,
        ...(mode === 'auto'
          ? { decision: { mode: 'plan', reasons: ['Wait for direction.'] } }
          : {}),
      };
      const work = await fixtureState.workIssue(
        assessment,
        'Follow the plan.',
        'company:implement',
        mode,
      );
      fixtureState.native!.turnId = 'operator-implementation';
      fixtureState.native!.turnStatus = 'inProgress';
      fixtureState.native!.turnEnded = false;
      fixtureState.native!.status = 'active';
      work.continuation.directOperator = true;
      work.continuation.directScope = 'local';
      work.continuation.native!.operatorInput = async () => ({
        turnId: fixtureState.native!.turnId!,
        inputId: 'explicit-input',
        message: 'Implement locally and hold publication.',
      });
      work.continuation.continuationNative = async (_source, attempt) => ({
        status: 'verified',
        turnId: attempt.turnId!,
        ended: false,
      });
      const context = await work.run('context', {}, true);
      assert.equal(context.status, 'verified', JSON.stringify(context));
      assert.ok('publicationAuthorized' in context);
      assert.equal(context.publicationAuthorized, false);
      const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
      const record = (
        await new CodexDispatchStore(
          current.store.location.root,
          current.store.location.scope,
        ).read()
      ).records[0]!;
      assert.equal(record.progression?.via, 'operator');
      const saved = await work.run(
        'result',
        { result: { outcome: 'done', summary: 'Done.', fullResult: 'Local work complete.' } },
        true,
      );
      assert.deepEqual('handoff' in saved && saved.handoff, { next: 'complete' });
      await assert.rejects(
        work.run('delivery', { delivery: { action: 'prepare' } }, true),
        /implementation-publication-not-authorized/,
      );
    });
  }

  it('should use a live implementation skill from a changed catalog location', async () => {
    const work = await fixtureState.workIssue();
    work.receive();
    await work.run('context', {}, true);
    const original = work.continuation.native!.assessmentSkill;
    work.continuation.native!.assessmentSkill = async (cwd, id) => ({
      ...(await original(cwd, id)),
      path: '/different/SKILL.md',
    });
    const context = await work.run('context', {}, true);
    assert.equal(
      'implementation' in context && context.implementation?.skill.path,
      '/different/SKILL.md',
    );
  });

  it('should pass standing work publication authority to the existing delivery owner', async () => {
    const work = await fixtureState.workIssue();
    work.receive();
    await work.run('context', {}, true);
    await work.run(
      'result',
      { result: { outcome: 'done', summary: 'Done.', fullResult: 'Checked work.' } },
      true,
    );
    let calls = 0;
    work.continuation.deliver = async (_data, value, deliveryDeps) => {
      calls++;
      assert.deepEqual(value, { id: work.id, action: 'prepare' });
      assert.equal(deliveryDeps?.threadId, fixtureState.native!.id);
      assert.equal(deliveryDeps?.schedule, undefined);
      await deliveryDeps?.authorizeSchedule?.();
      throw new Error('fixture-delivery-boundary');
    };
    await assert.rejects(
      work.run('delivery', { delivery: { action: 'prepare' } }, true),
      /fixture-delivery-boundary/,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      work.run('delivery', { delivery: { id: 'foreign', action: 'prepare' } }, true),
      /delivery-invalid/,
    );
    assert.equal(calls, 1);
  });

  for (const kind of ['issue', 'pull-request'] as const)
    it(`should launch unassigned manual ${kind} work through existing native owners`, async () => {
      if (kind === 'pull-request') fixturePullRequest(fixtureState.fixture);
      const selected = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
      await rm(selected.store.location.path);
      await writeFile(
        join(fixtureState.workspace, 'agent.yaml'),
        JSON.stringify({ ...fixtureState.manifest, github: { username: 'receiver' } }),
      );
      fixtureState.fixture.item.assignees = [];
      fixtureState.fixture.client.listAssignmentEvents = async () => {
        throw new Error('unexpected assignment history');
      };
      fixtureState.deps.threadId = 'operator';
      fixtureState.deps.activation = async () => {
        throw new Error('manual work must not require a schedule');
      };
      fixtureState.deps.replyConnection = async () => ({
        close: async () => {},
        request: async (method) => {
          if (method === 'thread/read') return { thread: { id: 'operator' } };
          if (method === 'thread/turns/list')
            return { data: [{ id: 'operator-turn', status: 'inProgress' }] };
          if (method === 'thread/items/list')
            return {
              data: [
                {
                  turnId: 'operator-turn',
                  item: {
                    type: 'userMessage',
                    id: 'manual-input',
                    content: 'Work on owner/repo#3',
                  },
                },
              ],
            };
          throw new Error('unexpected native method: ' + method);
        },
      });
      const target =
        kind === 'pull-request' ? 'https://github.com/owner/repo/pull/3' : 'owner/repo#3';
      const first = await fixtureState.request('launch', {
        target,
        operation: 'context',
        mode: 'work',
      });
      assert.equal(first.status, 'routing-required');
      const project = await fixtureState.request('launch', {
        target,
        operation: 'prepare',
        projects: fixtureState.projects,
      });
      assert.equal(project.status, 'routing-required', JSON.stringify(project));
      const store = new CodexDispatchStore(fixtureState.pluginData, selected.store.location.scope);
      assert.equal((await store.read()).run, undefined);
      const scheduled = {
        threadId: 'intake-thread',
        activation: async () => ({ sourceThreadId: 'intake-thread' }),
      };
      const observe = () => fixtureState.request('observe-denials', {}, scheduled);
      await writeFile(
        join(fixtureState.workspace, 'agent.yaml'),
        JSON.stringify(fixtureState.manifest),
      );
      await runCodexIntake(fixtureState.pluginData, true, fixtureState.deps);
      assert.equal((await observe()).status, 'ready');
      const beforeDenialScan = (await store.read()).records;
      assert.equal((await observe()).status, 'ready');
      assert.deepEqual((await store.read()).records, beforeDenialScan);
      assert.equal(
        (await fixtureState.request('next', { projects: fixtureState.projects }, scheduled)).status,
        'idle',
      );
      assert.equal(
        (
          await fixtureState.request(
            'report',
            {
              automationId: 'native-intake',
              currentTimeIso: new Date(fixtureState.now).toISOString(),
            },
            scheduled,
          )
        ).status,
        'report',
      );
      await writeFile(
        join(fixtureState.workspace, 'agent.yaml'),
        JSON.stringify({ ...fixtureState.manifest, github: { username: 'receiver' } }),
      );
      const resumed = await fixtureState.request('launch', { target, operation: 'context' });
      assert.equal(resumed.id, first.id);
      assert.equal(resumed.digest, project.digest);
      const prepared = await fixtureState.request('launch', {
        target,
        operation: 'prepare',
        projects: fixtureState.projects,
        assessment: { complexity: 'medium', reason: 'Reuse existing issue work.' },
        title: 'MANUAL ISSUE',
      });
      assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
      assert.ok(prepared.request);
      if (kind === 'pull-request')
        assert.ok(
          fixtureState.gitCalls.some((argv) =>
            argv.includes('refs/heads/existing-work:refs/remotes/origin/existing-work'),
          ),
        );
      fixtureState.created();
      const recovered = await fixtureState.request('launch', { target, operation: 'reconcile' });
      assert.equal(recovered.status, 'existing', JSON.stringify(recovered));
      const state = await new CodexDispatchStore(
        fixtureState.pluginData,
        selected.store.location.scope,
      ).read();
      assert.equal(state.records.length, 1);
      assert.equal(state.records[0]!.intakeId, undefined);
      assert.equal(state.records[0]!.issueMode, 'work');
      assert.equal(state.run?.automationId, 'native-intake');
      const nativeContext = await fixtureState.request(
        'context',
        { id: first.id },
        { threadId: fixtureState.native!.id },
      );
      assert.equal(nativeContext.status, 'verified', JSON.stringify(nativeContext));
      const submitted = await fixtureState.renderAssessment(fixtureState.result, {
        threadId: fixtureState.native!.id,
      });
      assert.equal(submitted.status, 'formatted', JSON.stringify(submitted));
      const continuation = await runCodexContinuation(
        fixtureState.pluginData,
        { action: 'context', id: String(first.id) },
        {
          ...fixtureState.deps,
          threadId: fixtureState.native!.id,
          continuationNative: async (_source, attempt) => ({
            status: 'verified',
            turnId: attempt.turnId!,
            ended: false,
          }),
        },
      );
      assert.equal(continuation.status, 'verified', JSON.stringify(continuation));
      assert.ok('issueStage' in continuation && continuation.issueStage === 'implementation');
      const retirement = await fixtureState.request(
        'retire',
        { id: first.id },
        { threadId: 'operator' },
      );
      assert.equal(retirement.status, 'retire-available', JSON.stringify(retirement));
      const operator = {
        threadId: 'operator',
        activation: async () => {
          throw new Error('manual retirement must not require intake');
        },
      };
      const pending = await fixtureState.request('retire', { id: first.id, apply: true }, operator);
      assert.equal(pending.status, 'retirement-pending', JSON.stringify(pending));
      fixtureState.native!.status = 'idle';
      fixtureState.native!.turnStatus = 'completed';
      fixtureState.native!.turnEnded = true;
      fixtureState.deps.retirementNative = {
        worktreeUsers: async () => [fixtureState.native!.id],
        archiveOutcome: async () => 'unverified',
      };
      const threads = {
        schemaVersion: 4,
        pinnedThreads: [],
        unavailableHosts: [],
        unavailableSources: [],
      };
      const preparedRetirement = await fixtureState.request(
        'retire',
        { id: first.id, apply: true, threads },
        operator,
      );
      assert.equal(
        preparedRetirement.status,
        'retirement-prepared',
        JSON.stringify(preparedRetirement),
      );
      fixtureState.native!.archived = true;
      await rm(fixtureState.native!.cwd, { recursive: true });
      const finished = await fixtureState.request(
        'retire',
        { id: first.id, apply: true, threads },
        operator,
      );
      assert.equal(finished.status, 'retired', JSON.stringify(finished));
      assert.deepEqual(
        (
          await new CodexDispatchStore(
            fixtureState.pluginData,
            selected.store.location.scope,
          ).read()
        ).records,
        [],
      );
    });
});
