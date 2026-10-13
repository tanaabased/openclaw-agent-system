import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import OpenClawDispatch from '../agent/openclaw-dispatch.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import type { DispatchCaller, DispatchSession } from '../agent/openclaw-dispatch-handoff.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

describe('agent/OpenClaw issue dispatch', () => {
  let root: string;
  let fixture: ReturnType<typeof intakeFixture>;
  let manifest: AgentManifest;
  let service: OpenClawDispatch;
  let native: DispatchSession;
  let preparedWorktrees: number;
  const coordinator: DispatchCaller = {
    sessionKey: 'agent:receiver:automation:intake',
    sessionId: 'coordinator-id',
    runId: 'intake-turn',
    toolCallId: 'intake-call',
  };
  const child: DispatchCaller = {
    sessionKey: 'agent:receiver:issue:3',
    sessionId: 'issue-id',
    runId: 'assessment-turn',
    toolCallId: 'context-call',
  };
  const result = {
    version: 1 as const,
    outcome: 'plan-ready' as const,
    summary: 'Repair the behavior.',
    assessment: 'The caller needs the missing result.',
    planSummary: 'Update the owner.',
    plan: 'Change the owned module and verify the regression.',
    evidence: [],
    progress: {
      completed: ['Inspected the owner.'],
      remaining: ['Implement after authorization.'],
    },
  };
  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/openclaw-dispatch-'));
    fixture = intakeFixture();
    manifest = {
      schemaVersion: 1,
      agent: { id: 'receiver' },
      models: {
        default: { model: 'openai/gpt-6-astra', effort: 'high' },
        low: { model: 'openai/gpt-6-luna', effort: 'medium' },
        medium: { model: 'openai/gpt-6.1-sol', effort: 'high' },
        high: { model: 'openai/gpt-6-astra', effort: 'high' },
      },
      github: {
        username: 'receiver',
        notifications: { ...fixture.policy, runtimes: ['openclaw'] },
      },
    };
    const manifestService = {
      async loadForAgentId() {
        return {
          status: 'loaded' as const,
          manifest,
          scope: { agentId: 'receiver', workspaceDir: root },
          path: join(root, 'agent.yaml'),
          digest: 'manifest',
          diagnostics: [],
          validationChecks: [],
        };
      },
    };
    let now = baseline;
    const intake = new OpenClawIntake({
      root: join(root, 'intake'),
      namespace: root,
      manifestService,
      now: () => now,
      connect: async () => fixture.client,
    });
    await intake.run(manifest, root, 'activate');
    now += 120000;
    await intake.run(
      manifest,
      root,
      'scan',
      (await intake.select(manifest, root)).selected!.digest,
    );
    const worktree = {
      path: join(root, 'worktree'),
      branch: 'issue-3',
      repositoryId: 'github-10',
      workId: 'issue-20',
      status: 'existing' as const,
    };
    native = {
      ...child,
      parentSessionKey: coordinator.sessionKey,
      parentSessionId: coordinator.sessionId,
      cwd: worktree.path,
      model: 'openai/gpt-6.1-sol',
      effort: 'high',
    };
    preparedWorktrees = 0;
    service = new OpenClawDispatch({
      root: join(root, 'dispatch'),
      intake,
      now: () => now,
      coordinator: async () => coordinator.sessionKey,
      preflight() {},
      connect: async () => ({
        ...fixture.client,
        async getItemContext() {
          return {
            title: 'Repair the result',
            body: 'Return the missing result.',
            comments: [],
            labels: [],
            truncated: false,
          };
        },
      }),
      worktrees: {
        prepareGitHub: async () => {
          preparedWorktrees++;
          return worktree;
        },
        inspectGitHub: async () => worktree,
      },
      native: { read: async () => native },
      skill: async () => ({
        name: 'agent-system-issue-assessment',
        path: '/skills/issue-assessment/SKILL.md',
        scope: 'plugin',
        digest: 'f'.repeat(64),
      }),
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function prepare() {
    const next = await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal(next.status, 'routing-required');
    assert.ok(
      'id' in next &&
        'digest' in next &&
        typeof next.id === 'string' &&
        typeof next.digest === 'string',
    );
    const prepared = await service.run(manifest, root, coordinator, {
      action: 'prepare',
      id: next.id,
      digest: next.digest,
      title: 'repair the result',
      assessment: { complexity: 'medium', reason: 'Interacting concerns.' },
    });
    return { next, prepared, id: next.id };
  }
  it('should prepare one setup-only request, use shared routing, and retain it on repeated preparation', async () => {
    assert.equal((await service.check(manifest, root)).changed, true);
    const { next, prepared, id } = await prepare();
    assert.equal(prepared.status, 'prepared');
    assert.ok('request' in prepared && prepared.request);
    assert.equal(prepared.request.model, 'openai/gpt-6.1-sol');
    assert.equal('thinking' in prepared.request, false);
    assert.equal(prepared.request.task.includes('Return the missing result'), false);
    const repeated = await service.run(manifest, root, coordinator, {
      action: 'prepare',
      id,
      digest: next.digest,
      title: 'changed title',
      assessment: { complexity: 'high', reason: 'Ignored retry.' },
    });
    assert.equal(repeated.status, 'reconcile-required');
    assert.equal(preparedWorktrees, 1);
    assert.equal((await service.check(manifest, root)).changed, false);
  });
  it('should suppress a revoked fixture after one bounded blocker without preparing a worktree', async () => {
    fixture.item.assignees = [];
    const next = await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal(next.status, 'blocked');
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(preparedWorktrees, 0);
    assert.equal((await service.dependencies.intake.inspect(manifest, root)).records.length, 1);
  });
  it('should fail before worktree or chat creation when assessment tools have not been approved', async () => {
    service.dependencies.preflight = () => {
      throw new Error('dispatch-assessment-tools-approval-required');
    };
    const { prepared, id } = await prepare();
    assert.deepEqual(prepared.status, 'blocked');
    assert.ok(
      'code' in prepared && prepared.code === 'dispatch-assessment-tools-approval-required',
    );
    assert.equal(preparedWorktrees, 0);
    assert.equal((await service.check(manifest, root)).changed, false);
    await assert.rejects(
      service.run(manifest, root, coordinator, { action: 'retry', id }),
      /operator-required/,
    );
    service.dependencies.preflight = () => {};
    await service.run(manifest, root, coordinator, { action: 'retry', id }, undefined, true);
    assert.equal((await service.check(manifest, root)).changed, true);
    assert.equal(preparedWorktrees, 0);
  });
  it('should retain assessment results and same-chat revisions with a compare-and-swap digest', async () => {
    const { prepared, id } = await prepare();
    assert.ok('request' in prepared);
    const handoff = await service.handoff(manifest, root);
    await handoff.claimCreation(id, coordinator, prepared.request);
    await handoff.observeCreation(id, coordinator, {
      sessionKey: child.sessionKey,
      runId: 'setup-turn',
    });
    await handoff.observeSetupEnd(id, { ...child, runId: 'setup-turn' }, true);
    assert.equal((await service.check(manifest, root)).changed, true);
    const continuation = await handoff.reconcile(id, coordinator.sessionKey, baseline + 180000);
    assert.ok(continuation.status === 'continuation-required');
    await handoff.claimContinuation(id, coordinator, continuation.request);
    await handoff.observeContinuation(id, coordinator, child.runId);
    const context = await service.run(
      manifest,
      root,
      child,
      { action: 'context', id },
      native.model,
    );
    assert.equal(context.status, 'verified');
    const saved = await service.run(
      manifest,
      root,
      child,
      { action: 'result', id, result },
      native.model,
    );
    assert.equal(saved.status, 'recorded');
    assert.ok('presentation' in saved && typeof saved.presentation === 'string');
    const revised = { ...result, plan: 'A revised complete plan after the answer.' };
    await assert.rejects(
      service.run(manifest, root, child, { action: 'result', id, result: revised }, native.model),
      /assessment-result-conflict/,
    );
    assert.ok('previousResultDigest' in saved && typeof saved.previousResultDigest === 'string');
    const later = await service.run(
      manifest,
      root,
      { ...child, runId: 'followup' },
      {
        action: 'result',
        id,
        result: revised,
        previousResultDigest: saved.previousResultDigest,
      },
      native.model,
    );
    assert.equal(later.status, 'recorded');
    const record = (await (await service.scope(manifest, root)).journal.read()).records[0]!;
    assert.equal(record.resultTurnId, 'followup');
    assert.equal(record.stageReceipt?.binding.threadId, child.sessionKey);
    assert.equal(record.phase, 'complete');
    assert.equal((await service.check(manifest, root)).changed, false);
  });
});
