import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GatewayClientRequestError } from '@openclaw/gateway-client';

import type { AssessmentResult } from '../agent/assessment-result.ts';
import AgentSystemToolError from '../api/error.ts';
import { sessionDispatchRequest } from '../credentials/session-dispatch-client.ts';
import GitCommandError from '../tools/git/command-error.ts';
import OpenClawDispatch from '../agent/openclaw-dispatch.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import type { DispatchCaller } from '../agent/openclaw-session-create.ts';
import { Value } from 'typebox/value';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

describe('agent/openclaw issue dispatch', () => {
  let root: string;
  let fixture: ReturnType<typeof intakeFixture>;
  let manifest: AgentManifest;
  let service: OpenClawDispatch;
  let session: Record<string, unknown> | null;
  let calls: Array<{ method: string; params: Record<string, unknown> }>;
  let lost: boolean;
  let absent: boolean;
  let active: boolean;
  let historySessionId: string | undefined;
  let historyRejected: boolean;
  let onCreate: (() => void) | undefined;
  let onSend: (() => void) | undefined;
  let messages: Array<Record<string, unknown>>;
  let inputReceipts: Array<Record<string, unknown>>;
  let waitResult: Record<string, unknown>;
  let loseSend: boolean;
  let acceptSend: boolean;
  let consumeSend: boolean;
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
        notifications: { ...fixture.policy, maxConcurrentItems: 1, runtimes: ['openclaw'] },
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
    await mkdir(worktree.path);
    await writeFile(join(root, 'SKILL.md'), '# shared assessment fixture');
    session = null;
    calls = [];
    lost = false;
    absent = false;
    active = false;
    historySessionId = undefined;
    historyRejected = false;
    onCreate = undefined;
    onSend = undefined;
    messages = [];
    inputReceipts = [];
    waitResult = { status: 'timeout' };
    loseSend = false;
    acceptSend = true;
    consumeSend = false;
    preparedWorktrees = 0;
    service = new OpenClawDispatch({
      root: join(root, 'dispatch'),
      intake,
      now: () => now,
      coordinator: async () => coordinator.sessionKey,
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
      credential: {
        async use(authority, operation) {
          return operation(
            sessionDispatchRequest(async (method, params) => {
              await authority.assertCurrent?.();
              authority.signal?.throwIfAborted();
              calls.push({ method, params });
              if (method === 'sessions.create') {
                const persisted = (await (await service.scope(manifest, root)).journal.read())
                  .records[0]!;
                assert.equal(persisted.sessionCreation?.attempted, true);
                onCreate?.();
                if (!absent)
                  session = {
                    key: params.key,
                    agentId: params.agentId,
                    sessionId: 'ordinary-id',
                    spawnedCwd: params.cwd,
                    label: params.label,
                    category: params.category,
                    model: params.model,
                    thinkingLevel: params.thinkingLevel,
                  };
                if (lost) throw new Error('response-lost');
                return { key: params.key, sessionId: 'ordinary-id', runStarted: false };
              }
              if (method === 'skills.status')
                return {
                  skills: [
                    {
                      name: 'agent-system-issue-assessment',
                      source: 'openclaw-plugins',
                      filePath: join(root, 'SKILL.md'),
                      eligible: true,
                      modelVisible: true,
                    },
                  ],
                };
              if (method === 'sessions.describe') return { session };
              if (method === 'chat.send') {
                const turn = String(params.idempotencyKey).endsWith(':assessment')
                  ? (await record()).assessmentTurn
                  : (await record()).firstTurn;
                assert.equal(turn?.status, 'attempted');
                assert.equal(turn?.message, params.message);
                onSend?.();
                if (acceptSend) {
                  active = true;
                  inputReceipts = consumeSend
                    ? []
                    : [{ runId: params.idempotencyKey, state: 'pending', queued: true }];
                  messages = [
                    ...messages,
                    {
                      role: 'user',
                      content: params.message,
                      idempotencyKey: `${params.idempotencyKey}:user`,
                      __openclaw: {
                        id: 'input-event',
                        runId: params.idempotencyKey,
                        idempotencyKey: `${params.idempotencyKey}:user`,
                      },
                    },
                  ];
                }
                if (loseSend) throw new Error('SECRET lost response');
                return { runId: params.idempotencyKey, status: 'started' };
              }
              if (method === 'agent.wait') {
                assert.equal(params.timeoutMs, 0);
                return { runId: params.runId, ...waitResult };
              }
              assert.equal(method, 'chat.history');
              if (historyRejected)
                throw new GatewayClientRequestError({
                  code: 'INVALID_REQUEST',
                  message: 'private-token',
                });
              if (params.sessionId !== undefined && params.messageId === undefined)
                throw new Error('sessionId requires messageId');
              return {
                sessionId: historySessionId ?? session?.sessionId,
                messages: params.limit === 1 ? messages.slice(-1) : messages,
                inputReceipts,
                pendingInputs: {
                  total: inputReceipts.filter((entry) => entry.state === 'pending').length,
                },
                sessionInfo: {
                  hasActiveRun: active,
                  activeLeafEntryId: messages.length
                    ? (messages.at(-1)!.__openclaw as Record<string, unknown> | undefined)?.id
                    : null,
                },
              };
            }, authority),
          );
        },
      },
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function next() {
    const value = await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal(value.status, 'routing-required');
    assert.ok(
      'id' in value &&
        'digest' in value &&
        typeof value.id === 'string' &&
        typeof value.digest === 'string',
    );
    return value;
  }
  function prepare(input: { id: string; digest: string }, authority = {}) {
    return service.run(
      manifest,
      root,
      coordinator,
      {
        action: 'prepare',
        id: input.id,
        digest: input.digest,
        title: 'repair the result',
        assessment: { complexity: 'medium', reason: 'Interacting concerns.' },
      },
      false,
      authority,
    );
  }
  async function record() {
    return (await (await service.scope(manifest, root)).journal.read()).records[0]!;
  }
  const creates = () => calls.filter(({ method }) => method === 'sessions.create');

  it('should create one ordinary issue session with routed settings and no initial turn', async () => {
    assert.equal((await service.check(manifest, root)).changed, true);
    const input = await next();
    const created = await prepare(input);
    assert.equal(created.status, 'session-created');
    const request = creates()[0]!.params;
    assert.equal(request.model, 'openai/gpt-6.1-sol');
    assert.equal(request.thinkingLevel, 'high');
    assert.equal(request.category, 'repo');
    assert.equal(request.label, '#3: REPAIR THE RESULT');
    assert.equal(request.agentId, 'receiver');
    assert.equal(request.cwd, join(root, 'worktree'));
    assert.equal(request.key, `agent:receiver:dashboard:agent-system-issue-${input.id}`);
    for (const field of [
      'task',
      'message',
      'parentSessionKey',
      'spawnDepth',
      'toolOverrides',
      'permissionMode',
    ])
      assert.equal(request[field], undefined);
    assert.equal((await record()).phase, 'created');
    assert.equal((await record()).sessionCreation?.sourceSessionId, coordinator.sessionId);
    assert.equal((await record()).execution, undefined);
    assert.equal((await service.check(manifest, root)).changed, true);
    assert.equal((await prepare(input)).status, 'reconcile-required');
    const again = await service.run(manifest, root, coordinator, {
      action: 'reconcile',
      id: input.id,
    });
    assert.ok('effect' in again && again.effect === 'reconciled');
    assert.equal(creates().length, 1);
    assert.equal(preparedWorktrees, 1);
  });

  it('should reject unbound callers before any worktree or credential operation', async () => {
    for (const operator of [false, true])
      await assert.rejects(
        service.run(manifest, root, child, { action: 'next' }, operator),
        /dispatch-intake-caller-required/,
      );
    assert.equal(preparedWorktrees, 0);
    assert.equal(calls.length, 0);
  });

  it('should not prepare a revoked assignment or wake repeatedly on its blocker', async () => {
    fixture.item.assignees = [];
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'next' })).status,
      'blocked',
    );
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(preparedWorktrees, 0);
    assert.equal(calls.length, 0);
  });

  it('should reconcile a lost creation response after rebuilding the service without creating again', async () => {
    const input = await next();
    lost = true;
    assert.equal((await prepare(input)).status, 'blocked');
    assert.equal((await record()).sessionCreation?.attempted, true);
    service = new OpenClawDispatch(service.dependencies);
    const recovered = await service.run(manifest, root, coordinator, {
      action: 'reconcile',
      id: input.id,
    });
    assert.equal(recovered.status, 'session-created');
    assert.equal(creates().length, 1);
  });

  it('should recover a rejected history read only in the owning coordinator with the same receipt', async () => {
    const input = await next();
    historyRejected = true;
    const blocked = await prepare(input);
    assert.ok('code' in blocked && blocked.code === 'session-dispatch-history-request-invalid');
    assert.equal((await service.check(manifest, root)).changed, false);
    await assert.rejects(
      service.run(manifest, root, child, { action: 'reconcile', id: input.id }, true),
      /dispatch-intake-caller-required/,
    );
    historyRejected = false;
    for (let replay = 0; replay < 2; replay++) {
      const recovered = await service.run(manifest, root, coordinator, {
        action: 'reconcile',
        id: input.id,
      });
      assert.ok('sessionId' in recovered && recovered.sessionId === 'ordinary-id');
    }
    assert.equal((await record()).phase, 'created');
    assert.equal((await record()).blocker, undefined);
    assert.equal(creates().length, 1);
    assert.ok(
      calls.every(({ method }) =>
        ['sessions.create', 'sessions.describe', 'chat.history'].includes(method),
      ),
    );
  });

  it('should retain an uncertain absent session without repeating creation or clearing its slot', async () => {
    const input = await next();
    lost = true;
    absent = true;
    await prepare(input);
    const reconciled = await service.run(manifest, root, coordinator, {
      action: 'reconcile',
      id: input.id,
    });
    assert.ok('code' in reconciled && reconciled.code === 'dispatch-session-reconcile-required');
    assert.equal(creates().length, 1);
    await assert.rejects(
      service.run(manifest, root, coordinator, { action: 'retry', id: input.id }, true),
      /dispatch-native-recovery-required/,
    );
    assert.equal((await service.check(manifest, root)).changed, false);
  });

  it('should reject a session replaced between description and current history readback', async () => {
    const input = await next();
    historySessionId = 'replacement-id';
    const result = await prepare(input);
    assert.ok('code' in result && result.code === 'dispatch-session-not-empty-idle');
    assert.equal((await record()).sessionCreation?.verified, undefined);
    assert.equal((await record()).sessionCreation?.sessionId, 'ordinary-id');
    historySessionId = undefined;
    const recovered = await service.run(manifest, root, coordinator, {
      action: 'reconcile',
      id: input.id,
    });
    assert.equal(recovered.status, 'session-created');
    assert.equal(creates().length, 1);
  });

  it('should keep credentials unavailable as a blocker without reporting session success', async () => {
    service.dependencies.credential = {
      async use() {
        throw new Error('session-dispatch-not-enrolled');
      },
    };
    const input = await next();
    const result = await prepare(input);
    assert.ok('code' in result && result.code === 'session-dispatch-not-enrolled');
    assert.equal((await record()).sessionCreation?.attempted, false);
    assert.equal((await record()).threadId, undefined);
    assert.equal(calls.length, 0);
  });

  it('should fail before creation when assignment or caller authority changes during preparation', async () => {
    const input = await next();
    const result = await prepare(input, {
      assertCurrent: async () => {
        fixture.item.assignees = [];
      },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(calls.length, 0);
  });

  it('should preserve cancellation and refuse simultaneous creation attempts', async () => {
    const input = await next();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const first = prepare(input, {
      signal: controller.signal,
      assertCurrent: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    await assert.rejects(service.run(manifest, root, coordinator, { action: 'next' }), /lock/i);
    controller.abort();
    release.resolve();
    assert.equal((await first).status, 'blocked');
    assert.equal(creates().length, 0);
  });

  it('should retain an attempted receipt when cancellation occurs after creation', async () => {
    const input = await next();
    const controller = new AbortController();
    onCreate = () => controller.abort();
    assert.equal((await prepare(input, { signal: controller.signal })).status, 'blocked');
    assert.equal(creates().length, 1);
    assert.equal((await record()).sessionCreation?.attempted, true);
  });

  it('should reject changed session identity settings grouping and unexpected activity', async () => {
    const input = await next();
    await prepare(input);
    const original = { ...session! };
    for (const change of [
      { sessionId: 'replacement' },
      { agentId: 'other' },
      { model: 'other/model' },
      { thinkingLevel: 'low' },
      { category: 'other' },
      { label: 'other' },
      { spawnedCwd: '/' },
      { parentSessionKey: 'parent' },
      { spawnDepth: 1 },
      { archived: true },
    ]) {
      session = { ...original, ...change };
      const result = await service.run(manifest, root, coordinator, {
        action: 'reconcile',
        id: input.id,
      });
      assert.ok('code' in result && result.code === 'dispatch-session-mismatch');
    }
    session = original;
    active = true;
    const result = await service.run(manifest, root, coordinator, {
      action: 'reconcile',
      id: input.id,
    });
    assert.ok('code' in result && result.code === 'dispatch-session-not-empty-idle');
    assert.equal(creates().length, 1);
  });

  it('should keep classified preparation failures value-free and explicitly retryable', async () => {
    service.dependencies.worktrees.prepareGitHub = async () => {
      throw Object.assign(new AgentSystemToolError('execution_failed', 'SECRET'), {
        cause: new GitCommandError('fetch', {
          exitCode: 128,
          stderr: 'Could not resolve host: private-host SECRET',
        }),
      });
    };
    const input = await next();
    assert.deepEqual(await prepare(input), {
      status: 'blocked',
      id: input.id,
      code: 'git-fetch-dns-exit-128',
      stage: 'worktree',
    });
    assert.equal(JSON.stringify(await record()).includes('SECRET'), false);
    assert.equal((await service.check(manifest, root)).changed, false);
    await service.run(manifest, root, coordinator, { action: 'retry', id: input.id }, true);
    assert.equal((await service.check(manifest, root)).changed, true);
  });

  it('should retain old spawn receipts without resuming or duplicating them', async () => {
    const input = await next();
    await prepare(input);
    const journal = (await service.scope(manifest, root)).journal;
    await journal.exclusive(async (state, save) => {
      const old = state.records[0]!;
      old.request = {
        runtime: 'subagent',
        visible: true,
        cleanup: 'keep',
        task: 'setup only',
        label: '#3: OLD',
        cwd: old.worktree!,
        model: 'openai/gpt-6.1-sol',
      };
      delete old.sessionCreation;
      delete old.effective;
      delete old.threadId;
      old.phase = 'creating';
      await save();
    });
    assert.equal((await service.check(manifest, root)).changed, false);
    const result = await service.run(manifest, root, coordinator, {
      action: 'reconcile',
      id: input.id,
    });
    assert.ok('code' in result && result.code === 'dispatch-legacy-handoff-retained');
    assert.equal(creates().length, 1);
    assert.equal((await record()).request && 'task' in (await record()).request!, true);
  });

  it('should expose no arbitrary identity credential message or removed actions', () => {
    for (const action of ['canary', 'context', 'result', 'validate-result'])
      assert.equal(Value.Check(dispatchParameters, { action }), false);
    for (const extra of [
      { agentId: 'other' },
      { method: 'chat.send' },
      { token: 'secret' },
      { cwd: '/' },
      { message: 'work' },
    ])
      assert.equal(Value.Check(dispatchParameters, { action: 'next', ...extra }), false);
  });

  const sends = () => calls.filter(({ method }) => method === 'chat.send');
  function start(id: string, authority = {}) {
    return service.run(manifest, root, coordinator, { action: 'start', id }, false, authority);
  }
  async function finish(id: string) {
    const runId = `${id}:first-turn`;
    active = false;
    inputReceipts = [];
    messages.push({
      role: 'assistant',
      stopReason: 'stop',
      __openclaw: { id: 'reply-event', runId, mirrorOrigin: 'codex-app-server', runTerminal: true },
      content: [{ type: 'text', text: 'The requested fix belongs in handler.ts:20.' }],
    });
    return service.run(manifest, root, coordinator, { action: 'reconcile', id });
  }

  it('should select the created session at capacity and persist exactly one useful working turn', async () => {
    const input = await next();
    await prepare(input);
    assert.deepEqual(await service.run(manifest, root, coordinator, { action: 'next' }), {
      status: 'assessment-required',
      id: input.id,
    });
    assert.equal((await start(input.id)).status, 'working-turn-pending');
    const sent = sends()[0]!.params;
    assert.equal(sent.sessionId, 'ordinary-id');
    assert.equal(sent.deliver, false);
    assert.equal(sent.expectedLeafEntryId, null);
    assert.equal(sent.thinking, undefined);
    assert.match(String(sent.message), /Return the missing result/);
    assert.match(String(sent.message), /untrusted issue evidence/);
    assert.match(String(sent.message), /Do not change files/);
    assert.deepEqual(await service.run(manifest, root, coordinator, { action: 'next' }), {
      status: 'reconcile-required',
      id: input.id,
    });
    await start(input.id);
    const completed = await finish(input.id);
    assert.equal(completed.status, 'working-turn-completed');
    assert.ok('executionEffort' in completed && completed.executionEffort === 'unverified');
    assert.equal((await start(input.id)).status, 'working-turn-completed');
    assert.equal(sends().length, 1);
    assert.equal(creates().length, 1);
    assert.equal((await record()).firstTurn?.replyEventId, 'reply-event');
    assert.equal((await record()).phase, 'created');
    assert.equal((await record()).result, undefined);
    assert.equal((await service.check(manifest, root)).changed, true);
  });

  it('should recover exact accepted input after a lost send response and restart without sending again', async () => {
    const input = await next();
    await prepare(input);
    loseSend = true;
    assert.equal((await start(input.id)).status, 'blocked');
    assert.equal((await record()).firstTurn?.status, 'attempted');
    assert.equal(JSON.stringify(await record()).includes('SECRET'), false);
    service = new OpenClawDispatch(service.dependencies);
    assert.equal((await start(input.id)).status, 'working-turn-pending');
    assert.equal((await finish(input.id)).status, 'working-turn-completed');
    assert.equal(sends().length, 1);
    assert.equal((await record()).firstTurn?.executionModel, undefined);
  });

  it('should verify an ordinary input consumed before the first history read', async () => {
    const input = await next();
    await prepare(input);
    consumeSend = true;
    assert.equal((await start(input.id)).status, 'working-turn-pending');
    assert.equal((await record()).firstTurn?.status, 'consumed');
    assert.equal((await record()).firstTurn?.consumedByEventId, 'input-event');
    assert.equal((await finish(input.id)).status, 'working-turn-completed');
    assert.equal(sends().length, 1);
  });

  it('should recover the saved accepted delivery blocker on the next coordinator run without resending', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    const journal = (await service.scope(manifest, root)).journal;
    await journal.exclusive(async (state, save) => {
      const saved = state.records[0]!;
      saved.phase = 'blocked';
      saved.failureStage = 'first-turn';
      saved.blocker = 'dispatch-turn-delivery-unverified';
      await save();
    });
    service = new OpenClawDispatch(service.dependencies);
    assert.equal((await service.check(manifest, root)).changed, true);
    assert.deepEqual(await service.run(manifest, root, coordinator, { action: 'next' }), {
      status: 'reconcile-required',
      id: input.id,
    });
    assert.equal((await finish(input.id)).status, 'working-turn-completed');
    assert.equal((await record()).blocker, undefined);
    assert.equal((await record()).firstTurn?.replyEventId, 'reply-event');
    service = new OpenClawDispatch(service.dependencies);
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'reconcile', id: input.id }))
        .status,
      'working-turn-completed',
    );
    assert.equal((await service.check(manifest, root)).changed, true);
    assert.equal(sends().length, 1);
    assert.equal(creates().length, 1);
  });

  it('should preserve collected input receipts when their transcript input is outside the page', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    messages = [];
    inputReceipts = [
      { runId: `${input.id}:first-turn`, state: 'consumed', consumedByEventId: 'collected-input' },
    ];
    assert.equal((await start(input.id)).status, 'working-turn-pending');
    assert.equal((await record()).firstTurn?.consumedByEventId, 'collected-input');
    assert.equal(sends().length, 1);
  });

  for (const mismatch of [
    'run',
    'key',
    'message',
    'truncated',
    'missing',
    'duplicate',
    'incarnation',
  ]) {
    it(`should reject ${mismatch} ordinary input evidence without resending`, async () => {
      const input = await next();
      await prepare(input);
      await start(input.id);
      inputReceipts = [];
      const user = messages[0]!;
      const meta = user.__openclaw as Record<string, unknown>;
      if (mismatch === 'run') meta.runId = 'unrelated';
      if (mismatch === 'key') meta.idempotencyKey = 'unrelated:user';
      if (mismatch === 'message') user.content = 'different input';
      if (mismatch === 'truncated') meta.truncated = true;
      if (mismatch === 'missing') messages = [];
      if (mismatch === 'duplicate') messages.push(structuredClone(user));
      if (mismatch === 'incarnation') historySessionId = 'replacement';
      assert.equal((await start(input.id)).status, 'blocked');
      assert.equal((await record()).firstTurn?.status, 'accepted');
      assert.equal(sends().length, 1);
    });
  }

  it('should accept exact text-block input without inventing missing receipt evidence', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    messages[0]!.content = [{ type: 'text', text: messages[0]!.content }];
    assert.equal((await finish(input.id)).status, 'working-turn-completed');
    assert.equal((await record()).firstTurn?.consumedByEventId, 'input-event');
  });

  it('should reject a changed consumption identity across reconciliation', async () => {
    const input = await next();
    await prepare(input);
    consumeSend = true;
    await start(input.id);
    (messages[0]!.__openclaw as Record<string, unknown>).id = 'replacement-input';
    const result = await start(input.id);
    assert.ok('code' in result && result.code === 'dispatch-turn-input-mismatch');
    assert.equal(sends().length, 1);
  });

  it('should not treat mirrored commentary as a terminal answer even when the run is idle', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    inputReceipts = [];
    active = false;
    messages.push({
      role: 'assistant',
      stopReason: 'stop',
      __openclaw: {
        id: 'commentary',
        runId: `${input.id}:first-turn`,
        mirrorOrigin: 'codex-app-server',
      },
      content: [{ type: 'text', text: 'I will investigate.' }],
    });
    const result = await start(input.id);
    assert.ok('code' in result && result.code === 'dispatch-turn-outcome-unverified');
    assert.equal((await record()).firstTurn?.replyEventId, undefined);
    assert.equal((await service.check(manifest, root)).changed, false);
  });

  it('should not override explicit cancellation or run failure with matching transcript evidence', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    inputReceipts[0]!.cancelled = true;
    const cancelled = await start(input.id);
    assert.ok('code' in cancelled && cancelled.code === 'dispatch-turn-cancelled');
    assert.equal((await service.check(manifest, root)).changed, false);
    waitResult = { status: 'error' };
    const failed = await finish(input.id);
    assert.ok('code' in failed && failed.code === 'dispatch-turn-failed');
    assert.equal((await record()).firstTurn?.replyEventId, undefined);
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(sends().length, 1);
  });

  it('should keep an unknown send blocked without resending or releasing its session slot', async () => {
    const input = await next();
    await prepare(input);
    loseSend = true;
    acceptSend = false;
    await start(input.id);
    for (let i = 0; i < 2; i++) {
      const result = await start(input.id);
      assert.ok('code' in result && result.code === 'dispatch-turn-delivery-unverified');
    }
    assert.equal(sends().length, 1);
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'next' })).status,
      'at-capacity',
    );
  });

  it('should reject unrelated messages busy sessions and replaced incarnations before a first send', async () => {
    const input = await next();
    await prepare(input);
    messages = [{ role: 'user', content: 'unrelated' }];
    assert.equal((await start(input.id)).status, 'blocked');
    messages = [];
    active = true;
    assert.equal((await start(input.id)).status, 'blocked');
    active = false;
    session!.sessionId = 'replacement';
    assert.equal((await start(input.id)).status, 'blocked');
    assert.equal(sends().length, 0);
    assert.equal((await record()).firstTurn, undefined);
  });

  it('should preserve cancellation after send and reconcile without duplicating it', async () => {
    const input = await next();
    await prepare(input);
    const controller = new AbortController();
    onSend = () => controller.abort();
    assert.equal((await start(input.id, { signal: controller.signal })).status, 'blocked');
    assert.equal((await record()).firstTurn?.status, 'attempted');
    assert.equal((await start(input.id)).status, 'working-turn-pending');
    assert.equal(sends().length, 1);
  });

  it('should revalidate assignment and caller authority before sending or reconciling', async () => {
    const input = await next();
    await prepare(input);
    await assert.rejects(
      service.run(manifest, root, child, { action: 'start', id: input.id }, true),
      /dispatch-intake-caller-required/,
    );
    assert.equal(
      (
        await start(input.id, {
          assertCurrent: async () => {
            throw new Error('authority-revoked');
          },
        })
      ).status,
      'blocked',
    );
    assert.equal(sends().length, 0);
    await start(input.id);
    fixture.item.assignees = [];
    assert.equal((await start(input.id)).status, 'blocked');
    assert.equal(sends().length, 1);
  });

  it('should not confuse unrelated assistant output or tool calls with the working turn reply', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    inputReceipts = [
      { runId: `${input.id}:first-turn`, state: 'consumed', consumedByEventId: 'input-event' },
    ];
    active = false;
    messages.push({
      role: 'assistant',
      stopReason: 'stop',
      __openclaw: { id: 'other', runId: 'another-run' },
      content: [{ type: 'text', text: 'unrelated' }],
    });
    const result = await start(input.id);
    assert.ok('code' in result && result.code === 'dispatch-turn-outcome-unverified');
    assert.equal((await record()).firstTurn?.status, 'consumed');
    messages[1]!.__openclaw = { id: 'tool-call', runId: `${input.id}:first-turn` };
    messages[1]!.stopReason = 'toolUse';
    assert.equal((await start(input.id)).status, 'blocked');
    assert.equal(sends().length, 1);
  });

  it('should retain executed model evidence only from the matching native terminal receipt', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    waitResult = {
      status: 'ok',
      terminalReceipt: {
        runId: `${input.id}:first-turn`,
        sessionId: 'ordinary-id',
        effective: { provider: 'openai', model: 'gpt-6.1-sol' },
      },
    };
    assert.equal((await finish(input.id)).status, 'working-turn-completed');
    assert.equal((await record()).firstTurn?.executionModel, 'openai/gpt-6.1-sol');
  });

  it('should refuse concurrent first-turn operations while the journal lock is held', async () => {
    const input = await next();
    await prepare(input);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = start(input.id, {
      assertCurrent: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    await assert.rejects(start(input.id), /lock/i);
    release.resolve();
    assert.equal((await first).status, 'working-turn-pending');
    assert.equal(sends().length, 1);
  });

  it('should retain a persisted attempt if authority is revoked before its send reaches the host', async () => {
    const input = await next();
    await prepare(input);
    const result = await start(input.id, {
      assertCurrent: async () => {
        if ((await record()).firstTurn) throw new Error('authority-revoked');
      },
    });
    assert.equal(result.status, 'blocked');
    assert.equal((await record()).firstTurn?.status, 'attempted');
    assert.equal(sends().length, 0);
    assert.equal((await start(input.id)).status, 'blocked');
    assert.equal(sends().length, 0);
  });

  it('should block cancelled input and mismatched terminal evidence without claiming completion', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    inputReceipts[0]!.cancelled = true;
    const cancelled = await start(input.id);
    assert.ok('code' in cancelled && cancelled.code === 'dispatch-turn-cancelled');
    waitResult = {
      status: 'ok',
      terminalReceipt: {
        runId: `${input.id}:first-turn`,
        sessionId: 'replacement',
        effective: { provider: 'openai', model: 'gpt-6.1-sol' },
      },
    };
    const mismatch = await finish(input.id);
    assert.ok('code' in mismatch && mismatch.code === 'dispatch-turn-terminal-mismatch');
    assert.equal((await record()).firstTurn?.status, 'consumed');
    waitResult = {
      status: 'ok',
      terminalReceipt: {
        runId: `${input.id}:first-turn`,
        sessionId: 'ordinary-id',
        effective: { provider: 'openai', model: 'other-model' },
      },
    };
    const rerouted = await start(input.id);
    assert.ok('code' in rerouted && rerouted.code === 'dispatch-turn-model-mismatch');
    assert.equal((await record()).firstTurn?.status, 'consumed');
    assert.equal(sends().length, 1);
  });

  it('should reject incomplete or misbound durable first-turn receipts', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    const journal = (await service.scope(manifest, root)).journal;
    for (const change of [
      { runId: 'other' },
      { status: 'completed' as const },
      { status: 'consumed' as const },
      { executionModel: 'openai/gpt-6.1-sol' },
      { replyEventId: 'unearned' },
    ]) {
      await assert.rejects(
        journal.exclusive(async (state, save) => {
          Object.assign(state.records[0]!.firstTurn!, change);
          await save();
        }),
      );
    }
    assert.equal((await record()).firstTurn?.status, 'accepted');
  });
  const plan: AssessmentResult = {
    version: 1,
    outcome: 'plan-ready',
    summary: 'Restore the missing result.',
    assessment: 'The handler drops its return value.',
    planSummary: 'Return the result to the caller.',
    plan: 'Update handler.ts to return the value and cover the missing-result case.',
    fullAssessment:
      'The handler drops its return value. Update handler.ts and verify the caller receives it.',
    evidence: [{ source: 'handler.ts:20', status: 'observed', detail: 'The result is discarded.' }],
    progress: { completed: ['Inspected the handler.'], remaining: [] },
  };
  const assess = (id: string) => service.run(manifest, root, coordinator, { action: 'assess', id });
  const assessor = (id: string, runId = `${id}:assessment`): DispatchCaller => ({
    sessionKey: `agent:receiver:dashboard:agent-system-issue-${id}`,
    sessionId: 'ordinary-id',
    runId,
    toolCallId: 'assessment-tool',
  });
  const context = (id: string, who = assessor(id)) =>
    service.run(manifest, root, who, { action: 'context', id });
  const submit = (
    id: string,
    result: AssessmentResult = plan,
    previousResultDigest?: string,
    who = assessor(id),
  ) => service.run(manifest, root, who, { action: 'result', id, result, previousResultDigest });
  function assessmentReply(id: string) {
    active = false;
    inputReceipts = [];
    messages.push({
      role: 'assistant',
      stopReason: 'stop',
      __openclaw: {
        id: 'assessment-reply',
        runId: `${id}:assessment`,
        mirrorOrigin: 'codex-app-server',
        runTerminal: true,
      },
      content: [{ type: 'text', text: 'The complete retained assessment and plan.' }],
    });
  }

  it('should retain a full assessment with native caller binding and free capacity without another send', async () => {
    const input = await next();
    await prepare(input);
    assert.equal((await assess(input.id)).status, 'assessment-pending');
    assert.equal((await record()).firstTurn, undefined);
    assert.equal(sends().length, 1);
    assert.match(String(sends()[0]!.params.message), /action context/);
    const verified = await context(input.id);
    assert.ok('runtime' in verified && verified.runtime === 'openclaw');
    assert.ok('evidence' in verified && 'resultSchema' in verified && 'assessment' in verified);
    const recorded = await submit(input.id);
    assert.ok('presentation' in recorded && recorded.presentation?.includes(plan.fullAssessment!));
    assert.equal(recorded.status, 'recorded');
    const saved = await record();
    assert.deepEqual(saved.result, plan);
    assert.equal(saved.resultTurnId, `${input.id}:assessment`);
    assert.equal(saved.stageReceipt?.binding.threadId, assessor(input.id).sessionKey);
    assert.equal(saved.stageReceipt?.binding.worktree, join(root, 'worktree'));
    assessmentReply(input.id);
    service = new OpenClawDispatch(service.dependencies);
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'next' })).status,
      'idle',
    );
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    assert.equal(sends().length, 1);
    assert.equal(creates().length, 1);
  });

  for (const debug of [false, true]) {
    it(`should ${debug ? 'include' : 'omit'} debug instructions in recorded and reloaded assessments`, async () => {
      manifest.debug = debug;
      const input = await next();
      await prepare(input);
      await assess(input.id);
      await context(input.id);
      const recorded = await submit(input.id);
      assert.ok('presentation' in recorded && typeof recorded.presentation === 'string');
      assert.equal(recorded.presentation.includes('Assessment instructions'), debug);
      const reloaded = await context(input.id);
      assert.ok('previousPresentation' in reloaded);
      assert.equal(reloaded.previousPresentation, recorded.presentation);
    });
  }

  it('should continue the completed investigation in its original session without repeating it', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    await finish(input.id);
    const previous = (await record()).firstTurn;
    assert.equal((await assess(input.id)).status, 'assessment-pending');
    assert.deepEqual((await record()).firstTurn, previous);
    assert.equal(sends()[1]!.params.expectedLeafEntryId, 'reply-event');
    await context(input.id);
    await submit(input.id);
    assessmentReply(input.id);
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    assert.equal(sends().length, 2);
    assert.equal(creates().length, 1);
  });

  it('should refuse an intervening user message instead of appending an automatic assessment', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    await finish(input.id);
    messages.push({
      role: 'user',
      content: 'Wait.',
      __openclaw: { id: 'human-answer', runId: 'human-run' },
    });
    const blocked = await assess(input.id);
    assert.ok('code' in blocked && blocked.code === 'dispatch-assessment-session-not-idle');
    assert.equal(sends().length, 1);
    assert.equal((await record()).assessmentTurn, undefined);
  });

  it('should reject coordinator other-session replaced-incarnation and unverified-run result callers', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    for (const who of [coordinator, child, { ...assessor(input.id), sessionId: 'replacement' }])
      await assert.rejects(context(input.id, who), /dispatch-assessment-caller-mismatch/);
    await assert.rejects(
      context(input.id, assessor(input.id, 'invented')),
      /dispatch-assessment-input-unverified/,
    );
    await assert.rejects(submit(input.id), /dispatch-assessment-context-required/);
    assert.equal((await record()).result, undefined);
  });

  it('should preserve the prior plan on conflict and permit a same-session clarification revision', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    const clarification: AssessmentResult = {
      version: 1,
      outcome: 'clarification-needed',
      summary: 'Which caller needs the result?',
      assessment: 'The intended caller is unclear.',
      questions: ['Should the API caller receive it?'],
      fullAssessment: 'Inspected the handler. The caller requirement remains unresolved.',
      evidence: [],
      progress: { completed: ['Inspected handler.'], remaining: ['Resolve caller requirement.'] },
    };
    const saved = await submit(input.id, clarification);
    assert.ok('previousResultDigest' in saved);
    assessmentReply(input.id);
    messages.push({
      role: 'user',
      content: 'Yes, the API caller.',
      __openclaw: { id: 'answer-event', runId: 'followup' },
    });
    active = true;
    const who = assessor(input.id, 'followup');
    const fresh = await context(input.id, who);
    assert.ok(
      'previousResult' in fresh &&
        fresh.previousResult?.fullAssessment === clarification.fullAssessment,
    );
    await assert.rejects(submit(input.id, plan, undefined, who), /assessment-result-conflict/);
    assert.deepEqual((await record()).result, clarification);
    assert.equal(
      (await submit(input.id, plan, saved.previousResultDigest, who)).status,
      'recorded',
    );
    assert.equal(
      (await submit(input.id, plan, saved.previousResultDigest, who)).status,
      'recorded',
    );
    assert.deepEqual((await record()).result, plan);
    assert.equal((await record()).resultTurnId, 'followup');
    assert.equal(sends().length, 1);
  });

  it('should recover a lost assessment send response without sending the saved request again', async () => {
    const input = await next();
    await prepare(input);
    loseSend = true;
    assert.equal((await assess(input.id)).status, 'blocked');
    assert.equal((await record()).assessmentTurn?.status, 'attempted');
    await context(input.id);
    await submit(input.id);
    assessmentReply(input.id);
    service = new OpenClawDispatch(service.dependencies);
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    assert.equal(sends().length, 1);
  });

  it('should preserve missing-result failure evidence and permit repair in the same session', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    assessmentReply(input.id);
    const blocked = await assess(input.id);
    assert.ok('code' in blocked && blocked.code === 'dispatch-assessment-result-missing');
    assert.equal((await record()).result, undefined);
    assert.equal((await service.check(manifest, root)).changed, false);
    messages.push({
      role: 'user',
      content: 'Retain the completed plan.',
      __openclaw: { id: 'repair-event', runId: 'repair' },
    });
    const who = assessor(input.id, 'repair');
    await context(input.id, who);
    await submit(input.id, plan, undefined, who);
    assert.equal((await record()).blocker, undefined);
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    assert.equal(sends().length, 1);
  });

  it('should not erase a recorded assessment on a stale caller or revoked assignment', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    await submit(input.id);
    fixture.item.assignees = [];
    await assert.rejects(context(input.id), /dispatch-assignment-authority-revoked/);
    assert.deepEqual((await record()).result, plan);
    assert.equal((await record()).phase, 'complete');
    assert.equal(sends().length, 1);
  });

  it('should reject changed skill content and incomplete results without recording success', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    await assert.rejects(
      submit(input.id, { ...plan, fullAssessment: undefined }),
      /assessment-result-incomplete/,
    );
    await writeFile(join(root, 'SKILL.md'), '# changed selection');
    await assert.rejects(submit(input.id), /dispatch-assessment-skill-changed/);
    assert.equal((await record()).result, undefined);
  });

  it('should keep an uncertain assessment send blocked and never reinterpret it as a fresh attempt', async () => {
    const input = await next();
    await prepare(input);
    loseSend = true;
    acceptSend = false;
    assert.equal((await assess(input.id)).status, 'blocked');
    assert.equal((await assess(input.id)).status, 'blocked');
    service = new OpenClawDispatch(service.dependencies);
    assert.equal((await assess(input.id)).status, 'blocked');
    assert.equal(sends().length, 1);
    assert.equal((await service.check(manifest, root)).changed, false);
  });
  it('should retain verified consumption when a long assessment moves its input outside the history tail', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    messages = [];
    inputReceipts = [];
    assert.equal((await context(input.id)).status, 'verified');
    assert.equal((await submit(input.id)).status, 'recorded');
    assessmentReply(input.id);
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    messages = [
      {
        role: 'user',
        content: 'Revise the plan.',
        __openclaw: { id: 'later-event', runId: 'later' },
      },
    ];
    assert.equal((await context(input.id, assessor(input.id, 'later'))).status, 'verified');
    assert.equal(sends().length, 1);
  });

  it('should retain a setup blocker without claiming a plan or restarting assessment', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    const blocker: AssessmentResult = {
      version: 1,
      outcome: 'operator-setup-blocker',
      summary: 'Opening editor unavailable.',
      code: 'assessment-editor-unavailable',
      remediation: 'Enable the isolated helper in this session, then continue here.',
      fullAssessment:
        'Repository investigation is retained. The required isolated editing pass is unavailable.',
      evidence: [],
      progress: {
        completed: ['Inspected the repository.'],
        remaining: ['Run the isolated editor.'],
      },
    };
    assert.equal((await submit(input.id, blocker)).status, 'recorded');
    assessmentReply(input.id);
    await assess(input.id);
    assert.equal((await record()).result?.outcome, 'operator-setup-blocker');
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(sends().length, 1);
  });
});
