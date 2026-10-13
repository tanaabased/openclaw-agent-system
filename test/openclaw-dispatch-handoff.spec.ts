import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import OpenClawDispatchStore, {
  type OpenClawDispatchRecord,
} from '../agent/openclaw-dispatch-state.ts';
import OpenClawDispatchHandoff, {
  type DispatchCaller,
  type DispatchSession,
} from '../agent/openclaw-dispatch-handoff.ts';
import dispatchCapacity from '../agent/dispatch-capacity.ts';

describe('agent/OpenClaw native dispatch handoff', () => {
  let root: string;
  let store: OpenClawDispatchStore;
  let record: OpenClawDispatchRecord;
  let session: DispatchSession;
  let handoff: OpenClawDispatchHandoff;
  let authorized: boolean;
  const coordinator: DispatchCaller = {
    sessionKey: 'agent:receiver:automation:intake',
    sessionId: 'source-incarnation',
    runId: 'coordinator-turn',
    toolCallId: 'creation-call',
  };
  const child: DispatchCaller = {
    sessionKey: 'agent:receiver:issue:1',
    sessionId: 'child-incarnation',
    runId: 'assessment-turn',
    toolCallId: 'context-call',
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openclaw-handoff-'));
    store = new OpenClawDispatchStore(root, 'b'.repeat(64));
    record = {
      id: 'a'.repeat(64),
      intakeId: 'c'.repeat(64),
      issueKey: 'd'.repeat(64),
      sourceThreadId: coordinator.sessionKey,
      phase: 'creating',
      createdAt: 1,
      manifestDigest: 'manifest',
      context: '{}',
      routing: JSON.stringify({
        candidate: { status: 'mapped', model: 'provider/worker', thinking: 'high' },
      }),
      routingNote: 'selected, not executed',
      worktree: '/worktree',
      request: {
        runtime: 'subagent',
        visible: true,
        cleanup: 'keep',
        cwd: '/worktree',
        label: '#1: ASSESS',
        task: 'Setup only',
        model: 'provider/worker',
      },
    };
    session = {
      sessionKey: child.sessionKey,
      sessionId: child.sessionId,
      parentSessionKey: coordinator.sessionKey,
      parentSessionId: coordinator.sessionId,
      cwd: '/worktree',
      model: 'provider/worker',
      effort: 'medium',
    };
    authorized = true;
    handoff = new OpenClawDispatchHandoff(store, {
      read: async () => structuredClone(session),
      validate: async () => {
        if (!authorized) throw new Error('assignment-revoked');
      },
    });
    await store.exclusive(async (state, save) => {
      state.records.push(record);
      await save();
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function create() {
    await handoff.claimCreation(record.id, coordinator, record.request);
    await handoff.observeCreation(record.id, coordinator, {
      sessionKey: child.sessionKey,
      runId: 'setup-turn',
    });
  }
  async function setup() {
    await create();
    await handoff.observeSetupEnd(record.id, { ...child, runId: 'setup-turn' }, true);
  }
  async function continueAssessment() {
    await setup();
    session.effort = 'high';
    const next = await handoff.reconcile(record.id, coordinator.sessionKey, 5);
    assert.equal(next.status, 'continuation-required');
    if (next.status !== 'continuation-required') throw Error('missing request');
    const who = { ...coordinator, toolCallId: 'continue-call' };
    await handoff.claimContinuation(record.id, who, next.request);
    await handoff.observeContinuation(record.id, who, child.runId);
    return { next, who };
  }
  it('should require a completed setup turn and native model/effort readback before continuation', async () => {
    await create();
    assert.equal(
      (await handoff.reconcile(record.id, coordinator.sessionKey, 2)).status,
      'setup-pending',
    );
    await assert.rejects(handoff.observeSetupEnd(record.id, child, true), /setup-turn-mismatch/);
    await handoff.observeSetupEnd(record.id, { ...child, runId: 'setup-turn' }, true);
    const settings = await handoff.reconcile(record.id, coordinator.sessionKey, 3);
    assert.equal(settings.status, 'settings-required');
    assert.equal((await store.read()).records[0]!.effective, undefined);
    session.effort = 'high';
    const next = await handoff.reconcile(record.id, coordinator.sessionKey, 4);
    assert.equal(next.status, 'continuation-required');
    assert.equal((await store.read()).records[0]!.execution, undefined);
    assert.equal(
      (await handoff.reconcile(record.id, coordinator.sessionKey, 5)).status,
      'continuation-pending',
    );
  });
  it('should consume creation once and retain an uncertain effect and capacity across restart', async () => {
    await handoff.claimCreation(record.id, coordinator, record.request);
    const restarted = new OpenClawDispatchHandoff(
      new OpenClawDispatchStore(root, store.scope),
      handoff.host,
    );
    await assert.rejects(
      restarted.claimCreation(record.id, coordinator, record.request),
      /creation-not-authorized/,
    );
    await assert.rejects(
      restarted.reconcile(record.id, coordinator.sessionKey, 2),
      /native-receipt-missing/,
    );
    assert.equal(dispatchCapacity((await store.read()).records, 1).available, 0);
    await restarted.observeCreation(record.id, coordinator, {
      sessionKey: child.sessionKey,
      runId: 'setup-turn',
    });
    assert.equal((await store.read()).records[0]!.native?.sessionId, child.sessionId);
  });
  it('should retain setup completion when it arrives before the creation receipt and survives restart', async () => {
    await handoff.claimCreation(record.id, coordinator, record.request);
    await handoff.observeSetupEnd(record.id, { ...child, runId: 'setup-turn' }, true);
    const restarted = new OpenClawDispatchHandoff(
      new OpenClawDispatchStore(root, store.scope),
      handoff.host,
    );
    await restarted.observeCreation(record.id, coordinator, {
      sessionKey: child.sessionKey,
      runId: 'setup-turn',
    });
    assert.equal((await store.read()).records[0]!.setupComplete, true);
    assert.equal(
      (await restarted.reconcile(record.id, coordinator.sessionKey, 2)).status,
      'settings-required',
    );
  });
  it('should reject altered requests, foreign source calls, reused receipts and reset sessions', async () => {
    await assert.rejects(
      handoff.claimCreation(record.id, coordinator, { ...record.request, task: 'Investigate now' }),
      /not-authorized/,
    );
    await create();
    await assert.rejects(
      handoff.observeCreation(
        record.id,
        { ...coordinator, toolCallId: 'other' },
        { sessionKey: child.sessionKey, runId: 'setup-turn' },
      ),
      /source-mismatch/,
    );
    session.parentSessionId = 'new-parent';
    await assert.rejects(
      handoff.reconcile(record.id, coordinator.sessionKey, 2),
      /session-diverged/,
    );
    session.parentSessionId = coordinator.sessionId;
    session.sessionId = 'new-child';
    await assert.rejects(
      handoff.reconcile(record.id, coordinator.sessionKey, 2),
      /session-diverged/,
    );
  });
  it('should consume continuation once and reject settings drift or revoked assignment before its effect', async () => {
    const { next, who } = await continueAssessment();
    await assert.rejects(handoff.claimContinuation(record.id, who, next.request), /not-authorized/);
    session.effort = 'low';
    await assert.rejects(
      handoff.verifyExecution(record.id, child, 'provider/worker'),
      /execution-diverged/,
    );
    session.effort = 'high';
    authorized = false;
    await assert.rejects(
      handoff.verifyExecution(record.id, child, 'provider/worker'),
      /assignment-revoked/,
    );
    assert.equal((await store.read()).records[0]!.execution, undefined);
  });
  it('should verify actual execution separately and permit later turns only in the same incarnation', async () => {
    await continueAssessment();
    await assert.rejects(
      handoff.verifyExecution(record.id, { ...child, runId: 'setup-turn' }, 'provider/worker'),
      /caller-mismatch/,
    );
    await assert.rejects(
      handoff.verifyExecution(
        record.id,
        { ...child, runId: 'other-first-turn' },
        'provider/worker',
      ),
      /caller-mismatch/,
    );
    await assert.rejects(
      handoff.verifyExecution(record.id, child, 'provider/fallback'),
      /execution-diverged/,
    );
    const verified = await handoff.verifyExecution(record.id, child, 'provider/worker');
    assert.deepEqual(verified.execution, {
      runId: child.runId,
      model: 'provider/worker',
      effort: 'high',
    });
    assert.equal(verified.phase, 'assessing');
    assert.equal(
      (
        await handoff.verifyExecution(
          record.id,
          { ...child, runId: 'followup-turn' },
          'provider/worker',
        )
      ).execution?.runId,
      'followup-turn',
    );
    await assert.rejects(
      handoff.verifyExecution(record.id, { ...child, sessionId: 'new' }, 'provider/worker'),
      /caller-mismatch/,
    );
  });
});
