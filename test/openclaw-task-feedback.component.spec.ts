import { GatewayClientRequestError } from '@openclaw/gateway-client';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { automationHash } from '../agent/automation-hash.ts';
import openclawIntakeJobs from '../agent/automations/openclaw-intake-policy.ts';
import DiscoveryBudget, { DiscoveryPaused } from '../agent/discovery-budget.ts';
import discoveryCheckpoint from '../agent/discovery-checkpoint.ts';
import openClawConditionCheck from '../agent/openclaw-condition-check.ts';
import { issueKey } from '../agent/tasks/dispatch/dispatch-pending.ts';
import { pendingRecoveryFeedback } from '../agent/tasks/dispatch/issue-task-recovery.ts';
import openClawCapacity from '../agent/tasks/dispatch/openclaw-capacity.ts';
import OpenClawDispatch from '../agent/tasks/dispatch/openclaw-dispatch.ts';
import { scanOpenClawFeedback } from '../agent/tasks/feedback/openclaw-feedback-scan.ts';
import { feedbackTarget } from '../agent/tasks/feedback/reply-target.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import { attemptedAnnouncement } from './delivery-announcement-fixture.ts';
import { baseline, fixturePullRequest } from './github-intake-fixture.ts';
import {
  reviewClientFixture,
  reviewCommentFixture,
  reviewFixture,
} from './github-review-fixtures.ts';
import hydrateImplementation from './implementation-material-fixture.ts';
import openclawDispatchFixture from './openclaw-dispatch-fixture.ts';

