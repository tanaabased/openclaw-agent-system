import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { automationHash } from '../agent/automation-hash.ts';
import { issueKey } from '../agent/tasks/dispatch/dispatch-pending.ts';
import { fixturePullRequest } from './github-intake-fixture.ts';
import openclawDispatchFixture from './openclaw-dispatch-fixture.ts';

describe('agent/openclaw task-launch', () => {
  const fixtureState = openclawDispatchFixture();
  for (const { claimed, managedCaller } of [
    { claimed: false, managedCaller: false },
    { claimed: true, managedCaller: false },
    { claimed: false, managedCaller: true },
    { claimed: true, managedCaller: true },
  ])
    it(`should replace a stranded openclaw task through one native successor with claim transfer ${claimed} and managed caller ${managedCaller}`, async () => {
      fixtureState.multiple = true;
      if (claimed) {
        fixtureState.enableClaims();
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        );
        fixtureState.coordinator.runId = 'recovery-claim-occurrence';
      }
      const input = await fixtureState.next();
      await fixtureState.prepare(input);
      await fixtureState.assess(input.id);
      await fixtureState.completeAssessment(input.id);
      const predecessor = await fixtureState.record();
      const operator = {
        sessionKey: 'agent:receiver:recovery-operator',
        sessionId: 'recovery-session',
        runId: 'recovery-run',
        toolCallId: 'recover',
      };
      fixtureState.sessions.set(operator.sessionKey, { sessionId: operator.sessionId });
      fixtureState.histories.set(operator.sessionKey, {
        active: true,
        inputReceipts: [],
        messages: [
          {
            role: 'user',
            content: 'Replace the stranded task using its PR.',
            __openclaw: {
              id: 'recovery-input',
              runId: operator.runId,
              idempotencyKey: 'recovery-run:user',
              senderIsOwner: true,
            },
          },
        ],
      });
      let prHead = 'a'.repeat(40);
      let providerReads = 0;
      fixtureState.service.dependencies.assessmentGit = async ({ argv }) =>
        argv.includes('--show-toplevel') ? fixtureState.root : prHead;
      fixtureState.service.dependencies.delivery = async () => ({
        git: async () => '',
        account: {
          identity: fixtureState.fixture.client.identity,
          execute: async (argv) => {
            providerReads++;
            const data = argv.some((arg) => arg.includes('/pulls/'))
              ? {
                  nodeId: 'PR_7',
                  number: 7,
                  state: 'open',
                  repositoryId: 'R_repo',
                  headRepositoryId: 'R_repo',
                  head: prHead,
                  branch: 'existing-work',
                  base: 'release',
                  authorId: 'U_collaborator',
                  title: 'Existing work',
                  body: '',
                }
              : { databaseId: 20, nodeId: 'I_issue', number: 3, title: 'Issue' };
            return {
              exitCode: 0,
              stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(data),
              stderr: '',
              timedOut: false,
              truncated: false,
            };
          },
        },
      });
      const action = {
        action: 'recover' as const,
        id: input.id,
        pullRequest: 'https://github.com/owner/repo/pull/7',
      };
      const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
      const { journal } = current;
      if (managedCaller) {
        const otherAdmission = await current.store.exclusive(async (state, save) => {
          const other = structuredClone(state!.records[0]!);
          other.issue.nodeId = 'I_other';
          other.issue.number = 99;
          other.id = automationHash([
            other.scope,
            other.repository.nodeId,
            other.issue.nodeId,
            other.assignment.nodeId,
          ]);
          state!.records.push(other);
          await save(state!);
          return other;
        });
        await journal.exclusive(async (state, save) => {
          state.records.push({
            id: 'b'.repeat(64),
            issueKey: issueKey(otherAdmission),
            intakeId: otherAdmission.id,
            sourceThreadId: fixtureState.coordinator.sessionKey,

            manifestDigest: predecessor.manifestDigest,
            createdAt: predecessor.createdAt,
            threadId: operator.sessionKey,
          });
          await save();
        });
      }
      const unrelated = (await journal.read()).records[1]!;
      const preview = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        operator,
        action,
        true,
      );
      assert.equal(preview.status, 'recovery-available', JSON.stringify(preview));
      assert.ok('digest' in preview && typeof preview.digest === 'string');
      assert.deepEqual(await fixtureState.record(), predecessor);
      prHead = 'b'.repeat(40);
      await assert.rejects(
        fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          operator,
          { ...action, digest: preview.digest },
          true,
        ),
        /dispatch-recovery-stale/,
      );
      prHead = 'a'.repeat(40);
      fixtureState.histories.get(predecessor.threadId!)!.active = true;
      await assert.rejects(
        fixtureState.service.run(fixtureState.manifest, fixtureState.root, operator, action, true),
        /chat-active-or-unverified/,
      );
      fixtureState.histories.get(predecessor.threadId!)!.active = false;
      const applied = await fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        operator,
        {
          action: 'recover',
          target: 'https://github.com/owner/repo/issues/3',
          pullRequest: action.pullRequest,
        },
        true,
      );
      assert.equal(applied.status, 'recovery-ready', JSON.stringify(applied));
      assert.ok('successorId' in applied && typeof applied.successorId === 'string');
      assert.equal(
        (
          await fixtureState.service.runModel(
            fixtureState.manifest,
            fixtureState.root,
            operator,
            {
              action: 'recover',
              target: 'https://github.com/owner/repo/issues/3',
              pullRequest: action.pullRequest,
            },
            true,
          )
        ).status,
        'recovery-ready',
      );
      const old = await fixtureState.record();
      assert.equal(old.supersededBy, applied.successorId);
      assert.equal(old.worktree, predecessor.worktree);
      await assert.rejects(fixtureState.context(input.id), /dispatch-task-superseded/);
      if (managedCaller) {
        const records = (await journal.read()).records;
        assert.equal(records.length, 3);
        assert.deepEqual(records[1], unrelated);
        assert.equal(fixtureState.creates().length, 1);
        return;
      }
      const target = 'owner/repo#3';
      const admitted = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        operator,
        { action: 'launch', operation: 'context', target },
        true,
      );
      assert.ok('digest' in admitted && typeof admitted.digest === 'string');
      // The existing native creation reconciliation must reuse this exact checkout and request.
      const nativePrepare = fixtureState.service.dependencies.worktrees.prepareGitHub;
      fixtureState.service.dependencies.worktrees.prepareGitHub = async (request) => {
        assert.equal(request.startingCommit, prHead);
        const result = await nativePrepare(request);
        const path = join(fixtureState.root, 'successor-worktree');
        await mkdir(path, { recursive: true });
        return { ...result, path };
      };
      fixtureState.lost = true;
      const uncertain = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        operator,
        {
          action: 'launch',
          operation: 'prepare',
          target,
          title: 'continue existing work',
          assessment: { complexity: 'low', reason: 'Retain the task plan.' },
        },
        true,
      );
      assert.notEqual(uncertain.status, 'session-created');
      fixtureState.lost = false;
      const recovered = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        operator,
        { action: 'launch', operation: 'reconcile', target },
        true,
      );
      assert.equal(recovered.status, 'assessment-pending', JSON.stringify(recovered));
      const records = (
        await (
          await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
        ).journal.read()
      ).records;
      assert.equal(records.length, 2);
      const successor = records.find((r) => r.id === applied.successorId)!;
      assert.notEqual(successor.worktree, predecessor.worktree);
      assert.equal(successor.adoptedPullRequest?.head, prHead);
      assert.equal(successor.manualIssue?.selections?.mode, undefined);
      assert.equal(successor.delivery, undefined);
      assert.equal(fixtureState.creates().length, 2);
      if (claimed) {
        const claims = await fixtureState.service.dependencies.claimStore!.exclusive(
          async (state) => structuredClone(state),
        );
        assert.equal(
          Object.values(claims!.claims)[0]!.nativeReceipt,
          successor.sessionCreation!.sessionId,
        );
        assert.equal(
          Object.values(claims!.claims)[0]!.recovery?.predecessorReceipt,
          predecessor.sessionCreation!.sessionId,
        );
      }
      assert.ok(providerReads > 0);
    });

  it('should launch manual work using only the default model profile', async () => {
    fixtureState.fixture.item.assignees = [];
    fixtureState.fixture.client.listAssignmentEvents = async () => {
      throw new Error('manual work must not depend on assignment history');
    };
    fixtureState.manifest.models = { default: fixtureState.manifest.models!.default };
    const selected = await fixtureState.fixtureIntake.select(
      fixtureState.manifest,
      fixtureState.root,
    );
    await rm(selected.store.location.path);
    delete fixtureState.manifest.github!.notifications;
    fixtureState.multiple = true;
    const who = {
      sessionKey: 'agent:receiver:manual-source',
      sessionId: 'manual-source-id',
      runId: 'manual-turn',
      toolCallId: 'manual-launch',
    };
    fixtureState.sessions.set(who.sessionKey, { sessionId: who.sessionId });
    fixtureState.histories.set(who.sessionKey, {
      active: true,
      inputReceipts: [],
      messages: [
        {
          role: 'user',
          content: 'Work on owner/repo#3',
          __openclaw: {
            id: 'manual-input',
            runId: who.runId,
            idempotencyKey: 'manual-turn:user',
            senderIsOwner: true,
          },
        },
      ],
    });
    const target = 'owner/repo#3';
    const first = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      who,
      {
        action: 'launch',
        operation: 'context',
        target,
        mode: 'plan',
      },
      true,
    );
    assert.ok('id' in first && typeof first.id === 'string', JSON.stringify(first));
    assert.ok('digest' in first && typeof first.digest === 'string');
    const launched = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      who,
      {
        action: 'launch',
        operation: 'prepare',
        target,
        assessment: { complexity: 'medium', reason: 'Use existing workflow pieces.' },
        title: 'MANUAL ISSUE',
        fallback: 'default',
      },
      true,
    );
    assert.equal(launched.status, 'assessment-pending', JSON.stringify(launched));
  });

  for (const kind of ['issue', 'pull-request'] as const)
    it(`should launch unassigned manual ${kind} work through existing native owners`, async () => {
      if (kind === 'pull-request') {
        fixturePullRequest(fixtureState.fixture);
        fixtureState.service.dependencies.assessmentGit = async ({ argv }) => {
          assert.equal(argv[0], 'check-ref-format');
          return '';
        };
      }
      if (kind === 'pull-request') {
        const prepare = fixtureState.service.dependencies.worktrees.prepareGitHub;
        fixtureState.service.dependencies.worktrees.prepareGitHub = async (input) => {
          assert.equal(input.itemType, 'pull-request');
          assert.deepEqual(input.startingHead, {
            headRef: 'existing-work',
            headSha: '1'.repeat(40),
          });
          return prepare(input);
        };
      }
      fixtureState.fixture.item.assignees = [];
      fixtureState.fixture.client.listAssignmentEvents = async () => {
        throw new Error('manual work must not depend on assignment history');
      };
      const selected = await fixtureState.fixtureIntake.select(
        fixtureState.manifest,
        fixtureState.root,
      );
      await rm(selected.store.location.path);
      delete fixtureState.manifest.github!.notifications;
      fixtureState.multiple = true;
      const who = {
        sessionKey: 'agent:receiver:manual-source',
        sessionId: 'manual-source-id',
        runId: 'manual-turn',
        toolCallId: 'manual-launch',
      };
      fixtureState.sessions.set(who.sessionKey, { sessionId: who.sessionId });
      fixtureState.histories.set(who.sessionKey, {
        active: true,
        inputReceipts: [],
        messages: [
          {
            role: 'user',
            content: 'Work on owner/repo#3',
            __openclaw: {
              id: 'manual-input',
              runId: who.runId,
              idempotencyKey: 'manual-turn:user',
              senderIsOwner: true,
            },
          },
        ],
      });
      const target =
        kind === 'pull-request' ? 'https://github.com/owner/repo/pull/3' : 'owner/repo#3';
      const first = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        who,
        {
          action: 'launch',
          operation: 'context',
          target,
          mode: 'plan',
          routing: { model: 'openai/gpt-6-luna', effort: 'medium' },
          stages: {
            assessment: {
              skill: 'ordinary-assessment',
              guidance: 'Use the manual launch guidance.',
            },
          },
        },
        true,
      );
      assert.ok('id' in first && typeof first.id === 'string', JSON.stringify(first));
      assert.ok('digest' in first && typeof first.digest === 'string');
      const launched = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        who,
        {
          action: 'launch',
          operation: 'prepare',
          target,
          assessment: { complexity: 'medium', reason: 'Use existing workflow pieces.' },
          title: 'MANUAL ISSUE',
        },
        true,
      );
      assert.equal(launched.status, 'assessment-pending', JSON.stringify(launched));
      const state = await (
        await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
      ).journal.read();
      assert.equal(state.records.length, 1);
      assert.equal(state.records[0]!.intakeId, undefined);
      assert.equal(state.openclawOccurrence, undefined);
      assert.equal(state.records[0]!.manualIssue?.selections?.mode, 'plan');
      const retained = state.records[0]!;
      const output = await fixtureState.service.promptContext(
        fixtureState.manifest,
        fixtureState.root,
        {
          agentId: fixtureState.manifest.agent.id,
          sessionKey: retained.threadId,
          sessionId: retained.sessionCreation?.sessionId,
          runId: retained.nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn?.runId,
        },
      );
      assert.ok(output);
      const facts = JSON.parse(output.appendContext.split('\n')[1]!);
      assert.equal(facts.status, 'verified');
      assert.equal(state.records[0]!.request?.model, 'openai/gpt-6-luna');
      assert.equal(state.records[0]!.request?.thinkingLevel, 'medium');
      assert.equal(facts.assessment?.skill.name, 'ordinary-assessment');
      assert.equal(facts.assessment?.guidance?.content, 'Use the manual launch guidance.');
      assert.equal(fixtureState.preparedWorktrees, 1);
      assert.equal(
        fixtureState.calls.filter((call) => call.method === 'sessions.create').length,
        1,
      );
      assert.equal(fixtureState.calls.filter((call) => call.method === 'chat.send').length, 1);
      const reused = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        who,
        { action: 'launch', operation: 'context', target },
        true,
      );
      assert.equal(reused.status, 'existing');
      assert.equal(
        fixtureState.calls.filter((call) => call.method === 'sessions.create').length,
        1,
      );
      if (kind === 'pull-request') return;
      who.runId = 'second-manual-turn';
      fixtureState.histories.get(who.sessionKey)!.messages.push({
        role: 'user',
        content: 'Launch this issue again',
        __openclaw: {
          id: 'second-manual-input',
          runId: who.runId,
          idempotencyKey: 'second-manual-turn:user',
          senderIsOwner: true,
        },
      });
      fixtureState.manifest.github!.notifications = {
        ...fixtureState.fixture.policy,
        routing: [],
        maxConcurrentItems: 1,
      };
      const additional = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        who,
        { action: 'launch', operation: 'context', target },
        true,
      );
      assert.ok('id' in additional && typeof additional.id === 'string');
      assert.ok('digest' in additional && typeof additional.digest === 'string');
      const originalPrepare = fixtureState.service.dependencies.worktrees.prepareGitHub;
      fixtureState.service.dependencies.worktrees.prepareGitHub = async (request) => {
        assert.equal(request.separateCheckout, true);
        assert.equal(request.attemptId, additional.id);
        const result = await originalPrepare(request);
        const path = join(fixtureState.root, 'additional-worktree');
        await mkdir(path, { recursive: true });
        return { ...result, path };
      };
      const extra = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        who,
        {
          action: 'launch',
          operation: 'prepare',
          target,
          fresh: true,
          title: 'additional collaboration',
          assessment: { complexity: 'low', reason: 'Bounded independent collaboration.' },
        },
        true,
      );
      assert.equal(extra.status, 'assessment-pending', JSON.stringify(extra));
      assert.equal(fixtureState.creates().length, 2);
      assert.equal(
        (
          await fixtureState.service.run(
            fixtureState.manifest,
            fixtureState.root,
            who,
            { action: 'launch', operation: 'context', target, fresh: true },
            true,
          )
        ).status,
        'existing',
      );
      assert.equal((await fixtureState.context(first.id)).status, 'verified');
      assert.equal(
        (await fixtureState.renderAssessment(first.id, fixtureState.plan)).status,
        'formatted',
      );
    });

  for (const failure of ['creation', 'send'] as const) {
    for (const kind of ['issue', 'pull-request'] as const)
      it(`should reconcile manual ${kind} ${failure} uncertainty through the original session owner`, async () => {
        const pr = kind === 'pull-request' ? fixturePullRequest(fixtureState.fixture) : undefined;
        if (pr)
          fixtureState.service.dependencies.assessmentGit = async ({ argv }) => {
            assert.equal(argv[0], 'check-ref-format');
            return '';
          };
        fixtureState.fixture.item.assignees = [];
        fixtureState.manifest.models = { default: fixtureState.manifest.models!.default };
        const selected = await fixtureState.fixtureIntake.select(
          fixtureState.manifest,
          fixtureState.root,
        );
        await rm(selected.store.location.path);
        delete fixtureState.manifest.github!.notifications;
        fixtureState.multiple = true;
        const who = {
          sessionKey: 'agent:receiver:manual-source',
          sessionId: 'manual-source-id',
          runId: 'manual-turn',
          toolCallId: 'manual-launch',
        };
        fixtureState.sessions.set(who.sessionKey, { sessionId: who.sessionId });
        fixtureState.histories.set(who.sessionKey, {
          active: true,
          inputReceipts: [],
          messages: [
            {
              role: 'user',
              content: 'Work on owner/repo#3',
              __openclaw: {
                id: 'manual-input',
                runId: who.runId,
                idempotencyKey: 'manual-turn:user',
                senderIsOwner: true,
              },
            },
          ],
        });
        const target = pr ? 'https://github.com/owner/repo/pull/3' : 'owner/repo#3';
        const first = await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          who,
          { action: 'launch', operation: 'context', target, mode: 'plan' },
          true,
        );
        assert.ok('id' in first && typeof first.id === 'string');
        assert.ok('digest' in first && typeof first.digest === 'string');
        if (failure === 'creation') fixtureState.lost = true;
        else fixtureState.loseSend = true;
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          who,
          {
            action: 'launch',
            operation: 'prepare',
            target,
            assessment: { complexity: 'low', reason: 'A bounded manual issue.' },
            fallback: 'default',
            title: 'MANUAL ISSUE',
          },
          true,
        );
        fixtureState.lost = false;
        fixtureState.loseSend = false;
        if (pr) pr.headSha = '2'.repeat(40);
        const recovered = await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          who,
          { action: 'launch', operation: 'reconcile', target },
          true,
        );
        assert.equal(recovered.status, 'assessment-pending', JSON.stringify(recovered));
        assert.equal(
          fixtureState.calls.filter((call) => call.method === 'sessions.create').length,
          1,
        );
        assert.equal(fixtureState.calls.filter((call) => call.method === 'chat.send').length, 1);
        fixtureState.service.dependencies.coordinator = async () => {
          throw new Error('manual retirement must not require intake');
        };
        const retirement = await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          who,
          { action: 'retire', id: first.id },
          true,
        );
        assert.equal(retirement.status, 'retire-available', JSON.stringify(retirement));
        const pending = await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          who,
          { action: 'retire', id: first.id, apply: true },
          true,
        );
        assert.equal(pending.status, 'retirement-pending', JSON.stringify(pending));
        const journal = (await fixtureState.service.scope(fixtureState.manifest, fixtureState.root))
          .journal;
        const task = (await journal.read()).records[0]!;
        assert.equal(task.cleanupPending, true);
        const history = fixtureState.histories.get(task.threadId!)!;
        history.active = false;
        history.inputReceipts = [];
        fixtureState.service.dependencies.worktrees.cleanupGitHub = async (input) => {
          if (!input.verifyOnly) await rm(input.worktree.path, { recursive: true });
          return {
            ...input.worktree,
            repositoryId: 'github-10',
            workId: 'issue-20',
            status: input.verifyOnly ? 'preserved' : 'removed',
          };
        };
        const resumed = await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          { ...who, runId: 'next-explicit-invocation' },
          { action: 'retire', id: first.id, apply: true },
          true,
        );
        assert.equal(resumed.status, 'retired', JSON.stringify(resumed));
        assert.deepEqual((await journal.read()).records, []);
        assert.equal(
          fixtureState.calls.filter((call) => call.method === 'sessions.patch').length,
          1,
        );
      });
  }
});