describe('agent/openclaw task-feedback', () => {
  const fixtureState = openclawDispatchFixture();
  for (const implementation of [false, true])
    for (const source of ['unrelated', 'current'] as const)
      it(`should preserve ${implementation ? 'implementation' : 'assessment'} task context when ${source} feedback history is unavailable`, async () => {
        const { id } = await fixtureState.feedbackOwner(implementation);
        await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        );
        const before = await fixtureState.record();
        const event = before.feedback!.events[0]!;
        assert.ok(event.turn);
        assert.equal(event.turn.executionRunId, undefined);
        const who = fixtureState.assessor(
          id,
          source === 'current' ? event.turn.runId : 'ordinary-answer',
        );
        fixtureState.historyRejected = true;
        const output = await fixtureState.service.promptContext(
          fixtureState.manifest,
          fixtureState.root,
          {
            agentId: fixtureState.manifest.agent.id,
            sessionKey: who.sessionKey,
            sessionId: who.sessionId,
            runId: who.runId,
          },
        );
        assert.ok(output);
        const facts = JSON.parse(output.appendContext.split('\n')[1]!);
        assert.equal(facts.receipt, id);
        assert.equal(facts.worktree, before.worktree);
        assert.equal(
          facts.stage,
          source === 'current' ? 'feedback' : implementation ? 'implementation' : 'conversation',
        );
        assert.ok(facts.feedbackLimitation?.code);
        assert.equal(facts.contextRequest, undefined);
        assert.equal(facts.feedback, undefined);
        assert.doesNotMatch(JSON.stringify(output), /private-token/);
        assert.deepEqual(await fixtureState.record(), before);
        fixtureState.historyRejected = false;
        if (source === 'current')
          fixtureState.inputReceipts = [
            {
              runId: event.turn.runId,
              state: 'consumed',
              consumedByEventId: `${event.turn.runId}:input`,
            },
          ];
        const recovered = await fixtureState.service.promptContext(
          fixtureState.manifest,
          fixtureState.root,
          {
            agentId: fixtureState.manifest.agent.id,
            sessionKey: who.sessionKey,
            sessionId: who.sessionId,
            runId: who.runId,
          },
        );
        assert.ok(recovered);
        const recoveredFacts = JSON.parse(recovered.appendContext.split('\n')[1]!);
        assert.equal(recoveredFacts.feedbackLimitation, undefined);
        assert.equal(recoveredFacts.feedbackContextRequest, undefined);
        if (source === 'current')
          assert.equal(
            recoveredFacts.feedback.replyTarget,
            `https://github.com/owner/repo/issues/${event.number}#issuecomment-${JSON.parse(event.source).databaseId}`,
          );
        assert.deepEqual(await fixtureState.record(), before);
      });

  for (const identifier of ['transcript', 'submission'] as const)
    it(`should recover feedback context and pass delivery preflight with the ${identifier} identifier`, async () => {
      const { id } = await fixtureState.feedbackOwner();
      fixtureState.consumeSend = true;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      const before = await fixtureState.record();
      const event = before.feedback!.events[0]!;
      const who = {
        ...fixtureState.assessor(id, event.turn!.runId),
        inputId: `${event.turn!.runId}:${identifier === 'submission' ? 'user' : 'input'}`,
      };
      fixtureState.historyRejected = true;
      const unavailable = await fixtureState.service.promptContext(
        fixtureState.manifest,
        fixtureState.root,
        { ...who, agentId: fixtureState.manifest.agent.id },
      );
      assert.ok(unavailable);
      assert.ok(JSON.parse(unavailable.appendContext.split('\n')[1]!).feedbackLimitation);
      assert.match(unavailable.appendSystemContext, /not a prerequisite.*independently verifies/);
      fixtureState.historyRejected = false;
      await mkdir(before.worktree!, { recursive: true });
      fixtureState.service.dependencies.delivery = async () => ({
        account: {
          identity: fixtureState.fixture.client.identity,
          execute: async () => {
            throw new Error('unexpected publication');
          },
        },
        async git(argv) {
          if (argv[0] === 'branch') return 'task-branch';
          if (argv.includes('--show-toplevel')) return before.worktree!;
          if (argv[0] === 'rev-parse') return 'a'.repeat(40);
          if (argv[0] === 'rev-list') return '1';
          if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
          if (argv[0] === 'status' || argv[0] === 'check-ref-format') return '';
          throw new Error('unexpected git operation');
        },
      });
      const prepared = await fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        who,
        {
          action: 'delivery',
          operation: 'prepare',
          title: '#3: repair requested behavior',
          body: 'Closes #3',
        },
        true,
      );
      assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
      const recovered = await fixtureState.service.promptContext(
        fixtureState.manifest,
        fixtureState.root,
        { ...who, agentId: fixtureState.manifest.agent.id },
      );
      assert.ok(recovered);
      const facts = JSON.parse(recovered.appendContext.split('\n')[1]!);
      assert.equal(facts.feedbackLimitation, undefined);
      assert.equal(
        facts.feedback.replyTarget,
        'https://github.com/owner/repo/issues/3#issuecomment-99',
      );
      const context = await fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        who,
        { action: 'feedback', operation: 'context' },
        true,
      );
      assert.equal(context.status, 'verified', JSON.stringify(context));
      fixtureState.inputReceipts = [
        {
          runId: event.turn!.runId,
          state: 'consumed',
          consumedByEventId: `${event.turn!.runId}:input`,
          cancelled: true,
        },
      ];
      await assert.rejects(
        fixtureState.service.runModel(
          fixtureState.manifest,
          fixtureState.root,
          who,
          {
            action: 'delivery',
            operation: 'prepare',
            title: '#3: repair requested behavior',
            body: 'Closes #3',
          },
          true,
        ),
        /dispatch-input-unverified/,
      );
    });

  it('should deliver feedback without waiting for the assessment reconciliation pass', async () => {
    await fixtureState.feedbackOwner(false);
    assert.equal((await fixtureState.record()).handoff, undefined);
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'accepted',
    );
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.equal((await fixtureState.record()).feedback?.events.length, 1);
    const delivered = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal(delivered.status, 'feedback-pending');
    assert.ok((await fixtureState.record()).feedback?.events[0]?.turn);
    assert.equal(fixtureState.creates().length, 1);
    assert.equal(fixtureState.sends().length, 2);
  });

  it('should deliver feedback with a missing checkout and exhausted assignment capacity', async () => {
    const { id } = await fixtureState.feedbackOwner();
    fixtureState.manifest.github!.notifications!.maxConcurrentItems = 1;
    const { journal } = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await journal.exclusive(async (state, save) => {
      const other = structuredClone(state.records[0]!);
      other.id = 'f'.repeat(64);
      other.issueKey = 'e'.repeat(64);
      other.threadId = 'other-chat';
      other.request!.key = other.threadId;
      other.worktreeAttemptId = other.id;
      delete other.nativeTurns;

      delete other.feedback;
      delete other.work;
      delete other.handoff;
      delete other.progression;
      other.nativeTurns = [
        {
          role: 'assessment',
          turn: {
            runId: `${other.id}:assessment`,
            message: 'work',
            status: 'accepted',
          },
        },
      ];
      state.records.push(other);
      await save();
    });
    await rm(join(fixtureState.root, 'worktree'), { recursive: true, force: true });
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    const output = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.ok(output.status);
    const retained = (await journal.read()).records.find((entry) => entry.id === id)!;
    assert.ok(retained.feedback!.events[0]!.turn);
  });

  it('should reactivate unassigned openclaw feedback through ordinary intake without replacing the session', async () => {
    const { comments } = await fixtureState.feedbackOwner();
    fixtureState.fixture.item.assignees = [];
    fixtureState.fixture.events.push({
      ...fixtureState.fixture.events[0]!,
      nodeId: 'removed',
      databaseId: 31,
      event: 'unassigned',
      createdAt: '2026-10-07T10:02:00Z',
    });
    fixtureState.service.dependencies.now = () => baseline + 240_000;
    const before = await fixtureState.record();
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'reactivation' },
      { action: 'next' },
    );
    const after = await fixtureState.record();
    assert.equal(after.retirement, undefined);
    assert.equal(after.feedbackReactivation?.assignmentEventId, 'removed');
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.feedback?.events[0]?.sourceId, comments[0]!.nodeId);
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should page a complete grouped review through authorized openclaw context reads', async () => {
    const { id, comments } = await fixtureState.feedbackOwner();
    comments.length = 0;
    const author = { login: 'operator', nodeId: 'U_operator', type: 'User' };
    fixtureState.manifest.github!.notifications!.issueAssignment!.feedback = {
      inherit: false,
      allowed: [author],
    };
    const review = reviewFixture({ author, body: '@receiver address every finding' });
    const findings = Array.from({ length: 3 }, (_, i) =>
      reviewCommentFixture({
        author,
        nodeId: `finding-${i}`,
        databaseId: 100 + i,
        body: `finding ${i}: ` + 'complete evidence '.repeat(300),
        diffHunk: '+ code\n'.repeat(1600),
      }),
    );
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await current.journal.exclusive(async (state, save) => {
      const owner = state.records[0]!;
      owner.delivery = {
        id: 'd'.repeat(64),
        title: 'Delivery',
        body: 'Closes #3',
        creationAttempted: true,
        reconciled: true,
        pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
        binding: {
          repositoryId: fixtureState.fixture.repository.nodeId,
          issueId: fixtureState.fixture.item.nodeId,
          threadId: owner.threadId!,
          sessionId: owner.sessionCreation!.sessionId!,
          worktree: owner.worktree!,
          branch: 'issue-3',
          base: 'main',
          head: 'a'.repeat(40),
          authorId: fixtureState.fixture.client.identity.nodeId,
        },
      };
      owner.feedback = { baseline: { PR_7: {} }, events: [] };
      await save();
    });
    const connect = fixtureState.service.dependencies.feedbackConnect!;
    fixtureState.service.dependencies.feedbackConnect = async (...args) => ({
      ...(await connect(...args)),
      reviews: reviewClientFixture(review, findings),
      getItem: async (_o, _n, number) =>
        number === 7
          ? {
              ...fixtureState.fixture.item,
              nodeId: 'PR_7',
              number: 7,
              itemType: 'pull-request',
              pullRequest: {
                baseRef: 'main',
                baseRepositoryDatabaseId: fixtureState.fixture.repository.databaseId,
                baseRepositoryNodeId: fixtureState.fixture.repository.nodeId,
                draft: false,
                headRef: 'issue-3',
                headSha: 'a'.repeat(40),
                merged: false,
              },
            }
          : fixtureState.fixture.item,
    });
    fixtureState.consumeSend = true;
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const event = (await fixtureState.record()).feedback!.events.find(
      (entry) => entry.sourceId === review.nodeId,
    )!;
    assert.ok(event?.turn);
    const who = fixtureState.assessor(id, event.turn.runId);
    const input = {
      action: 'feedback' as const,
      operation: 'context' as const,
      id,
      eventId: event.id,
    };
    const context = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      who,
      input,
    );
    assert.ok('contextMaterials' in context && context.contextMaterials);
    const before = await fixtureState.record();
    const restored = await hydrateImplementation(context, async (request) =>
      fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, {
        ...input,
        material: request.material as { path: string[]; digest: string; offset: number },
      }),
    );
    for (const finding of findings) assert.ok(JSON.stringify(restored).includes(finding.body));
    assert.deepEqual(await fixtureState.record(), before);
    const material = context.contextMaterials.fields[0]!.request.material as {
      path: string[];
      digest: string;
      offset: number;
    };
    await assert.rejects(
      fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, {
        ...input,
        material: { ...material, digest: '0'.repeat(64) },
      }),
      /material-stale/,
    );
    await assert.rejects(
      fixtureState.service.run(fixtureState.manifest, fixtureState.root, fixtureState.coordinator, {
        ...input,
        material,
      }),
      /feedback-owner-caller-required/,
    );
  });

  it('should reuse one issue observation per feedback authorization and refresh on the next call', async () => {
    const { id } = await fixtureState.feedbackOwner();
    fixtureState.consumeSend = true;
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const event = (await fixtureState.record()).feedback!.events[0]!;
    assert.ok(event?.turn, JSON.stringify((await fixtureState.record()).feedback));
    const who = fixtureState.assessor(id, event.turn!.runId);
    const input = {
      action: 'feedback' as const,
      operation: 'context' as const,
      id,
      eventId: event.id,
    };
    const read = fixtureState.fixture.client.getItem;
    let reads = 0;
    fixtureState.fixture.client.getItem = async (...args) => {
      reads++;
      return structuredClone(await read(...args));
    };
    assert.equal(
      (await fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, input)).status,
      'verified',
    );
    assert.equal(reads, 1);
    fixtureState.fixture.item.state = 'closed';
    const result = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      who,
      input,
    );
    assert.equal(result.status, 'verified');
    assert.equal(reads, 2);
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should release a queued announcement echo from replacement without sending it', async () => {
    const { comments } = await fixtureState.feedbackOwner();
    const before = fixtureState.sends().length;
    const { journal } = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.announcement = {
        ...attemptedAnnouncement(fixtureState.fixture.client.identity.nodeId).state,
        receipt: { nodeId: comments[0]!.nodeId, databaseId: comments[0]!.databaseId },
      };
      await save();
    });
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const event = (await fixtureState.record()).feedback!.events[0]!;
    assert.equal(event.phase, 'blocked');
    assert.equal(event.code, 'feedback-own-output');
    assert.equal(event.turn, undefined);
    assert.equal(fixtureState.sends().length, before);
    assert.equal(pendingRecoveryFeedback(event), false);
  });

  it('should reconcile an uncertain delivery announcement before discovering same-account feedback', async () => {
    const { comments } = await fixtureState.feedbackOwner();
    const announcement = attemptedAnnouncement(fixtureState.fixture.client.identity.nodeId);
    const connect = fixtureState.service.dependencies.feedbackConnect!;
    fixtureState.service.dependencies.feedbackConnect = async (...args) => ({
      ...(await connect(...args)),
      findOwnIssueComment: async () => ({
        nodeId: 'IC_announcement',
        databaseId: 100,
        body: announcement.body,
      }),
    });
    comments.push({
      ...comments[0]!,
      nodeId: 'IC_announcement',
      databaseId: 100,
      body: announcement.body,
    });
    const { journal } = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await journal.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.delivery = {
        id: 'a'.repeat(64),
        binding: {
          repositoryId: 'R_repo',
          issueId: 'I_issue',
          threadId: record.threadId!,
          sessionId: record.sessionCreation!.sessionId!,
          worktree: record.worktree!,
          branch: 'branch',
          base: 'main',
          head: 'a'.repeat(40),
          authorId: fixtureState.fixture.client.identity.nodeId,
        },
        title: 'Title',
        body: 'Body',
        creationAttempted: true,
        reconciled: true,
      };
      record.announcement = announcement.state;
      await save();
    });
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.deepEqual(
      (await fixtureState.record()).feedback!.events.map((event) => event.sourceId),
      ['C_feedback'],
    );
  });

  it('should admit feedback without replacing concurrent native activity observations', async () => {
    await fixtureState.feedbackOwner();
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const snapshot = await current.journal.read();
    await current.journal.exclusive(async (state, save) => {
      state.records[0]!.nativeInactive = true;
      await save();
    });
    const scans = await scanOpenClawFeedback({
      service: fixtureState.service,
      state: snapshot,
      manifest: fixtureState.manifest,
      workspace: fixtureState.root,
      sourceThreadId: fixtureState.coordinator.sessionKey,
      authority: {},
      now: fixtureState.service.dependencies.now!(),
      checkpoint: (scan) => discoveryCheckpoint(current.journal, scan),
    });
    assert.equal(scans.length, 1);
    assert.equal((await fixtureState.record()).nativeInactive, true);
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.equal((await fixtureState.record()).feedback!.events.length, 1);
  });

  it('should discover and deliver existing feedback while assignment search is incomplete', async () => {
    await fixtureState.feedbackOwner();
    const check = await fixtureState.service.check(
      fixtureState.manifest,
      fixtureState.root,
      undefined,
      {
        status: 'blocked',
        changed: true,
        code: 'intake-search-incomplete',
      },
    );
    assert.equal(check.changed, true);
    assert.equal((await fixtureState.record()).feedback!.events.length, 1);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.ok((await fixtureState.record()).feedback!.events[0]!.turn);
  });

  it('should revalidate feedback independently of cached intake failures', async () => {
    await fixtureState.feedbackOwner();
    for (const code of [
      'intake-github-authentication',
      'intake-account-changed',
      'intake-automation-update-required',
    ]) {
      const check = await fixtureState.service.check(
        fixtureState.manifest,
        fixtureState.root,
        undefined,
        {
          status: 'blocked',
          changed: true,
          code,
        },
      );
      assert.equal(check.outcome, 'actionable');
      assert.equal((await fixtureState.record()).feedback?.events.length, 1);
    }
  });

  for (const readCost of [2000, 5000])
    it(`should preserve feedback and resume lifecycle work with ${readCost}ms reads`, async () => {
      await fixtureState.feedbackOwner();
      const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
      await current.store.exclusive(async (state, save) => {
        const original = state!.records[0]!;
        for (const number of [4, 5])
          state!.records.push({
            ...structuredClone(original),
            id: automationHash([
              state!.scope,
              original.repository.nodeId,
              `I_${number}`,
              `E_${number}`,
            ]),
            issue: { ...original.issue, number, nodeId: `I_${number}`, databaseId: number },
            assignment: { ...original.assignment, nodeId: `E_${number}`, databaseId: number },
          });
        await save(state!);
      });
      const admitted = (await current.store.read())!.records;
      await current.journal.exclusive(async (state, save) => {
        const owner = state.records[0]!;
        owner.lifecycleCheckedAt = 0;
        for (const admission of admitted.slice(1))
          state.records.push({
            id: admission.id,
            intakeId: admission.id,
            issueKey: issueKey(admission),
            sourceThreadId: owner.sourceThreadId,

            createdAt: owner.createdAt,
            manifestDigest: owner.manifestDigest,
            lifecycleCheckedAt: 0,
          });
        await save();
      });
      const realNow = Date.now;
      let wall = realNow();
      let connections = 0;
      const observedItems: number[] = [];
      const connect = fixtureState.service.dependencies.connect;
      fixtureState.service.dependencies.connect = async (...args) => {
        const client = await connect(...args);
        if (++connections > 1) return client;
        return {
          ...client,
          getRepository: async (...args) => {
            wall += readCost;
            return client.getRepository(...args);
          },
          getItem: async (owner, name, number) => {
            observedItems.push(number);
            wall += readCost;
            const item = await client.getItem(owner, name, number);
            const admission = admitted.find((r) => r.issue.number === number)!;
            return { ...item, ...admission.issue };
          },
        };
      };
      Date.now = () => wall;
      try {
        for (let pass = 0; pass < 3; pass++) {
          connections = 0;
          fixtureState.service.dependencies.now = () => baseline + 240_000 + pass * 60_000;
          const started = wall;
          await fixtureState.service.check(fixtureState.manifest, fixtureState.root, undefined, {
            status: 'ready',
            changed: false,
          });
          const owner = await fixtureState.record();
          assert.equal(owner.feedback?.events.length, 1);
          assert.equal(owner.feedback?.discoveryPending, false);
          assert.equal(owner.feedback?.scannedTime, fixtureState.service.dependencies.now());
          assert.notEqual(owner.feedback?.code, 'feedback-discovery-no-progress');
          const state = await current.journal.read();
          assert.equal(state.discoveryTimings?.lifecycleMs, wall - started);
          assert.equal(state.discoveryTimings?.feedbackMs, 0);
          assert.ok(wall - started < 20_000);
          if (pass === 0) assert.ok(state.records.some((record) => record.lifecyclePending));
        }
        assert.deepEqual([...new Set(observedItems)].sort(), [3, 4, 5]);
        assert.ok((await current.journal.read()).records.every((r) => r.lifecycleCheckedAt! > 0));
      } finally {
        Date.now = realNow;
      }
    });

  it('should inspect one saved feedback owner without provider reads or lifecycle changes', async () => {
    const { id } = await fixtureState.feedbackOwner();
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const before = await current.journal.read();
    fixtureState.service.dependencies.connect = async () => {
      throw new Error('unexpected provider read');
    };
    const result = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'inspect',
        target: 'owner/repo#3',
        limit: 1,
      },
      true,
    );
    assert.ok('records' in result);
    assert.equal(result.records.length, 1);
    const owner = result.records[0]!;
    assert.equal(owner.id, id);
    assert.equal(owner.lifecycleCheckedAt, before.records[0]!.lifecycleCheckedAt);
    assert.equal(owner.feedback?.scannedTime, before.records[0]!.feedback!.scannedTime);
    assert.equal(owner.feedback?.discoveryPending, false);
    assert.equal('events' in owner.feedback!, false);
    assert.deepEqual(await current.journal.read(), before);
    const missing = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'inspect',
        target: 'other/repo#3',
      },
      true,
    );
    assert.ok('records' in missing);
    assert.deepEqual(missing.records, []);
  });

  it('should allow a quiet empty intake check to finish after seven seconds without inspecting feedback', async () => {
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await current.store.exclusive(async (state, save) => {
      state!.records = [];
      await save(state!);
    });
    fixtureState.manifest.github!.notifications!.routing = ['!*/*'];
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    let clock = 0;
    let reads = 0;
    const manifests = fixtureState.fixtureIntake.dependencies.manifestService;
    const load = manifests.loadForAgentId.bind(manifests);
    manifests.loadForAgentId = async (...args) => {
      if (++reads === 1) clock += 8000;
      return load(...args);
    };
    fixtureState.service.dependencies.coordinator = async () => {
      assert.fail('an empty check has no conversation to inspect');
    };
    fixtureState.service.dependencies.feedbackConnect = async () => {
      assert.fail('an empty check has no feedback to inspect');
    };
    const budget = new DiscoveryBudget(20000, undefined, () => clock);
    const result = await openClawConditionCheck(
      (budget) =>
        fixtureState.service.check(
          fixtureState.manifest,
          fixtureState.root,
          undefined,
          undefined,
          undefined,
          budget,
        ),
      undefined,
      budget,
    );
    assert.equal(result.outcome, 'unchanged');
    const script = openclawIntakeJobs(fixtureState.manifest).find(
      (job) => job.id === 'github-issue-assignment',
    )!.internalOpenClaw!.trigger!.script;
    let fire: boolean | undefined;
    await runInNewContext('(async()=>{' + script + '})()', {
      agent_system_dispatch: async () => result,
      json: (value: { fire: boolean }) => {
        fire = value.fire;
      },
    });
    assert.equal(fire, false, 'the native condition must leave the model payload quiet');
    assert.equal(result.more, false);
    assert.equal('code' in result ? result.code : undefined, undefined);
    assert.equal((await current.journal.read()).records.length, 0);
    assert.equal(
      fixtureState.calls.some(
        ({ method }) => method === 'sessions.create' || method === 'chat.send',
      ),
      false,
    );
  });

  it('should refresh authority between checks and before committing a reused-context scan', async () => {
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const before = (await current.store.read())!.records;
    const manifests = fixtureState.fixtureIntake.dependencies.manifestService;
    const load = manifests.loadForAgentId.bind(manifests);
    let moved = false;
    manifests.loadForAgentId = async (...args) => {
      const loaded = await load(...args);
      return loaded.status === 'loaded' && moved
        ? { ...loaded, scope: { ...loaded.scope, workspaceDir: '/tmp' } }
        : loaded;
    };
    const discover = fixtureState.fixture.client.discoverAssigned;
    fixtureState.fixture.client.discoverAssigned = async (...args) => {
      const result = await discover(...args);
      moved = true;
      return result;
    };
    const result = await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.equal(result.code, 'intake-workspace-binding-changed');
    assert.deepEqual((await current.store.read())!.records, before);
    await assert.rejects(fixtureState.service.check(fixtureState.manifest, fixtureState.root), {
      code: 'intake-workspace-binding-changed',
    });
  });

  it('should return from a delayed scheduled readiness read and resume without losing or duplicating assignments', async () => {
    const intake = fixtureState.fixtureIntake;
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const before = await current.store.read();
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string | undefined>();
    const deadline = new AbortController();
    let clock = 0;
    let readSignal: AbortSignal | undefined;
    intake.dependencies.readiness = async (_manifest, _workspace, _id, _expected, signal) => {
      readSignal = signal;
      waiting.resolve();
      return release.promise;
    };
    const budget = new DiscoveryBudget(20000, deadline.signal, () => clock);
    const script = openclawIntakeJobs(fixtureState.manifest).find(
      (job) => job.id === 'github-issue-assignment',
    )!.internalOpenClaw!.trigger!.script;
    let output:
      | {
          fire: boolean;
          state: {
            outcome: string;
            more: boolean;
            diagnostic: { phase: string; elapsedMs: number };
          };
        }
      | undefined;
    const occurrence = runInNewContext('(async()=>{' + script + '})()', {
      agent_system_dispatch: () =>
        openClawConditionCheck(
          (budget) =>
            fixtureState.service.check(
              fixtureState.manifest,
              fixtureState.root,
              undefined,
              undefined,
              undefined,
              budget,
            ),
          undefined,
          budget,
        ),
      json: (value: typeof output) => {
        output = value;
      },
    });
    await waiting.promise;
    clock = 20000;
    deadline.abort();
    await occurrence;
    assert.equal(readSignal?.aborted, true);
    assert.equal(output!.fire, true);
    assert.equal(output!.state.outcome, 'failed');
    assert.equal(output!.state.more, true);
    assert.equal(output!.state.diagnostic.phase, 'automation-readiness');
    assert.equal(output!.state.diagnostic.elapsedMs, 20000);
    assert.deepEqual(await current.store.read(), before);
    release.resolve(undefined);
    await release.promise;
    assert.deepEqual(await current.store.read(), before);
    intake.dependencies.readiness = async () => undefined;
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    const complete = await current.store.read();
    assert.equal(complete!.records.length, 1);
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.deepEqual((await current.store.read())!.records, complete!.records);
    assert.equal(
      fixtureState.calls.some(
        (call) => call.method === 'sessions.create' || call.method === 'chat.send',
      ),
      false,
    );
  });

  it('should stop all discovery phases on caller cancellation', async () => {
    await fixtureState.feedbackOwner();
    const before = await fixtureState.record();
    const caller = new AbortController();
    caller.abort(new Error('caller-cancelled'));
    fixtureState.service.dependencies.connect = async () => {
      throw new Error('unexpected provider read');
    };
    await assert.rejects(
      fixtureState.service.check(fixtureState.manifest, fixtureState.root, caller.signal, {
        status: 'ready',
        changed: false,
      }),
      /caller-cancelled/,
    );
    assert.deepEqual((await fixtureState.record()).feedback, before.feedback);
  });

  it('should validate each feedback owner once during discovery and consume the saved result', async () => {
    await fixtureState.feedbackOwner();
    const validate = fixtureState.service.validate.bind(fixtureState.service);
    let validations = 0;
    fixtureState.service.validate = async (...args) => {
      validations++;
      return validate(...args);
    };
    const check = await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.equal(check.changed, true);
    assert.equal(validations, 1);
    assert.equal((await fixtureState.record()).feedback!.events.length, 1);
    const discovery = (await fixtureState.record()).feedback!.watermarks;
    assert.ok(discovery && Object.keys(discovery).length === 1);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events.length, 1);
  });

  it('should expose exhausted prerequisite budgets without claiming an attempted feedback read', async () => {
    await fixtureState.feedbackOwner(true, false);
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    fixtureState.service.dependencies.connect = async () => {
      throw new Error('no provider opportunity remains');
    };
    for (let poll = 0; poll < 3; poll++) {
      let clock = 0;
      const budget = new DiscoveryBudget(20000, undefined, () => clock);
      clock = 20000;
      await scanOpenClawFeedback({
        service: fixtureState.service,
        state: await current.journal.read(),
        manifest: fixtureState.manifest,
        workspace: fixtureState.root,
        sourceThreadId: fixtureState.coordinator.sessionKey,
        authority: {},
        now: fixtureState.service.dependencies.now!(),
        budget,
        checkpoint: (scan) => discoveryCheckpoint(current.journal, scan),
      });
    }
    const feedback = (await fixtureState.record()).feedback!;
    assert.equal(feedback.scannedTime, undefined);
    assert.equal(feedback.discoveryPending, true);
    assert.equal(feedback.code, 'feedback-discovery-no-progress');
    assert.equal(
      feedback.discoveryStalls![(await fixtureState.record()).id]!.operation,
      'occurrence-budget-before-feedback',
    );
  });

  it('should report repeated discovery interruptions and recover through the coordinator after restart', async () => {
    await fixtureState.feedbackOwner();
    const validate = fixtureState.service.validate.bind(fixtureState.service);
    for (let poll = 0; poll < 3; poll++) {
      const controller = new AbortController();
      fixtureState.service.validate = async (...args) => {
        const result = await validate(...args);
        controller.abort();
        return result;
      };
      const check = await fixtureState.service.check(
        fixtureState.manifest,
        fixtureState.root,
        controller.signal,
      );
      assert.ok('more' in check && check.more);
      assert.equal((await fixtureState.record()).feedback!.discoveryPending, true);
      if (poll === 0) {
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'report' },
        );
      }
      // reload the persisted journal through a new service, not a retained scan object.
      fixtureState.service = new OpenClawDispatch({ ...fixtureState.service.dependencies });
    }
    fixtureState.coordinator.runId = 'stalled-report';
    const report = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'report' },
    );
    assert.ok('response' in report && /feedback-discovery-no-progress/.test(report.response));
    fixtureState.service.validate = validate;
    // a recent incomplete attempt must not suppress the coordinator's bounded recovery.
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.discoveryPending, false);
    assert.equal((await fixtureState.record()).feedback!.events.length, 1);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events.length, 1);
    assert.ok((await fixtureState.record()).feedback!.events[0]!.turn);
  });

  for (const failure of ['none', 'provider', 'node', 'type', 'other-stall'] as const) {
    it(`should handle closed pr discovery with ${failure} while preserving feedback`, async () => {
      const unavailable = ['provider', 'node', 'type'].includes(failure);
      await fixtureState.feedbackOwner();
      const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
      await current.journal.exclusive(async (state, save) => {
        const owner = state.records[0]!;
        owner.pullRequestLink = { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 };
        owner.feedback!.baseline.PR_7 = {};
        owner.feedback!.watermarks = { ...owner.feedback!.watermarks, PR_7: baseline };
        owner.feedback!.discovery = {
          PR_7: {
            since: baseline,
            startedAt: baseline + 1,
            reads: { 'comments:1': JSON.stringify({ comments: [], truncated: false }) },
          },
          PR_other: { since: baseline, startedAt: baseline + 1, reads: {} },
        };
        owner.feedback!.discoveryStalls = {
          PR_7: { operation: 'source-validation', attempts: 3 },
          ...(failure === 'other-stall'
            ? { PR_other: { operation: 'comments', attempts: 3 } }
            : {}),
        };
        owner.feedback!.code = 'feedback-discovery-no-progress';
        await save();
      });
      const before = structuredClone((await fixtureState.record()).feedback!);
      const connect = fixtureState.service.dependencies.feedbackConnect!;
      const linked = { ...fixtureState.fixture, item: structuredClone(fixtureState.fixture.item) };
      fixturePullRequest(linked);
      Object.assign(linked.item, { nodeId: 'PR_7', number: 7, state: 'closed' });
      fixtureState.service.dependencies.feedbackConnect = async (...args) => {
        const provider = await connect(...args);
        return {
          ...provider,
          reviews: {
            listReviews: async () => ({ values: [], nextPage: 1 }),
            listComments: async () => ({ values: [], nextPage: 1 }),
            getReview: async () => {
              throw new Error('no reviews');
            },
            getComment: async () => {
              throw new Error('no review comments');
            },
            getReviewComments: async () => [],
          },
          getItem: async (owner, name, number) => {
            if (number !== 7) return provider.getItem(owner, name, number);
            if (failure === 'provider') throw new Error('feedback-provider-unavailable');
            return {
              ...linked.item,
              ...(failure === 'node' ? { nodeId: 'PR_foreign' } : {}),
              ...(failure === 'type' ? { itemType: 'issue' as const } : {}),
            };
          },
        };
      };
      for (let pass = 0; pass < 2; pass++) {
        await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
        const feedback = (await fixtureState.record()).feedback!;
        assert.equal(feedback.discovery?.PR_other, undefined);
        assert.equal(feedback.discoveryStalls?.PR_other, undefined);
        assert.deepEqual(feedback.baseline.PR_7, before.baseline.PR_7);
        assert.equal(feedback.watermarks?.PR_7, baseline);
        assert.equal(JSON.stringify(feedback.events), JSON.stringify(before.events));
        if (unavailable) {
          assert.deepEqual(feedback.discovery?.PR_7, before.discovery!.PR_7);
          assert.deepEqual(feedback.discoveryStalls?.PR_7, before.discoveryStalls!.PR_7);
        } else {
          assert.equal(feedback.discovery?.PR_7, undefined);
          assert.equal(feedback.discoveryStalls?.PR_7, undefined);
          assert.equal(feedback.code, undefined);
        }
      }
      if (!unavailable) {
        linked.item.state = 'open';
        await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
        const reopened = (await fixtureState.record()).feedback!;
        assert.ok(reopened.watermarks!.PR_7! > baseline);
        assert.equal(reopened.discovery?.PR_7, undefined);
      }
    });
  }

  it('should reject obsolete cleanup when a concurrent relink changes the selected source', async () => {
    await fixtureState.feedbackOwner(true, false);
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const cursor = { since: baseline, startedAt: baseline + 1, reads: { 'comments:1': '{}' } };
    await current.journal.exclusive(async (state, save) => {
      state.records[0]!.pullRequestLink = null;
      state.records[0]!.feedback!.discovery = { PR_old: cursor };
      await save();
    });
    const validate = fixtureState.service.validate.bind(fixtureState.service);
    fixtureState.service.validate = async (...args) => {
      const result = await validate(...args);
      await current.journal.exclusive(async (state, save) => {
        state.records[0]!.pullRequestLink = { pullRequestNodeId: 'PR_new', pullRequestNumber: 8 };
        state.records[0]!.feedback!.discovery!.PR_new = cursor;
        await save();
      });
      return result;
    };
    const scans = await scanOpenClawFeedback({
      service: fixtureState.service,
      state: await current.journal.read(),
      manifest: fixtureState.manifest,
      workspace: fixtureState.root,
      sourceThreadId: fixtureState.coordinator.sessionKey,
      authority: {},
      now: fixtureState.service.dependencies.now!(),
      checkpoint: (scan) => discoveryCheckpoint(current.journal, scan),
    });
    assert.equal(scans.length, 0);
    const owner = await fixtureState.record();
    assert.equal(owner.pullRequestLink?.pullRequestNodeId, 'PR_new');
    assert.deepEqual(owner.feedback!.discovery!.PR_new, cursor);
    assert.deepEqual(owner.feedback!.discovery!.PR_old, cursor);
  });

  it('should discover github feedback without a duplicate native activity poll', async () => {
    await fixtureState.feedbackOwner(true, false);
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    fixtureState.service.dependencies.credential.use = async () => {
      throw new Error('discovery must reuse lifecycle capacity observation');
    };
    const scans = await scanOpenClawFeedback({
      service: fixtureState.service,
      state: await current.journal.read(),
      manifest: fixtureState.manifest,
      workspace: fixtureState.root,
      sourceThreadId: fixtureState.coordinator.sessionKey,
      authority: {},
      now: fixtureState.service.dependencies.now!(),
      checkpoint: (scan) => discoveryCheckpoint(current.journal, scan),
    });
    assert.equal(scans.length, 1);
    assert.equal(scans[0]!.feedback.discoveryPending, false);
    assert.equal(scans[0]!.feedback.code, undefined);
    assert.equal(scans[0]!.feedback.events.length, 1);
  });

  it('should eventually serve each eligible feedback owner across bounded occurrences', async () => {
    await fixtureState.feedbackOwner(true, false);
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const original = structuredClone(await fixtureState.record());
    const validation = await fixtureState.service.validate(
      fixtureState.manifest,
      fixtureState.root,
      original,
      false,
      true,
    );
    const identities = [3, 4, 5].map((number) => ({
      number,
      id: number === 3 ? original.id : String(number).repeat(64),
      nodeId: `I_${number}`,
    }));
    await current.journal.exclusive(async (state, save) => {
      state.records = identities.map((source) => ({
        ...structuredClone(original),
        id: source.id,
        worktreeAttemptId: source.id,

        assessmentCaller: undefined,
        work: undefined,
        handoff: undefined,
        progression: undefined,
        issueKey: automationHash(['fixture', String(source.number)]),
        threadId: `fixture-${source.number}`,
        request: { ...original.request!, key: `fixture-${source.number}` },
        feedback: { startedAt: baseline, baseline: {}, events: [] },
      }));
      await save();
    });
    let clock = 0;
    const attempted: number[] = [];
    fixtureState.service.validate = async (_manifest, _workspace, owner) => {
      const source = identities.find((source) => source.id === owner.id)!;
      attempted.push(source.number);
      clock += 11000;
      return {
        ...validation,
        intake: {
          ...validation.intake,
          issue: { ...validation.intake.issue, nodeId: source.nodeId, number: source.number },
        },
      };
    };
    for (let pass = 0; pass < 4; pass++) {
      clock = 0;
      await scanOpenClawFeedback({
        service: fixtureState.service,
        state: await current.journal.read(),
        manifest: fixtureState.manifest,
        workspace: fixtureState.root,
        sourceThreadId: fixtureState.coordinator.sessionKey,
        authority: {},
        now: baseline + 240000 + pass * 1000,
        budget: new DiscoveryBudget(20000, undefined, () => clock),
        checkpoint: (scan) => discoveryCheckpoint(current.journal, scan),
      });
    }
    for (const source of identities) {
      const owner = (await current.journal.read()).records.find((owner) => owner.id === source.id)!;
      assert.ok(
        owner.feedback!.watermarks?.[source.nodeId],
        `owner ${source.number} must complete a source scan`,
      );
      assert.equal(owner.feedback!.events.length, 1);
    }
    assert.deepEqual([...new Set(attempted)].sort(), [3, 4, 5]);
  });

  it('should clear a record budget boundary only after a real successful next occurrence', async () => {
    await fixtureState.feedbackOwner(true, false);
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const initial = structuredClone((await fixtureState.record()).feedback!);
    let clock = 0;
    const budget = new DiscoveryBudget(20000, undefined, () => clock);
    clock = 20000;
    await scanOpenClawFeedback({
      service: fixtureState.service,
      state: await current.journal.read(),
      manifest: fixtureState.manifest,
      workspace: fixtureState.root,
      sourceThreadId: fixtureState.coordinator.sessionKey,
      authority: {},
      now: fixtureState.service.dependencies.now!(),
      budget,
      checkpoint: (scan) => discoveryCheckpoint(current.journal, scan),
    });
    const blocked = (await fixtureState.record()).feedback!;
    assert.equal(blocked.scannedTime, initial.scannedTime);
    assert.equal(blocked.discoveryPending, true);
    assert.equal(
      blocked.discoveryStalls![(await fixtureState.record()).id]!.operation,
      'occurrence-budget-before-feedback',
    );
    fixtureState.service = new OpenClawDispatch({ ...fixtureState.service.dependencies });
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    const completed = (await fixtureState.record()).feedback!;
    assert.equal(completed.discoveryPending, false);
    assert.equal(completed.discoveryStalls?.[(await fixtureState.record()).id], undefined);
    assert.equal(completed.events.length, 1);
    assert.equal(completed.code, undefined);
  });

  for (const association of ['relinked', 'unlinked'] as const) {
    it(`should discard ${association} pr scratch durably without querying the old source`, async () => {
      await fixtureState.feedbackOwner();
      const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
      await current.journal.exclusive(async (state, save) => {
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
        owner.feedback!.discoveryStalls = { PR_7: { operation: 'source-validation', attempts: 3 } };
        owner.feedback!.code = 'feedback-discovery-no-progress';
        await save();
      });
      const before = structuredClone((await fixtureState.record()).feedback!);
      const connect = fixtureState.service.dependencies.feedbackConnect!;
      const linked = { ...fixtureState.fixture, item: structuredClone(fixtureState.fixture.item) };
      fixturePullRequest(linked);
      Object.assign(linked.item, { nodeId: 'PR_8', number: 8, state: 'closed' });
      const sourceReads: number[] = [];
      fixtureState.service.dependencies.feedbackConnect = async (...args) => {
        const provider = await connect(...args);
        return {
          ...provider,
          getItem: async (owner, name, number) => {
            sourceReads.push(number);
            assert.notEqual(number, 7, 'deselected source must not need a closure read');
            return number === 8 ? linked.item : provider.getItem(owner, name, number);
          },
        };
      };
      for (let pass = 0; pass < 2; pass++) {
        fixtureState.service = new OpenClawDispatch({ ...fixtureState.service.dependencies });
        await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
        const feedback = (await fixtureState.record()).feedback!;
        assert.equal(feedback.discovery?.PR_7, undefined);
        assert.equal(feedback.discoveryStalls?.PR_7, undefined);
        assert.equal(feedback.code, undefined);
        assert.equal(feedback.discoveryPending, false);
        assert.deepEqual(feedback.baseline.PR_7, before.baseline.PR_7);
        assert.equal(feedback.watermarks?.PR_7, baseline);
        assert.deepEqual(feedback.events, before.events);
      }
      assert.equal(sourceReads.includes(8), association === 'relinked');
    });
  }

  it('should rotate issue and pr discovery, report the stalled pr read, and admit its exact source once', async () => {
    const { comments } = await fixtureState.feedbackOwner(true, false);
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await current.journal.exclusive(async (state, save) => {
      const owner = state.records[0]!;
      owner.delivery = {
        id: 'd'.repeat(64),
        title: 'Delivery',
        body: 'Closes #3',
        creationAttempted: true,
        reconciled: true,
        pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
        binding: {
          repositoryId: fixtureState.fixture.repository.nodeId,
          issueId: fixtureState.fixture.item.nodeId,
          threadId: owner.threadId!,
          sessionId: owner.sessionCreation!.sessionId!,
          worktree: owner.worktree!,
          branch: 'issue-3',
          base: 'main',
          head: 'a'.repeat(40),
          authorId: fixtureState.fixture.client.identity.nodeId,
        },
      };
      await save();
    });
    let paused = true;
    const reads: number[] = [];
    const connect = fixtureState.service.dependencies.feedbackConnect!;
    fixtureState.service.dependencies.feedbackConnect = async (...args) => ({
      ...(await connect(...args)),
      getItem: async (_o, _n, number) =>
        number === 7
          ? {
              ...fixtureState.fixture.item,
              nodeId: 'PR_7',
              number: 7,
              itemType: 'pull-request',
              pullRequest: {
                baseRef: 'main',
                baseRepositoryDatabaseId: fixtureState.fixture.repository.databaseId,
                baseRepositoryNodeId: fixtureState.fixture.repository.nodeId,
                draft: false,
                headRef: 'issue-3',
                headSha: 'a'.repeat(40),
                merged: false,
              },
            }
          : fixtureState.fixture.item,
      listIssueComments: async (_o, _n, number) => {
        reads.push(number);
        if (number === 7 && paused) throw new DiscoveryPaused();
        return { comments: number === 7 ? comments : [], truncated: false };
      },
      reviews: {
        listReviews: async () => ({ values: [], nextPage: 1 }),
        listComments: async () => ({ values: [], nextPage: 1 }),
        getReview: async () => {
          throw new Error('no reviews');
        },
        getComment: async () => {
          throw new Error('no review comments');
        },
        getReviewComments: async () => [],
      },
    });
    for (let poll = 0; poll < 3; poll++) {
      await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
      fixtureState.service = new OpenClawDispatch({ ...fixtureState.service.dependencies });
    }
    assert.deepEqual(reads, [3, 7, 7, 3, 7]);
    assert.equal((await fixtureState.record()).feedback!.code, undefined);
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    const stalled = (await fixtureState.record()).feedback!;
    assert.equal(stalled.discovery!.PR_7!.reads.comments, undefined);
    for (const endpoint of ['reviews:1', 'review-comments:1'])
      assert.deepEqual(JSON.parse(stalled.discovery!.PR_7!.reads[endpoint]!), {
        values: [],
        nextPage: 1,
      });
    assert.equal(stalled.watermarks?.PR_7, undefined);
    assert.equal(stalled.discoveryStalls!.PR_7!.operation, 'comments');
    assert.equal(stalled.code, 'feedback-discovery-no-progress');
    fixtureState.coordinator.runId = 'pr-obstacle';
    const report = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'report' },
    );
    assert.ok('response' in report && report.response.includes('owner/repo/pull/7'));
    const before = reads.length;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const after = reads.length;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.ok(after > before);
    assert.equal(reads.length, after, 'one bounded recovery scan per native run');
    fixtureState.coordinator.runId = 'same-pr-obstacle';
    const unchanged = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'report' },
    );
    assert.ok('response' in unchanged && unchanged.response === '');
    paused = false;
    fixtureState.coordinator.runId = 'pr-recovery';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const event = (await fixtureState.record()).feedback!.events[0]!;
    assert.equal(event.sourceId, comments[0]!.nodeId);
    assert.equal(event.nodeId, 'PR_7');
    assert.equal(event.itemType, 'pull-request');
    assert.deepEqual(JSON.parse(event.source), comments[0]);
    assert.ok(event.turn);
    assert.equal((await fixtureState.record()).feedback!.code, undefined);
    const recovery = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'report' },
    );
    assert.ok(
      'response' in recovery && recovery.response.includes('feedback-discovery-no-progress'),
    );
    fixtureState.coordinator.runId = 'healthy-pr-report';
    const healthy = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'report' },
    );
    assert.ok('response' in healthy && healthy.response === '');
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events.length, 1);
    assert.equal((await fixtureState.record()).feedback!.events[0]!.turn!.runId, event.turn.runId);
  });

  it('should continue feedback discovery for another owner after an unrelated identity failure', async () => {
    await fixtureState.assignments(2, 2);
    const first = await fixtureState.next();
    await fixtureState.prepare(first);
    await fixtureState.assess(first.id);
    const second = await fixtureState.next();
    await fixtureState.prepare(second);
    await fixtureState.assess(second.id);
    await fixtureState.completeAssessment(first.id);
    await fixtureState.completeAssessment(second.id);
    fixtureState.manifest.github!.notifications!.issueAssignment!.feedback = {
      inherit: true,
      allowed: [],
    };
    const validate = fixtureState.service.validate.bind(fixtureState.service);
    fixtureState.service.validate = async (...args) => {
      if (args[2].id === first.id) throw new Error('dispatch-issue-identity-changed');
      return validate(...args);
    };
    const source: GitHubCanonicalIssueComment = {
      nodeId: 'C_sibling',
      databaseId: 123,
      author: fixtureState.fixture.client.identity,
      body: '@receiver explain this',
      bodyTruncated: false,
      createdAt: '2026-10-07T10:03:00Z',
      updatedAt: '2026-10-07T10:03:00Z',
    };
    const connect = fixtureState.service.dependencies.feedbackConnect!;
    fixtureState.service.dependencies.feedbackConnect = async (...args) => ({
      ...(await connect(...args)),
      listIssueComments: async () => ({ comments: [source], truncated: false }),
      getIssueComment: async () => source,
    });
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await current.journal.exclusive(async (state, save) => {
      for (const owner of state.records)
        owner.feedback = { startedAt: baseline, baseline: {}, events: [] };
      await save();
    });
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    const state = await current.journal.read();
    assert.equal(
      state.records.find((r) => r.id === first.id)!.feedback!.code,
      'dispatch-issue-identity-changed',
    );
    const sibling = state.records.find((r) => r.id === second.id)!;
    assert.equal(sibling.feedback!.discoveryPending, false);
    assert.equal(sibling.feedback!.events[0]!.sourceId, source.nodeId);
    fixtureState.coordinator.runId = 'sibling-feedback';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const fresh = (await current.journal.read()).records.find((r) => r.id === second.id)!;
    assert.ok(fresh.feedback!.events[0]!.turn);
  });

  it('should reactivate scoped feedback even when assignment membership was checked recently', async () => {
    const { comments } = await fixtureState.feedbackOwner(false);
    const comment = comments.pop()!;
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    const before = await fixtureState.record();
    fixtureState.fixture.item.assignees = [];
    fixtureState.fixture.events.push({
      ...fixtureState.fixture.events[0]!,
      nodeId: 'removed',
      databaseId: 31,
      event: 'unassigned',
      createdAt: new Date(fixtureState.service.dependencies.now!()).toISOString(),
    });
    comments.push({
      ...comment,
      createdAt: new Date(fixtureState.service.dependencies.now!() + 1000).toISOString(),
      updatedAt: new Date(fixtureState.service.dependencies.now!() + 1000).toISOString(),
    });
    const now = fixtureState.service.dependencies.now!() + 2000;
    fixtureState.service.dependencies.now = () => now;
    const intake = fixtureState.fixtureIntake;
    const selector = { repository: 'owner/repo', itemType: 'issue' as const, number: 3 };
    const observation = await intake.run(
      fixtureState.manifest,
      fixtureState.root,
      'scan',
      (await intake.select(fixtureState.manifest, fixtureState.root)).selected!.digest,
      undefined,
      selector,
    );
    await fixtureState.service.check(
      fixtureState.manifest,
      fixtureState.root,
      undefined,
      observation,
      { ...selector, number: 4 },
    );
    assert.equal((await fixtureState.record()).lifecycleCheckedAt, before.lifecycleCheckedAt);
    assert.equal((await fixtureState.record()).feedbackReactivation, undefined);
    await fixtureState.service.check(
      fixtureState.manifest,
      fixtureState.root,
      undefined,
      observation,
      selector,
    );
    const after = await fixtureState.record();
    assert.equal(after.retirement, undefined);
    assert.equal(after.feedbackReactivation?.assignmentEventId, 'removed');
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.feedback?.events[0]?.sourceId, comment.nodeId);
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should discover new feedback on a scoped refresh despite a recent empty discovery', async () => {
    const { comments } = await fixtureState.feedbackOwner(true, false);
    const comment = comments.pop()!;
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    comments.push(comment);
    // reproduces the old selected-refresh path: next consumes the cached empty discovery.
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        )
      ).status,
      'idle',
    );
    assert.equal((await fixtureState.record()).feedback!.events.length, 0);
    const intake = fixtureState.fixtureIntake;
    const observation = await intake.run(
      fixtureState.manifest,
      fixtureState.root,
      'scan',
      (await intake.select(fixtureState.manifest, fixtureState.root)).selected!.digest,
      undefined,
      { repository: 'owner/repo', itemType: 'issue', number: 3 },
    );
    const run = intake.run.bind(intake);
    intake.run = async () => {
      throw new Error('scoped feedback discovery must not scan other assignments');
    };
    try {
      await fixtureState.service.check(
        fixtureState.manifest,
        fixtureState.root,
        undefined,
        observation,
      );
    } finally {
      intake.run = run;
    }
    fixtureState.coordinator.runId = 'fresh-feedback-run';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const events = (await fixtureState.record()).feedback!.events;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.sourceId, comment.nodeId);
    assert.ok(events[0]!.turn);
  });

  for (const consumed of [false, true])
    it(`should return provider evidence and preserve ${consumed ? 'completed' : 'unfinished'} feedback delivery`, async () => {
      const { id } = await fixtureState.feedbackOwner();
      fixtureState.consumeSend = consumed;
      await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      const event = (await fixtureState.record()).feedback!.events[0]!;
      assert.ok(event.turn);
      fixtureState.service.dependencies.feedbackConnect = async () => {
        throw Object.assign(new Error('github-delivery-github-request'), {
          providerDiagnostic: providerDiagnostic('github', 'api-request', 'transport', {
            httpStatus: 500,
          }),
        });
      };
      const result = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.assessor(id, event.turn.runId),
        {
          action: 'feedback',
          operation: 'context',
          id,
          eventId: event.id,
        },
      );
      assert.equal(result.status, 'retrying');
      assert.ok('providerDiagnostic' in result);
      assert.equal(result.providerDiagnostic?.httpStatus, 500);
      assert.equal(result.providerDiagnostic?.classification, 'transport');
      const retained = (await fixtureState.record()).feedback!.events[0]!;
      if (consumed) assert.deepEqual(retained, event);
      else assert.equal(retained.providerDiagnostic?.httpStatus, 500);
    });

  it('should enable feedback on a handed-off owner without changing historical assessment authority', async () => {
    const { id } = await fixtureState.feedbackOwner();
    fixtureState.consumeSend = true;
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      true,
    );
    assert.equal((await fixtureState.record()).feedback!.events.length, 1);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const event = (await fixtureState.record()).feedback!.events[0]!;
    assert.ok(event.turn);
    assert.equal(fixtureState.creates().length, 1);
    const who = fixtureState.assessor(id, event.turn.runId);
    const context = await fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, {
      action: 'feedback',
      operation: 'context',
      id,
      eventId: event.id,
    });
    assert.equal(context.status, 'verified');
    for (const action of ['context', 'implementation-context'] as const)
      assert.equal(
        (
          await fixtureState.service.run(
            fixtureState.manifest,
            fixtureState.root,
            who,
            { action, id },
            false,
          )
        ).status,
        'verified',
      );
    const clarification = {
      outcome: 'clarification-needed' as const,
      summary: 'Need a value.',
      fullResult: 'Partial feedback work retained.',
      questions: ['Which value?'],
    };
    const completed = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      who,
      {
        action: 'implementation-result',
        id,
        implementationResult: clarification,
      },
    );
    assert.equal(completed.status, 'native');
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should use the native followup queue during operator work without interrupting it', async () => {
    await fixtureState.feedbackOwner();
    fixtureState.active = true;
    const before = fixtureState.sends().length;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events[0]!.phase, 'running');
    assert.equal(fixtureState.sends().length, before + 1);
    assert.equal(fixtureState.sends().at(-1)!.params.queueMode, 'followup');
    assert.equal(
      fixtureState.calls.some((entry) => entry.method === 'chat.abort'),
      false,
    );
  });

  it('should never report a refused native feedback send as delivered', async () => {
    await fixtureState.feedbackOwner();
    await fixtureState.acknowledgeReport();
    fixtureState.onSend = () => {
      throw new GatewayClientRequestError({ code: 'FORBIDDEN', message: 'native send refused' });
    };
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const event = (await fixtureState.record()).feedback!.events[0]!;
    assert.notEqual(event.phase, 'delivered');
    const report = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'denied-feedback-report' },
      { action: 'report' },
    );
    assert.ok('response' in report);
    assert.doesNotMatch(report.response, /Feedback delivered to chat/);
    assert.equal((await fixtureState.record()).feedback!.events[0]!.intakeReportedAt, undefined);
  });
  it('should report a verified feedback delivery once across report retries and fixtureState.service restart', async () => {
    await fixtureState.feedbackOwner();
    await fixtureState.acknowledgeReport();
    fixtureState.consumeSend = true;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const delivered = (await fixtureState.record()).feedback!.events[0]!;
    assert.equal(delivered.phase, 'delivered');
    assert.equal(delivered.intakeReportedAt, undefined);
    const before = fixtureState.sends().length;
    const caller = { ...fixtureState.coordinator, runId: 'delivery-report' };
    const first = await fixtureState.service.run(fixtureState.manifest, fixtureState.root, caller, {
      action: 'report',
    });
    assert.ok('response' in first);
    assert.match(
      first.response,
      /Feedback delivered to chat:.*owner\/repo#3.*\/chat\/receiver\/dashboard\/agent-system-issue-[a-f0-9]{64}.*1 item/,
    );
    assert.ok((await fixtureState.record()).feedback!.events[0]!.intakeReportedAt !== undefined);
    const retry = await fixtureState.service.run(fixtureState.manifest, fixtureState.root, caller, {
      action: 'report',
    });
    assert.ok('response' in retry);
    assert.equal(retry.response, first.response);
    fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    const repeated = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...caller, runId: 'quiet-report' },
      { action: 'report' },
    );
    assert.ok('response' in repeated);
    assert.equal(repeated.response, '');
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal(fixtureState.sends().length, before);
  });
  it('should stop reconciling consumed feedback while native conversation remains active', async () => {
    await fixtureState.feedbackOwner();
    fixtureState.consumeSend = true;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const saved = await fixtureState.record();
    const event = saved.feedback!.events[0]!;
    assert.equal(event.phase, 'delivered');
    assert.equal(event.turn!.status, 'consumed');
    assert.equal(event.turn!.executionRunId, undefined);
    assert.equal(saved.nativeInactive, false);
    assert.equal(openClawCapacity([saved], 1).occupied, 1);
    const before = fixtureState.sends().length;
    const nativeCalls = fixtureState.calls.length;
    fixtureState.historyRejected = true;
    fixtureState.coordinator.runId = 'after-delivery';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.deepEqual((await fixtureState.record()).feedback!.events[0], event);
    assert.equal(fixtureState.sends().length, before);
    assert.equal(
      fixtureState.calls
        .slice(nativeCalls)
        .some((call) => call.method === 'agent.wait' && call.params.runId === event.turn!.runId),
      false,
    );
  });

  it('should preserve delivered feedback across source edits and reject stale context without blocking recovery', async () => {
    const { id, comments } = await fixtureState.feedbackOwner();
    fixtureState.consumeSend = true;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const original = structuredClone((await fixtureState.record()).feedback!.events[0]!);
    assert.equal(original.phase, 'delivered');
    comments[0]!.body = '@receiver revised question';
    comments[0]!.updatedAt = '2026-10-07T10:04:00Z';
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    const events = (await fixtureState.record()).feedback!.events;
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], original);
    assert.equal(pendingRecoveryFeedback(events[0]!), false);
    assert.equal(pendingRecoveryFeedback(events[1]!), true);
    const stale = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.assessor(id, original.turn!.runId),
      {
        action: 'feedback',
        operation: 'context',
        id,
        eventId: original.id,
      },
    );
    assert.equal(stale.status, 'blocked');
    assert.equal('code' in stale && stale.code, 'feedback-source-changed');
    assert.deepEqual((await fixtureState.record()).feedback!.events[0], original);
    fixtureState.coordinator.runId = 'edited-feedback-run';
    const before = fixtureState.sends().length;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal(fixtureState.sends().length, before + 1);
    const delivered = (await fixtureState.record()).feedback!.events;
    assert.equal(delivered.length, 2);
    assert.deepEqual(delivered[0], original);
    assert.equal(delivered.some(pendingRecoveryFeedback), false);
  });

  it('should reject an edited source before admitting it to the native queue', async () => {
    const { comments } = await fixtureState.feedbackOwner();
    const before = fixtureState.sends().length;
    comments[0]!.body = 'mention removed';
    fixtureState.coordinator.runId = 'source-revocation-poll';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events[0]!.phase, 'blocked');
    assert.equal(fixtureState.sends().length, before);
    const event = (await fixtureState.record()).feedback!.events[0]!;
    assert.equal(event.turn, undefined);
    assert.equal(pendingRecoveryFeedback(event), false);
  });

  it('should deliver a different eligible comment while an older feedback receipt is unresolved', async () => {
    await fixtureState.feedbackOwner();
    const scope = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    let queuedId: string | undefined;
    await scope.journal.exclusive(async (state, save) => {
      const events = state.records[0]!.feedback!.events;
      queuedId = events[0]!.id;
      events.unshift({
        ...structuredClone(events[0]!),
        id: 'f'.repeat(64),
        phase: 'prepared',
        turn: {
          runId: `${state.records[0]!.id}:feedback:${'f'.repeat(64)}`,
          message: 'Older feedback input.',
          status: 'attempted',
        },
      });
      await save();
    });
    const before = fixtureState.sends().length;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const events = (await fixtureState.record()).feedback!.events;
    assert.equal(events.find((event) => event.id === queuedId)?.phase, 'running');
    assert.equal(
      events.find((event) => event.id === 'f'.repeat(64))?.turn?.runId,
      `${(await fixtureState.record()).id}:feedback:${'f'.repeat(64)}`,
    );
    assert.equal(fixtureState.sends().length, before + 1);
  });

  it('should reconcile an uncertain feedback send after restart without sending twice', async () => {
    await fixtureState.feedbackOwner();
    fixtureState.loseSend = true;
    const before = fixtureState.sends().length;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events[0]!.turn?.status, 'attempted');
    const report = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'uncertain-report' },
      { action: 'report' },
    );
    assert.ok('response' in report);
    assert.doesNotMatch(report.response, /Feedback delivered to chat/);
    assert.equal((await fixtureState.record()).feedback!.events[0]!.intakeReportedAt, undefined);
    fixtureState.loseSend = false;
    fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events[0]!.turn?.status, 'accepted');
    assert.equal(fixtureState.sends().length, before + 1);
  });

  it('should retain admitted feedback after its policy defaults change without resending', async () => {
    await fixtureState.feedbackOwner();
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events[0]!.phase, 'running');
    const before = fixtureState.sends().length;
    fixtureState.manifest.github!.notifications!.intervalMinutes += 1;
    fixtureState.manifest.github!.notifications!.maxConcurrentItems += 1;
    fixtureState.config.plugins = {
      entries: { 'agent-system': { config: { cleanup: { graceMinutes: 30 } } } },
    };
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events[0]!.phase, 'running');
    fixtureState.manifest.github!.notifications!.issueAssignment!.allowed = [
      ...fixtureState.manifest.github!.notifications!.issueAssignment!.allowed,
      { login: 'another', nodeId: 'U_another' },
    ];
    await fixtureState.service.dependencies.intake.run(
      fixtureState.manifest,
      fixtureState.root,
      'activate',
    );
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const saved = await fixtureState.record();
    assert.equal(saved.feedback!.events[0]!.code, undefined);
    assert.equal(saved.feedback!.events[0]!.phase, 'running');
    assert.equal(openClawCapacity([saved], 1).available, 0);
    fixtureState.active = false;
    fixtureState.inputReceipts = [];
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal((await fixtureState.record()).feedback!.events[0]!.phase, 'delivered');
    assert.equal(fixtureState.sends().length, before);
  });

  for (const limit of [1, 3])
    for (const olderAssignment of [true, false]) {
      it(`should deliver feedback independently of ${olderAssignment ? 'older' : 'newer'} assignment admission with limit ${limit}`, async () => {
        fixtureState.manifest.github!.notifications!.maxConcurrentItems = limit;
        await fixtureState.service.dependencies.intake.run(
          fixtureState.manifest,
          fixtureState.root,
          'activate',
        );
        await fixtureState.feedbackOwner();
        const { store } = await fixtureState.fixtureIntake.select(
          fixtureState.manifest,
          fixtureState.root,
        );
        const createdAt = olderAssignment ? '2026-10-07T10:01:30Z' : '2026-10-07T10:04:00Z';
        const other = {
          ...fixtureState.fixture.item,
          nodeId: 'I_other',
          databaseId: 21,
          number: 4,
        };
        const assignment = {
          ...fixtureState.fixture.events[0]!,
          nodeId: 'E_other',
          databaseId: 31,
          createdAt,
        };
        const getItem = fixtureState.fixture.client.getItem;
        fixtureState.fixture.client.getItem = async (owner, name, number) =>
          number === 4 ? other : getItem(owner, name, number);
        fixtureState.fixture.client.listAssignmentEvents = async (_owner, _name, number) => ({
          events: number === 4 ? [assignment] : fixtureState.fixture.events,
          truncated: false,
        });
        await store.exclusive(async (state, save) => {
          state!.records.push({
            ...state!.records[0]!,
            id: automationHash([
              state!.scope,
              state!.records[0]!.repository.nodeId,
              other.nodeId,
              assignment.nodeId,
            ]),
            issue: { nodeId: other.nodeId, databaseId: other.databaseId, number: other.number },
            assignment: { ...assignment, event: 'assigned' },
          });
          await save(state!);
        });
        const selected = await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        );
        assert.equal(selected.status, limit === 3 ? 'routing-required' : 'at-capacity');
        assert.ok((await fixtureState.record()).feedback!.events[0]!.turn);
        if (limit === 3) {
          // resume the same native occurrence with its saved mixed-work snapshot.
          fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
          const second = await fixtureState.service.run(
            fixtureState.manifest,
            fixtureState.root,
            fixtureState.coordinator,
            { action: 'next' },
          );
          assert.equal(second.status, 'pass-completed');
          assert.equal(
            (
              await fixtureState.service.run(
                fixtureState.manifest,
                fixtureState.root,
                fixtureState.coordinator,
                { action: 'next' },
              )
            ).status,
            'pass-completed',
          );
          const state = await (
            await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
          ).journal.read();
          const pass = state.openclawPasses!.find(
            (entry) => entry.runId === fixtureState.coordinator.runId,
          )!;
          assert.equal(pass.candidates.length, 1);
          assert.equal(new Set(pass.selected).size, 1);
        }
      });
    }

  it('should discard a stale provider snapshot without holding the journal during discovery', async () => {
    await fixtureState.feedbackOwner();
    fixtureState.active = true;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const connect = fixtureState.service.dependencies.feedbackConnect!;
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    fixtureState.service.dependencies.feedbackConnect = async (...args) => {
      const provider = await connect(...args);
      const list = provider.listIssueComments;
      provider.listIssueComments = async (...parameters) => {
        started.resolve();
        await released.promise;
        return list(...parameters);
      };
      return provider;
    };
    fixtureState.coordinator.runId = 'concurrent-discovery-poll';
    const scan = fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    await started.promise;
    const { journal } = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await journal.exclusive(async (state, save) => {
      const event = state.records[0]!.feedback!.events[0]!;
      event.phase = 'blocked';
      event.code = 'test-concurrent-revocation';
      await save();
    });
    released.resolve();
    await scan;
    assert.equal(
      (await fixtureState.record()).feedback!.events[0]!.code,
      'test-concurrent-revocation',
    );
  });

  it('should refuse reconciliation as a way to create an unattempted feedback send', async () => {
    await fixtureState.feedbackOwner();
    fixtureState.active = true;
    const event = (await fixtureState.record()).feedback!.events[0]!;
    await assert.rejects(
      fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        {
          action: 'feedback',
          operation: 'reconcile',
          source: feedbackTarget(
            `${fixtureState.fixture.repository.owner.login}/${fixtureState.fixture.repository.name}`,
            event,
          ),
        },
      ),
      /feedback-send-unverified/,
    );
    assert.equal(event.turn, undefined);
  });

  it('should preserve the feedback baseline through initial routing and native creation', async () => {
    fixtureState.manifest.github!.notifications!.issueAssignment!.feedback = {
      inherit: true,
      allowed: [],
    };
    await fixtureState.service.dependencies.intake.run(
      fixtureState.manifest,
      fixtureState.root,
      'activate',
    );
    const input = await fixtureState.next();
    const baseline = (await fixtureState.record()).feedback?.startedAt;
    assert.equal(typeof baseline, 'number');
    assert.equal((await fixtureState.prepare(input)).status, 'session-created');
    assert.equal((await fixtureState.record()).feedback?.startedAt, baseline);
    assert.deepEqual((await fixtureState.record()).feedback?.events, []);
  });
});
