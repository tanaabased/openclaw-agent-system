import assert from 'node:assert/strict';
import { attemptedAnnouncement } from './delivery-announcement-fixture.ts';
import { automationHash } from '../agent/automation-hash.ts';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GatewayClientRequestError } from '@openclaw/gateway-client';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { issueKey } from '../agent/dispatch-pending.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import type { AssessmentResult } from '../agent/assessment-result.ts';
import AgentSystemToolError from '../api/error.ts';
import { privateStateFileLockBusyErrorCode } from '../core/private-state-file-lock.ts';
import { sessionDispatchRequest } from '../credentials/session-dispatch-client.ts';
import GitCommandError from '../tools/git/command-error.ts';
import OpenClawDispatch from '../agent/openclaw-dispatch.ts';
import { scanOpenClawFeedback } from '../agent/openclaw-feedback-scan.ts';
import discoveryCheckpoint from '../agent/discovery-checkpoint.ts';
import DiscoveryBudget, { DiscoveryPaused } from '../agent/discovery-budget.ts';
import openClawCapacity from '../agent/openclaw-capacity.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import type { DispatchCaller } from '../agent/openclaw-session-create.ts';
import { Value } from 'typebox/value';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';
import {
  baseline,
  intakeFixture,
  removeFixtureAssignment,
  originalIntakeDigest,
} from './github-intake-fixture.ts';

describe('agent/openclaw issue dispatch', () => {
  let root: string;
  let fixture: ReturnType<typeof intakeFixture>;
  let manifest: AgentManifest;
  let service: OpenClawDispatch;
  let config: OpenClawConfig;
  let session: Record<string, unknown> | null;
  let calls: Array<{ method: string; params: Record<string, unknown> }>;
  let lost: boolean;
  let absent: boolean;
  let active: boolean;
  let historySessionId: string | undefined;
  let historyRejected: boolean;
  let onCreate: (() => void) | undefined;
  let onSend: (() => void) | undefined;
  let afterSend: (() => Promise<void>) | undefined;
  let messages: Array<Record<string, unknown>>;
  let anchoredMessages: Array<Record<string, unknown>>;
  let inputReceipts: Array<Record<string, unknown>>;
  let waitResult: Record<string, unknown>;
  let loseSend: boolean;
  let acceptSend: boolean;
  let consumeSend: boolean;
  let preparedWorktrees: number;
  let multiple: boolean;
  let cronJobs: unknown[];
  const sessions = new Map<string, Record<string, unknown>>();
  const histories = new Map<
    string,
    {
      messages: Array<Record<string, unknown>>;
      inputReceipts: Array<Record<string, unknown>>;
      active: boolean;
    }
  >();
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
    coordinator.runId = 'intake-turn';
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
    cronJobs = [];
    lost = false;
    absent = false;
    active = false;
    historySessionId = undefined;
    historyRejected = false;
    onCreate = undefined;
    onSend = undefined;
    afterSend = undefined;
    messages = [];
    anchoredMessages = [];
    inputReceipts = [];
    waitResult = { status: 'timeout' };
    loseSend = false;
    acceptSend = true;
    consumeSend = false;
    preparedWorktrees = 0;
    multiple = false;
    sessions.clear();
    histories.clear();
    config = {};
    service = new OpenClawDispatch({
      root: join(root, 'dispatch'),
      config: () => config,
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
      feedbackConnect: async () => ({
        ...fixture.client,
        identity: fixture.client.identity,
        listIssueComments: async () => ({ comments: [], truncated: false }),
        getIssueComment: async () => {
          throw new Error('no source');
        },
        createIssueComment: async () => {
          throw new Error('no publication expected');
        },
        findOwnIssueComment: async () => undefined,
        getItem: fixture.client.getItem,
        replies: {
          find: async () => undefined,
          create: async () => {
            throw new Error('no review reply expected');
          },
        },
        getItemContext: async () => ({
          title: 'Repair the result',
          body: 'Return the missing result.',
          comments: [],
          labels: [],
          truncated: false,
        }),
      }),
      worktrees: {
        prepareGitHub: async (input) => {
          preparedWorktrees++;
          if (!multiple) return worktree;
          const path = join(root, `worktree-${input.itemNumber}`);
          await mkdir(path, { recursive: true });
          return { ...worktree, path };
        },
        inspectGitHub: async (input) =>
          multiple ? { ...worktree, path: join(root, `worktree-${input.itemNumber}`) } : worktree,
      },
      credential: {
        async use(authority, operation) {
          return operation(
            sessionDispatchRequest(async (method, params) => {
              await authority.assertCurrent?.();
              authority.signal?.throwIfAborted();
              calls.push({ method, params });
              if (method === 'sessions.create') {
                const persisted = (
                  await (await service.scope(manifest, root)).journal.read()
                ).records.find(
                  (record) =>
                    record.request && 'key' in record.request && record.request.key === params.key,
                )!;
                assert.equal(persisted.sessionCreation?.attempted, true);
                onCreate?.();
                if (!absent)
                  session = {
                    key: params.key,
                    agentId: params.agentId,
                    sessionId: multiple ? `ordinary-${persisted.id}` : 'ordinary-id',
                    spawnedCwd: params.cwd,
                    label: params.label,
                    category: params.category,
                    modelProvider: String(params.model).split('/')[0],
                    model: String(params.model).split('/').slice(1).join('/'),
                    thinkingLevel: params.thinkingLevel,
                    parentSessionKey: 'agent:receiver:main',
                    spawnDepth: 0,
                  };
                if (multiple && session) {
                  sessions.set(String(params.key), session);
                  histories.set(String(params.key), {
                    messages: [],
                    inputReceipts: [],
                    active: false,
                  });
                }
                if (lost) throw new Error('response-lost');
                return { key: params.key, sessionId: session?.sessionId, runStarted: false };
              }
              if (method === 'skills.status')
                return {
                  skills: [
                    {
                      name: 'agent-system-feedback-reply',
                      source: 'openclaw-plugins',
                      filePath: join(root, 'SKILL.md'),
                      eligible: true,
                      modelVisible: true,
                    },
                    {
                      name: 'agent-system-issue-assessment',
                      source: 'openclaw-plugins',
                      filePath: join(root, 'SKILL.md'),
                      eligible: true,
                      modelVisible: true,
                    },
                    {
                      name: 'agent-system-issue-implementation',
                      source: 'openclaw-plugins',
                      filePath: join(root, 'SKILL.md'),
                      eligible: true,
                      modelVisible: true,
                    },
                  ],
                };
              if (method === 'cron.list') return { jobs: cronJobs };
              if (method === 'sessions.patch') {
                (multiple ? sessions.get(String(params.key))! : session!).archived =
                  params.archived;
                return { ok: true };
              }
              if (method === 'sessions.describe')
                return { session: multiple ? sessions.get(String(params.key)) : session };
              if (method === 'chat.send') {
                const feedbackTurn = (
                  await record(String(params.sessionKey))
                ).feedback?.events.find(
                  (event) => event.turn?.runId === params.idempotencyKey,
                )?.turn;
                const current = await record(String(params.sessionKey));
                const workTurn = [
                  current.decisionTurn,
                  current.work?.turn,
                  current.work?.deliveryTurn,
                  current.summaryRecovery?.turn,
                ].find((turn) => turn?.runId === params.idempotencyKey);
                const turn =
                  workTurn ??
                  feedbackTurn ??
                  (String(params.idempotencyKey).endsWith(':assessment')
                    ? (await record(String(params.sessionKey))).assessmentTurn
                    : (await record(String(params.sessionKey))).firstTurn);
                assert.equal(turn?.status, 'attempted');
                assert.equal(turn?.message, params.message);
                onSend?.();
                if (multiple) messages = histories.get(String(params.sessionKey))!.messages;
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
                        id: workTurn ? `${params.idempotencyKey}:input` : 'input-event',
                        idempotencyKey: `${params.idempotencyKey}:user`,
                      },
                    },
                  ];
                }
                if (multiple)
                  histories.set(String(params.sessionKey), { active, messages, inputReceipts });
                await afterSend?.();
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
              const saved = multiple
                ? histories.get(String(params.sessionKey))!
                : { messages, inputReceipts, active };
              const currentMessages = saved.messages;
              const currentReceipts = saved.inputReceipts;
              return {
                sessionId:
                  historySessionId ??
                  (multiple
                    ? sessions.get(String(params.sessionKey))?.sessionId
                    : session?.sessionId),
                messages: params.messageId
                  ? [...currentMessages, ...anchoredMessages].filter(
                      (entry) =>
                        (entry.__openclaw as Record<string, unknown>)?.id === params.messageId,
                    )
                  : params.limit === 1
                    ? currentMessages.slice(-1)
                    : currentMessages,
                inputReceipts: currentReceipts,
                pendingInputs: {
                  total: currentReceipts.filter((entry) => entry.state === 'pending').length,
                },
                sessionInfo: {
                  hasActiveRun: saved.active,
                  activeLeafEntryId: currentMessages.length
                    ? (currentMessages.at(-1)!.__openclaw as Record<string, unknown> | undefined)
                        ?.id
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

  let reportRun = 0;
  async function acknowledgeReport() {
    const result = await service.run(
      manifest,
      root,
      { ...coordinator, runId: 'report-' + ++reportRun },
      { action: 'report' },
    );
    assert.equal(result.status, 'reported');
  }

  it('should retain legacy dispatch custody when assigner defaults change', async () => {
    manifest.github!.notifications!.runtimes = ['openclaw', 'codex'];
    await service.dependencies.intake.run(manifest, root, 'activate');
    const routed = await next();
    await prepare(routed);
    await assess(routed.id);
    const current = await service.scope(manifest, root);
    const legacyManifestDigest = automationHash({
      policy: current.policy.legacyDigest,
      models: manifest.models,
    });
    assert.notEqual(current.manifestDigest, legacyManifestDigest);
    await current.journal.exclusive(async (state, save) => {
      state.records[0]!.manifestDigest = legacyManifestDigest;
      await save();
    });
    assert.equal((await context(routed.id)).status, 'verified');
    const workflow = manifest.github!.notifications!.issueAssignment!;
    workflow.allowed[0] = { ...workflow.allowed[0]!, nodeId: 'foreign' };
    assert.equal((await context(routed.id)).status, 'verified');
  });
  for (const pause of ['native', 'manifest'] as const)
    it(`should finish an accepted run through ${pause} pause and gate the next occurrence`, async () => {
      const routed = await next();
      const intake = service.dependencies.intake;
      const readiness = intake.readiness.bind(intake);
      if (pause === 'manifest') manifest.github!.notifications!.issueAssignment!.paused = true;
      intake.readiness = async () => 'intake-automation-paused';
      await prepare(routed);
      assert.equal(creates().length, 1);
      coordinator.runId = 'next-paused-run';
      await assert.rejects(
        service.run(manifest, root, coordinator, { action: 'next' }),
        /intake-automation-paused/u,
      );
      assert.equal(creates().length, 1);
      manifest.github!.notifications!.issueAssignment!.paused = false;
      intake.readiness = readiness;
      await service.run(manifest, root, coordinator, { action: 'next' });
      assert.equal(creates().length, 1);
      assert.equal((await record()).id, routed.id);
    });

  it('should retain the previous feedback policy check across coordinator runs', async () => {
    manifest.github!.notifications!.issueAssignment!.feedback = false;
    await next();
    const first = service.dependencies.now!();
    let now = first + 1000;
    service.dependencies.now = () => now;
    coordinator.runId = 'disabled-feedback-check';
    await next();
    assert.equal((await record()).feedback!.admission?.observedAt, now);
    manifest.github!.notifications!.issueAssignment!.feedback = true;
    now += 1000;
    coordinator.runId = 'enabled-feedback-check';
    await next();
    assert.equal((await record()).feedback!.admission?.after, first + 1000);
  });

  it('should retry a transient worktree failure on a later occurrence without creating twice', async () => {
    const input = await next();
    const original = service.dependencies.worktrees.prepareGitHub;
    service.dependencies.worktrees.prepareGitHub = async () => {
      throw new Error('session-dispatch-connect-timeout');
    };
    const failure = await prepare(input);
    assert.ok('code' in failure && failure.code === 'session-dispatch-connect-timeout');
    const retained = await record();
    assert.equal(retained.retry?.attempts, 1);
    assert.equal(creates().length, 0);
    service.dependencies.worktrees.prepareGitHub = original;
    service.dependencies.now = () => retained.retryAfter!;
    coordinator.runId = 'retry-intake';
    const retry = await next();
    assert.equal(retry.status, 'routing-required');
    assert.equal((await prepare(retry)).status, 'session-created');
    assert.equal(creates().length, 1);
  });

  it('should defer reporting during an overlapping journal operation without changing work', async () => {
    const current = await service.scope(manifest, root);
    await current.journal.exclusive(async (state) => {
      const before = structuredClone(state);
      const busy = await service.run(manifest, root, coordinator, { action: 'report' });
      assert.equal(busy.status, 'busy');
      assert.deepEqual(state, before);
    });
    assert.equal(calls.length, 0);
  });

  it('should retire only the closed owner after its deadline and preserve active sibling work', async () => {
    const { items } = await assignments(2, 2);
    const first = await next();
    await prepare(first);
    await assess(first.id);
    const second = await next();
    await prepare(second);
    await assess(second.id);
    await completeAssessment(first.id);
    await completeAssessment(second.id);
    const closed = structuredClone(await record(assessor(first.id).sessionKey));
    const sibling = structuredClone(await record(assessor(second.id).sessionKey));
    const siblingSession = structuredClone(sessions.get(sibling.threadId!)!);
    const inspect = service.dependencies.worktrees.inspectGitHub;
    const removed = new Set<string>();
    const effects: Array<[string, string]> = [];
    service.dependencies.worktrees.inspectGitHub = async (...args) => {
      const tree = await inspect(...args);
      return tree && !removed.has(tree.path) ? tree : undefined;
    };
    service.dependencies.worktrees.cleanupGitHub = async (input) => {
      effects.push([input.verifyOnly ? 'verify' : 'remove', input.worktree.path]);
      if (!input.verifyOnly) {
        removed.add(input.worktree.path);
        await rm(input.worktree.path, { recursive: true });
      }
      return {
        ...input.worktree,
        repositoryId: 'github-10',
        workId: 'issue-20',
        status: input.verifyOnly ? 'preserved' : 'removed',
      };
    };
    items[0]!.state = 'closed';
    service.dependencies.now = () => baseline + 180_001;
    await service.run(manifest, root, { ...coordinator, runId: 'close' }, { action: 'next' });
    const pending = await record(closed.threadId);
    assert.equal(pending.retirement?.reason, 'issue-closed');
    assert.equal(pending.retired, undefined);
    assert.deepEqual(effects, []);
    service.dependencies.now = () => pending.retirement!.eligibleAt;
    await service.run(manifest, root, { ...coordinator, runId: 'cleanup' }, { action: 'next' });
    assert.deepEqual(effects, [
      ['verify', closed.worktree!],
      ['remove', closed.worktree!],
    ]);
    assert.equal(sessions.get(closed.threadId!)!.archived, true);
    const retired = await record(closed.threadId);
    assert.ok(retired.retired);
    assert.deepEqual(retired.result, closed.result);
    assert.deepEqual(retired.stageReceipt, closed.stageReceipt);
    await assert.rejects(stat(closed.worktree!), { code: 'ENOENT' });
    const retained = await record(sibling.threadId);
    assert.equal(retained.retirement, undefined);
    assert.equal(retained.retired, undefined);
    assert.equal(retained.threadId, sibling.threadId);
    assert.equal(retained.worktree, sibling.worktree);
    assert.deepEqual(retained.result, sibling.result);
    assert.deepEqual(retained.stageReceipt, sibling.stageReceipt);
    assert.deepEqual(sessions.get(sibling.threadId!), siblingSession);
    assert.ok((await stat(sibling.worktree!)).isDirectory());
    assert.deepEqual(
      calls.filter((call) => call.method === 'sessions.patch').map(({ params }) => params.key),
      [closed.threadId],
    );
    await service.run(manifest, root, { ...coordinator, runId: 'again' }, { action: 'next' });
    assert.equal(effects.length, 2);
  });

  it('should archive all eligible owners before removing a shared checkout once', async () => {
    const { items } = await assignments(2, 2);
    const sharedTree = {
      path: join(root, 'shared'),
      branch: 'shared',
      repositoryId: 'github-10',
      workId: 'shared',
      status: 'existing' as const,
    };
    await mkdir(sharedTree.path);
    let removals = 0;
    service.dependencies.worktrees.prepareGitHub = async () => sharedTree;
    service.dependencies.worktrees.inspectGitHub = async () => (removals ? undefined : sharedTree);
    service.dependencies.worktrees.cleanupGitHub = async (input) => {
      if (!input.verifyOnly) {
        assert.ok([...sessions.values()].every((entry) => entry.archived));
        removals++;
      }
      return { ...sharedTree, status: input.verifyOnly ? 'preserved' : 'removed' };
    };
    await prepare(await next());
    await prepare(await next());
    for (const item of items) item.state = 'closed';
    service.dependencies.now = () => baseline + 180_001;
    await service.run(manifest, root, { ...coordinator, runId: 'close' }, { action: 'next' });
    const deadline = (await record()).retirement!.eligibleAt;
    service.dependencies.now = () => deadline;
    await service.run(manifest, root, { ...coordinator, runId: 'cleanup' }, { action: 'next' });
    service.dependencies.now = () => deadline + 60_000;
    await service.run(manifest, root, { ...coordinator, runId: 'finish' }, { action: 'next' });
    const state = await (await service.scope(manifest, root)).journal.read();
    assert.ok(state.records.every((entry) => entry.retired));
    assert.equal(removals, 1);
    assert.equal(calls.filter((call) => call.method === 'sessions.patch').length, 2);
  });

  it('should reconcile interrupted worktree removal without repeating native archival or removal', async () => {
    await prepare(await next());
    const inspect = service.dependencies.worktrees.inspectGitHub;
    let removed = false;
    let removals = 0;
    service.dependencies.worktrees.inspectGitHub = async (...args) =>
      removed ? undefined : inspect(...args);
    service.dependencies.worktrees.cleanupGitHub = async (input) => {
      if (!input.verifyOnly) {
        removals++;
        await rm(input.worktree.path, { recursive: true, force: true });
        removed = true;
        throw new Error('lost-cleanup-response');
      }
      return {
        ...input.worktree,
        repositoryId: 'github-10',
        workId: 'issue-20',
        status: 'preserved',
      };
    };
    fixture.item.state = 'closed';
    await service.run(manifest, root, coordinator, { action: 'next' });
    const deadline = (await record()).retirement!.eligibleAt;
    service.dependencies.now = () => deadline;
    await service.run(manifest, root, { ...coordinator, runId: 'cleanup' }, { action: 'next' });
    assert.equal((await record()).retirement?.code, 'lost-cleanup-response');
    assert.equal((await record()).retired, undefined);
    service = new OpenClawDispatch({ ...service.dependencies, now: () => deadline + 60_000 });
    await service.run(manifest, root, { ...coordinator, runId: 'recover' }, { action: 'next' });
    assert.ok((await record()).retired);
    assert.equal(removals, 1);
    assert.equal(calls.filter((call) => call.method === 'sessions.patch').length, 1);
  });

  it('should reconcile external worktree removal after verifying historical session custody', async () => {
    await prepare(await next());
    const current = await service.scope(manifest, root);
    await current.journal.exclusive(async (state, save) => {
      const saved = state.records[0]!;
      const request = saved.request!;
      assert.ok('key' in request);
      const creation = saved.sessionCreation!;
      saved.request = {
        task: 'retained task',
        label: request.label,
        cwd: request.cwd,
        model: request.model,
        runtime: 'subagent',
        visible: true,
        cleanup: 'keep',
      };
      saved.creationCall = {
        sessionId: creation.sourceSessionId,
        runId: creation.sourceRunId,
        toolCallId: creation.sourceToolCallId,
      };
      saved.native = {
        sessionKey: request.key,
        sessionId: creation.sessionId!,
        sourceSessionId: creation.sourceSessionId,
        toolCallId: creation.sourceToolCallId,
        runId: 'historical-child',
      };
      delete saved.sessionCreation;
      delete saved.feedback;
      saved.phase = 'blocked';
      await save();
    });
    const before = structuredClone(await record());
    service.dependencies.worktrees.inspectGitHub = async () => undefined;
    service.dependencies.worktrees.cleanupGitHub = async () => {
      throw new Error('must-not-remove');
    };
    fixture.item.state = 'closed';
    await service.run(manifest, root, coordinator, { action: 'next' });
    const deadline = (await record()).retirement!.eligibleAt;
    service.dependencies.now = () => deadline;
    await service.run(
      manifest,
      root,
      { ...coordinator, runId: 'still-present' },
      { action: 'next' },
    );
    assert.equal((await record()).retirement?.code, 'retirement-worktree-observation-required');
    assert.equal(session!.archived, undefined);
    await rm(before.worktree!, { recursive: true });
    service = new OpenClawDispatch({ ...service.dependencies, now: () => deadline + 60_000 });
    await service.run(
      manifest,
      root,
      { ...coordinator, runId: 'external-cleanup' },
      { action: 'next' },
    );
    const after = await record();
    assert.ok(after.retired);
    assert.deepEqual(after.native, before.native);
    assert.deepEqual(after.creationCall, before.creationCall);
    assert.deepEqual(after.request, before.request);
    assert.equal(after.sessionCreation, undefined);
    assert.equal(after.retirement?.worktreeRemovalAttemptedAt, undefined);
    assert.deepEqual(after.retirement?.worktreeRemovalObserved, {
      at: deadline + 60_000,
      source: 'external-cleanup',
    });
    service.dependencies.now = () => deadline + 120_000;
    await service.run(manifest, root, { ...coordinator, runId: 'repeat' }, { action: 'next' });
    assert.equal(calls.filter((call) => call.method === 'sessions.patch').length, 1);
    assert.equal(creates().length, 1);
  });

  it('should preserve a session targeted by a native automation', async () => {
    await prepare(await next());
    cronJobs = [{ sessionTarget: `session:${(await record()).threadId}` }];
    fixture.item.state = 'closed';
    await service.run(manifest, root, coordinator, { action: 'next' });
    const deadline = (await record()).retirement!.eligibleAt;
    service.dependencies.now = () => deadline;
    service.dependencies.worktrees.cleanupGitHub = async () => {
      throw new Error('must-not-remove');
    };
    await service.run(manifest, root, { ...coordinator, runId: 'cleanup' }, { action: 'next' });
    assert.equal((await record()).retirement?.code, 'retirement-automation-owner');
    assert.equal(session!.archived, undefined);
  });

  it('should preserve pinned sessions and worktrees while excluding them from active intake', async () => {
    await prepare(await next());
    session!.pinned = true;
    fixture.item.state = 'closed';
    await service.run(manifest, root, coordinator, { action: 'next' });
    const pending = await record();
    service.dependencies.now = () => pending.retirement!.eligibleAt;
    service.dependencies.worktrees.cleanupGitHub = async () => {
      throw new Error('must-not-remove');
    };
    await service.run(manifest, root, { ...coordinator, runId: 'cleanup' }, { action: 'next' });
    assert.equal((await record()).retirement?.code, 'retirement-native-resource-protected');
    assert.equal(session!.archived, undefined);
    assert.equal((await record()).retired, undefined);
  });

  it('should report scheduler drift and its recovery without creating issue sessions', async () => {
    const intake = service.dependencies.intake;
    const readiness = intake.readiness.bind(intake);
    intake.readiness = async () => 'intake-automation-update-required';
    const warning = await service.run(manifest, root, coordinator, { action: 'report' });
    assert.ok('response' in warning && typeof warning.response === 'string');
    assert.match(warning.response, /intake-automation-update-required/);
    assert.match(warning.response, /Agent System Install/);
    intake.readiness = readiness;
    const recovered = await service.run(
      manifest,
      root,
      { ...coordinator, runId: 'resumed' },
      { action: 'report' },
    );
    assert.ok('response' in recovered && typeof recovered.response === 'string');
    assert.match(recovered.response, /Intake resumed/);
    assert.match(recovered.response, /condition has cleared/);
    assert.equal(calls.filter((call) => call.method === 'sessions.create').length, 0);
  });

  it('should prepare the same intake report on retry and suppress its blocker after restart', async () => {
    const routed = await next();
    removeFixtureAssignment(fixture);
    await prepare(routed);
    const intake = service.dependencies.intake;
    const run = intake.run;
    let scans = 0;
    intake.run = async (...args) => {
      scans++;
      return run.apply(intake, args);
    };
    const first = await service.run(manifest, root, coordinator, { action: 'report' });
    assert.equal(first.status, 'reported');
    assert.ok(
      'response' in first &&
        typeof first.response === 'string' &&
        first.response.includes('Diagnostic'),
    );
    const replay = await new OpenClawDispatch(service.dependencies).run(
      manifest,
      root,
      coordinator,
      { action: 'report' },
    );
    assert.deepEqual(replay, {
      ...first,
      instructions: 'Reproduce response unchanged. An empty response means no card.',
    });
    assert.equal(scans, 0, 'reporting must not discover or admit more assignments');
    intake.run = run;
    assert.equal((await service.check(manifest, root)).changed, true);
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(calls.filter((call) => call.method === 'sessions.create').length, 0);
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
  async function record(key?: string) {
    const records = (await (await service.scope(manifest, root)).journal.read()).records;
    return (key ? records.find((record) => record.threadId === key) : records[0])!;
  }
  const creates = () => calls.filter(({ method }) => method === 'sessions.create');

  async function assignments(count: number, limit: number) {
    multiple = true;
    manifest.github!.notifications!.maxConcurrentItems = limit;
    const items = Array.from({ length: count }, (_, index) => ({
      ...fixture.item,
      nodeId: index ? `I_issue_${index}` : fixture.item.nodeId,
      databaseId: 20 + index,
      number: 3 + index,
    }));
    const events = items.map((_, index) => ({
      ...fixture.events[0]!,
      nodeId: index ? `E_assignment_${index}` : fixture.events[0]!.nodeId,
      databaseId: 30 + index,
      createdAt: new Date(baseline + 60000 + index * 1000).toISOString(),
    }));
    fixture.client.discoverAssigned = async () => ({
      candidates: items
        .toReversed()
        .map((item) => ({ ...item, repositoryPath: '/repos/owner/repo' })),
      incomplete: false,
      totalCount: items.length,
      truncated: false,
    });
    fixture.client.getItem = async (_owner, _name, number) =>
      items.find((item) => item.number === number)!;
    fixture.client.listAssignmentEvents = async (_owner, _name, number) => ({
      events: [events[number - 3]!],
      truncated: false,
    });
    // both consumers share this injected provider, including live assignment reauthorization.
    service.dependencies.connect = async () => ({
      ...fixture.client,
      getItemContext: async () => ({
        title: 'Repair',
        body: 'Return result.',
        comments: [],
        labels: [],
        truncated: false,
      }),
    });
    const intake = service.dependencies.intake;
    intake.dependencies.now = () => baseline;
    await intake.run(manifest, root, 'activate');
    intake.dependencies.now = () => baseline + 120000;
    await intake.run(
      manifest,
      root,
      'scan',
      (await intake.select(manifest, root)).selected!.digest,
    );
    return { items, events };
  }

  async function retainConfirmedSummary(id: string) {
    const journal = (await service.scope(manifest, root)).journal;
    await journal.exclusive(async (state, save) => {
      const entry = state.records.find((record) => record.id === id)!;
      // these unrelated workflow fixtures represent a fully delivered assessment.
      entry.assessmentSummaries = [
        {
          revision: entry.assessmentRevision!,
          resultDigest: automationHash(entry.result),
          binding: entry.stageReceipt!.binding,
          turnId: entry.resultTurnId!,
          authorityDigest: 'a'.repeat(64),
          selection: entry.assessment!,
          publicText: 'The proposed change restores the result.',
          receipt: { nodeId: 'SUMMARY_' + id, databaseId: 901 },
        },
      ];
      await save();
    });
  }
  async function completeAssessment(id: string) {
    assert.equal((await context(id)).status, 'verified');
    assert.equal((await submit(id)).status, 'recorded');
    const history = histories.get(assessor(id).sessionKey)!;
    history.active = false;
    history.inputReceipts = [];
    history.messages.push({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Retained plan.' }],
      __openclaw: { id: `reply-${id}`, runId: `${id}:assessment`, runTerminal: true },
    });
    const completed = await assess(id);
    assert.equal(completed.status, 'assessment-completed', JSON.stringify(completed));
    await retainConfirmedSummary(id);
  }
  it('should use an available slot for the next assignment after an item validation failure', async () => {
    const { items } = await assignments(2, 1);
    items[0]!.assignees = [];
    const failed = await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal(failed.status, 'blocked');
    assert.ok('nextAction' in failed && failed.nextAction === 'next');
    const second = await next();
    const current = await service.scope(manifest, root);
    const selected = (await current.journal.read()).records.find(
      (record) => record.id === second.id,
    )!;
    assert.equal(
      current.admitted.records.find((intake) => intake.id === selected.intakeId)!.issue.number,
      4,
    );
    assert.equal((await prepare(second)).status, 'session-created');
    assert.equal(creates().length, 1);
  });

  for (const [limit, occupied, expected] of [
    [3, 0, 3],
    [3, 1, 2],
    [3, 3, 0],
    [1, 0, 1],
    [5, 0, 5],
  ] as const) {
    it(`should fill ${expected} initially free slots with limit ${limit} and ${occupied} occupied`, async () => {
      await assignments(limit + 3, limit);
      for (let index = 0; index < occupied; index++) {
        const input = await next();
        await prepare(input);
        await assess(input.id);
      }
      const who = { ...coordinator, runId: 'scheduled-pass' };
      for (let index = 0; index < occupied; index++) {
        const recovery = await service.run(manifest, root, who, { action: 'next' });
        assert.equal(recovery.status, 'reconcile-required');
        assert.ok('id' in recovery);
        assert.equal(
          (
            await service.run(manifest, root, who, {
              action: 'reconcile',
              id: recovery.id as string,
            })
          ).status,
          'assessment-pending',
        );
      }
      const ids = [];
      for (let index = 0; index < expected; index++) {
        const input = await service.run(manifest, root, who, { action: 'next' });
        assert.ok(
          'digest' in input &&
            'id' in input &&
            typeof input.digest === 'string' &&
            typeof input.id === 'string',
        );
        ids.push(input.id);
        assert.equal(
          (
            await service.run(manifest, root, who, {
              action: 'prepare',
              id: input.id,
              digest: input.digest,
              title: 'repair the result',
              assessment: { complexity: 'medium', reason: 'Bounded fixture.' },
            })
          ).status,
          'session-created',
        );
        assert.equal(
          (await service.run(manifest, root, who, { action: 'assess', id: input.id })).status,
          'assessment-pending',
        );
      }
      const state = await (await service.scope(manifest, root)).journal.read();
      assert.equal(state.records.filter((record) => record.request).length, occupied + expected);
      assert.equal(creates().length, occupied + expected);
      assert.equal(sends().length, occupied + expected);
      assert.equal(
        new Set(state.records.map((record) => record.threadId)).size,
        occupied + expected,
      );
      assert.equal(
        state.records.every((record) => !record.result),
        true,
      );
      assert.equal(new Set(ids).size, expected);
      const terminal = await service.run(manifest, root, who, { action: 'next' });
      assert.equal(terminal.status, occupied + expected ? 'pass-completed' : 'at-capacity');
      assert.equal(
        (await service.run(manifest, root, who, { action: 'next' })).status,
        terminal.status,
      );
    });
  }

  it('should persist exhaustion across reconstruction without replenishing fast completions', async () => {
    await assignments(6, 3);
    for (let index = 0; index < 3; index++) {
      const input = await next();
      assert.equal((await prepare(input)).status, 'session-created');
      await assess(input.id);
      await completeAssessment(input.id);
      service = new OpenClawDispatch(service.dependencies);
    }
    for (let index = 0; index < 2; index++)
      assert.equal(
        (await service.run(manifest, root, coordinator, { action: 'next' })).status,
        'pass-completed',
      );
    assert.equal(creates().length, 3);
    const state = await (await service.scope(manifest, root)).journal.read();
    assert.deepEqual(
      creates().map(({ params }) => params.label),
      ['#3: REPAIR THE RESULT', '#4: REPAIR THE RESULT', '#5: REPAIR THE RESULT'],
    );
    const later = { ...coordinator, runId: 'later-pass' };
    const input = await service.run(manifest, root, later, { action: 'next' });
    assert.equal(input.status, 'routing-required');
    assert.equal(state.openclawPasses![0]!.selected.length, 3);
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'next' })).status,
      'pass-completed',
    );
  });

  it('should not absorb assignments admitted after the native pass snapshot', async () => {
    await assignments(2, 3);
    const first = await next();
    await prepare(first);
    await assess(first.id);
    await assignments(4, 3);
    const second = await next();
    await prepare(second);
    await assess(second.id);
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'next' })).status,
      'pass-completed',
    );
    assert.equal(creates().length, 2);
    const later = await service.run(
      manifest,
      root,
      { ...coordinator, runId: 'new-admissions' },
      { action: 'next' },
    );
    assert.equal(later.status, 'reconcile-required');
  });

  it('should recheck authoritative capacity when another reservation arrives before preparation', async () => {
    await assignments(4, 2);
    const first = await next();
    await prepare(first);
    await assess(first.id);
    const second = await next();
    const current = await service.scope(manifest, root);
    await current.journal.exclusive(async (state, save) => {
      const reservation = structuredClone(state.records[0]!);
      const admission = current.admitted.records.find(
        (entry) => !state.records.some((record) => record.intakeId === entry.id),
      )!;
      reservation.id = 'f'.repeat(64);
      reservation.intakeId = admission.id;
      reservation.issueKey = issueKey(admission);
      reservation.threadId = `agent:receiver:dashboard:agent-system-issue-${reservation.id}`;
      assert.ok(reservation.request && 'key' in reservation.request);
      reservation.request.key = reservation.threadId;
      reservation.request.idempotencyKey = reservation.id;
      delete reservation.assessmentTurn;
      delete reservation.assessment;
      reservation.phase = 'created';
      state.records.push(reservation);
      await save();
    });
    assert.equal((await prepare(second)).status, 'at-capacity');
    assert.equal(creates().length, 1);
    assert.equal(preparedWorktrees, 1);
  });

  it('should reserve uncertain creations across restart and refuse new work at full capacity', async () => {
    await assignments(4, 1);
    const input = await next();
    lost = true;
    absent = true;
    await prepare(input);
    service = new OpenClawDispatch(service.dependencies);
    assert.equal(
      (await service.run(manifest, root, { ...coordinator, runId: 'later' }, { action: 'next' }))
        .status,
      'at-capacity',
    );
    assert.equal(creates().length, 1);
  });

  it('should require this native run selection before preparing', async () => {
    await assignments(4, 1);
    const input = await next();
    const foreign = { ...coordinator, runId: 'unselected' };
    const unauthorized = await service.run(manifest, root, foreign, {
      action: 'prepare',
      id: input.id,
      digest: input.digest,
      title: 'repair the result',
      assessment: { complexity: 'medium', reason: 'Bounded fixture.' },
    });
    assert.ok('code' in unauthorized && unauthorized.code === 'dispatch-pass-selection-required');
    assert.equal(creates().length, 0);
  });

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

  it('should reuse one connection and keep gateway reads free of repeated provider authorization', async () => {
    const input = await next();
    const connect = service.dependencies.connect;
    let connections = 0,
      repositories = 0;
    service.dependencies.connect = async (...args) => {
      connections++;
      const client = await connect(...args);
      return {
        ...client,
        async getRepository(...coordinates) {
          repositories++;
          return client.getRepository(...coordinates);
        },
      };
    };
    assert.equal((await prepare(input)).status, 'session-created');
    assert.equal(connections, 1);
    // Action admission and the actual create boundary, regardless of native guard count.
    assert.equal(repositories, 2);
    repositories = connections = 0;
    await service.run(manifest, root, coordinator, { action: 'reconcile', id: input.id });
    assert.equal(connections, 1);
    assert.equal(repositories, 1);
  });

  it('should catch assignment revocation during preparation before creating a session', async () => {
    const input = await next();
    const prepareWorktree = service.dependencies.worktrees.prepareGitHub;
    service.dependencies.worktrees.prepareGitHub = async (...args) => {
      const result = await prepareWorktree(...args);
      fixture.item.assignees = [];
      return result;
    };
    const result = await prepare(input);
    assert.equal(result.status, 'blocked');
    assert.ok('code' in result && result.code === 'dispatch-assignment-removed');
    assert.equal(creates().length, 0);
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
    removeFixtureAssignment(fixture);
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'next' })).status,
      'blocked',
    );
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, true);
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(preparedWorktrees, 0);
    assert.equal(calls.length, 0);
  });

  it('should reconcile a lost creation response after rebuilding the service without creating again', async () => {
    const input = await next();
    lost = true;
    assert.equal((await prepare(input)).status, 'waiting');
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
    await acknowledgeReport();
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
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, false);
  });
  for (const missing of [false, true])
    it(`should reconcile a superseded ${missing ? 'unknown' : 'created'} session without creating again`, async () => {
      const input = await next();
      lost = true;
      absent = missing;
      await prepare(input);
      const current = await service.scope(manifest, root);
      const event = {
        ...fixture.events[0]!,
        nodeId: 'E_successor',
        databaseId: fixture.events[0]!.databaseId + 1,
        createdAt: new Date(baseline + 90000).toISOString(),
      };
      fixture.events.push(event);
      await current.store.exclusive(async (state, save) => {
        const original = state!.records[0]!;
        state!.records.push({
          ...original,
          id: automationHash([
            state!.scope,
            original.repository.nodeId,
            original.issue.nodeId,
            event.nodeId,
          ]),
          assignment: { ...event, event: 'assigned' },
        });
        await save(state!);
      });
      coordinator.runId = 'successor-intake';
      await service.run(manifest, root, coordinator, { action: 'next' });
      const retained = await record();
      assert.equal(retained.sessionCreation?.verified, missing ? undefined : true);
      assert.equal(
        retained.blocker,
        missing ? 'dispatch-session-reconcile-required' : 'dispatch-assignment-superseded',
      );
      assert.equal(creates().length, 1);
      assert.equal(retained.intakeId, current.admitted.records[0]!.id);
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

  it('should preserve cancellation while allowing a coordinator to inspect pending creation', async () => {
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
    try {
      assert.deepEqual(
        await service.run(
          manifest,
          root,
          { ...coordinator, runId: 'overlapping-run' },
          { action: 'next' },
        ),
        {
          status: 'reconcile-required',
          id: input.id,
        },
      );
    } finally {
      controller.abort();
      release.resolve();
      await first;
    }
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

  it('should reject changed session identity settings and unexpected activity', async () => {
    const input = await next();
    await prepare(input);
    const original = { ...session! };
    for (const [change, field] of [
      [{ key: 'agent:receiver:other' }, 'key'],
      [{ sessionId: 'replacement' }, 'sessionId'],
      [{ agentId: 'other' }, 'agentId'],
      [{ model: 'other/model' }, 'model'],
      [{ thinkingLevel: 'low' }, 'thinkingLevel'],
      [{ spawnedCwd: '/' }, 'cwd'],
      [{ parentSessionKey: 'agent:other:main' }, 'parentSessionKey'],
      [{ parentSessionKey: 'agent:receiver:unrelated' }, 'parentSessionKey'],
      [{ spawnedBy: 'agent:receiver:main' }, 'spawnedBy'],
      [{ spawnDepth: 1 }, 'spawnDepth'],
      [{ archived: true }, 'archived'],
    ] as const) {
      session = { ...original, ...change };
      const result = await service.run(manifest, root, coordinator, {
        action: 'reconcile',
        id: input.id,
      });
      assert.ok('code' in result && result.code === 'dispatch-session-mismatch');
      assert.ok('mismatchedField' in result && result.mismatchedField === field);
      assert.doesNotMatch(
        JSON.stringify(result),
        /replacement|other\/model|agent:other:main|agent:receiver:unrelated/u,
      );
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

  it('should continue the same issue after cosmetic session edits', async () => {
    const input = await next();
    await prepare(input);
    session = { ...session!, label: 'Renamed by the operator', category: 'Other group' };
    const result = await service.run(manifest, root, coordinator, {
      action: 'reconcile',
      id: input.id,
    });
    assert.notEqual('code' in result ? result.code : undefined, 'dispatch-session-mismatch');
    assert.equal(creates().length, 1);
  });

  it('should accept an unlinked session and only the configured same-agent main parent', async () => {
    const input = await next();
    assert.equal((await prepare(input)).status, 'session-created');
    assert.equal(session!.parentSessionKey, 'agent:receiver:main');
    config = { session: { mainKey: 'inbox' } };
    session!.parentSessionKey = 'agent:receiver:inbox';
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'reconcile', id: input.id }))
        .status,
      'session-created',
    );
    for (const settings of [
      { mainKey: 'other' },
      { mainKey: 'inbox', dmScope: 'per-channel-peer' },
      { mainKey: 'inbox', scope: 'global' },
    ] as const) {
      config = { session: settings };
      const blocked = await service.run(manifest, root, coordinator, {
        action: 'reconcile',
        id: input.id,
      });
      assert.ok('code' in blocked && blocked.code === 'dispatch-session-mismatch');
      assert.ok('mismatchedField' in blocked && blocked.mismatchedField === 'parentSessionKey');
    }
    delete session!.parentSessionKey;
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'reconcile', id: input.id }))
        .status,
      'session-created',
    );
    assert.equal(creates().length, 1);
  });

  it('should recover a retained parent mismatch without creating a replacement session', async () => {
    const input = await next();
    config = { session: { mainKey: 'other' } };
    const blocked = await prepare(input);
    assert.ok('mismatchedField' in blocked && blocked.mismatchedField === 'parentSessionKey');
    const previous = await record();
    config = {};
    service = new OpenClawDispatch(service.dependencies);
    const recovered = await service.run(manifest, root, coordinator, {
      action: 'reconcile',
      id: input.id,
    });
    assert.equal(recovered.status, 'session-created');
    assert.ok('effect' in recovered && recovered.effect === 'reconciled');
    assert.equal((await record()).sessionCreation?.sessionId, previous.sessionCreation?.sessionId);
    assert.deepEqual((await record()).request, previous.request);
    assert.equal(creates().length, 1);
    assert.equal(preparedWorktrees, 1);
  });

  it('should keep classified preparation failures value-free and explicitly retryable', async () => {
    service.dependencies.worktrees.prepareGitHub = async () => {
      throw Object.assign(new AgentSystemToolError('execution_failed', 'SECRET'), {
        cause: new GitCommandError('fetch', {
          exitCode: 128,
          stderr: 'Could not resolve host: private-host token=SECRET',
        }),
      });
    };
    const input = await next();
    const failure = await prepare(input);
    assert.equal(
      'providerDiagnostic' in failure && failure.providerDiagnostic?.classification,
      'transport',
    );
    assert.deepEqual(
      { ...failure, providerDiagnostic: undefined },
      {
        providerDiagnostic: undefined,
        status: 'retrying',
        nextAction: 'next',
        id: input.id,
        code: 'git-fetch-dns-exit-128',
        stage: 'worktree',
      },
    );
    assert.equal(JSON.stringify(await record()).includes('SECRET'), false);
    await acknowledgeReport();
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
      delete old.feedback;
      delete old.sessionCreation;
      delete old.effective;
      delete old.threadId;
      old.phase = 'creating';
      await save();
    });
    await acknowledgeReport();
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
    assert.deepEqual(
      await service.run(
        manifest,
        root,
        { ...coordinator, runId: 'recovery-created' },
        { action: 'next' },
      ),
      {
        status: 'assessment-required',
        id: input.id,
      },
    );
    assert.equal((await start(input.id)).status, 'working-turn-pending');
    const sent = sends()[0]!.params;
    assert.equal(sent.sessionId, 'ordinary-id');
    assert.equal(sent.deliver, false);
    assert.equal(sent.expectedLeafEntryId, null);
    assert.equal(sent.thinking, undefined);
    assert.match(String(sent.message), /Return the missing result/);
    assert.match(String(sent.message), /untrusted issue evidence/);
    assert.match(String(sent.message), /Do not change files/);
    assert.deepEqual(
      await service.run(
        manifest,
        root,
        { ...coordinator, runId: 'recovery-pending' },
        { action: 'next' },
      ),
      {
        status: 'reconcile-required',
        id: input.id,
      },
    );
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
    assert.equal((await start(input.id)).status, 'waiting');
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
    assert.deepEqual(
      await service.run(
        manifest,
        root,
        { ...coordinator, runId: 'recovery-pending' },
        { action: 'next' },
      ),
      {
        status: 'reconcile-required',
        id: input.id,
      },
    );
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
      assert.equal((await start(input.id)).status, 'waiting');
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
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, false);
  });

  it('should preserve explicit cancellation after its pending receipt disappears', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
    inputReceipts[0]!.cancelled = true;
    const cancelled = await start(input.id);
    assert.ok('code' in cancelled && cancelled.code === 'dispatch-turn-cancelled');
    assert.equal(openClawCapacity([await record()], 1).occupied, 1);
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, false);
    waitResult = { status: 'error' };
    active = false;
    inputReceipts = [];
    const failed = await finish(input.id);
    assert.ok('code' in failed && failed.code === 'dispatch-turn-cancelled');
    await service.check(manifest, root);
    assert.equal(openClawCapacity([await record()], 1).occupied, 0);
    assert.equal((await record()).firstTurn?.replyEventId, undefined);
    await acknowledgeReport();
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
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(
      (
        await service.run(
          manifest,
          root,
          { ...coordinator, runId: 'capacity-check' },
          { action: 'next' },
        )
      ).status,
      'at-capacity',
    );
  });

  it('should reject unrelated messages busy sessions and replaced incarnations before a first send', async () => {
    const input = await next();
    await prepare(input);
    messages = [{ role: 'user', content: 'unrelated' }];
    assert.equal((await start(input.id)).status, 'waiting');
    messages = [];
    active = true;
    assert.equal((await start(input.id)).status, 'waiting');
    active = false;
    session!.sessionId = 'replacement';
    assert.equal((await start(input.id)).status, 'waiting');
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
    removeFixtureAssignment(fixture);
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
    assert.equal((await start(input.id)).status, 'waiting');
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

  it('should reserve only one send when concurrent first-turn operations overlap', async () => {
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
    try {
      assert.equal((await start(input.id)).status, 'working-turn-pending');
    } finally {
      release.resolve();
      await first;
    }
    assert.ok('code' in (await first) && (await first).status === 'waiting');
    assert.equal((await start(input.id)).status, 'working-turn-pending');
    assert.equal(sends().length, 1);
  });

  it('should preserve an attempted send when a lock error occurs after entering the journal', async () => {
    const input = await next();
    await prepare(input);
    const result = await start(input.id, {
      assertCurrent: async () => {
        if ((await record()).firstTurn)
          throw Object.assign(new Error('The private state file lock is busy.'), {
            code: privateStateFileLockBusyErrorCode,
          });
      },
    });
    assert.equal(result.status, 'retrying');
    assert.ok('code' in result && result.code === privateStateFileLockBusyErrorCode);
    assert.equal((await record()).firstTurn?.status, 'attempted');
    assert.equal((await start(input.id)).status, 'waiting');
    assert.equal(sends().length, 0);
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
    assert.equal((await start(input.id)).status, 'waiting');
    assert.equal(sends().length, 0);
  });

  it('should reject mismatched terminal evidence without claiming completion', async () => {
    const input = await next();
    await prepare(input);
    await start(input.id);
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
    sessionId: multiple ? `ordinary-${id}` : 'ordinary-id',
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

  async function readyWork(mode: 'plan' | 'work' | 'auto', decision?: 'plan' | 'work') {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    await submit(
      input.id,
      decision
        ? {
            ...plan,
            decision: { mode: decision, reasons: ['Bounded work.'] },
          }
        : plan,
    );
    assessmentReply(input.id);
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    await retainConfirmedSummary(input.id);
    manifest.github!.notifications!.issueAssignment!.mode = mode;
    return input.id;
  }
  const workPass = (runId: string) =>
    service.run(manifest, root, { ...coordinator, runId }, { action: 'next' });

  for (const mode of ['work', 'auto'] as const)
    it(`should hand ${mode} directly from assessment to implementation without a coordinator send`, async () => {
      manifest.github!.notifications!.issueAssignment!.mode = mode;
      const input = await next();
      await prepare(input);
      await assess(input.id);
      await context(input.id);
      const assessment: AssessmentResult = {
        ...plan,
        reviewSummary:
          'You would receive the missing result. Docs clarify it; tests cover the return.',
        ...(mode === 'auto' ? { decision: { mode: 'work', reasons: ['Ready.'] } } : {}),
      };
      const result = await submit(input.id, assessment);
      assert.ok(
        'presentation' in result && result.presentation?.includes(assessment.reviewSummary!),
      );
      assert.ok(
        'presentation' in result && !result.presentation?.includes(assessment.fullAssessment!),
      );
      const detailed = await service.run(manifest, root, assessor(input.id), {
        action: 'present',
        id: input.id,
        includeDetails: true,
      });
      assert.ok(
        'presentation' in detailed && detailed.presentation?.includes(assessment.fullAssessment!),
      );
      assert.ok('handoff' in result && result.handoff?.next === 'implementation');
      inputReceipts = [];
      const who = assessor(input.id);
      const verified = await service.run(manifest, root, who, {
        action: 'implementation-context',
        id: input.id,
      });
      assert.equal(verified.status, 'verified', JSON.stringify(verified));
      assert.ok('assessment' in verified);
      assert.deepEqual(verified.assessment, assessment);
      assert.deepEqual((await record()).result, assessment);
      assert.equal((await record()).work?.turn?.runId, who.runId);
      assert.equal((await record()).work?.turn?.origin, 'assessment');
      assert.equal((await record()).progression?.via, mode);
      assert.equal(sends().length, 1);
      await service.run(manifest, root, who, {
        action: 'implementation-result',
        id: input.id,
        implementationResult: { outcome: 'done', summary: 'Done.', fullResult: 'Validated.' },
      });
      const originalInput = structuredClone((await record()).work!.implementation);
      messages.push({
        role: 'user',
        content: 'Continue with a follow-up commit.',
        idempotencyKey: 'followup:user',
        __openclaw: { id: 'followup-input', idempotencyKey: 'followup:user', senderIsOwner: true },
      });
      const followup = { ...who, runId: 'followup' };
      const handoff = {
        action: 'handoff' as const,
        id: input.id,
        permission: 'implementation-and-publication' as const,
      };
      const preview = await service.run(manifest, root, followup, handoff, true);
      assert.ok('digest' in preview && typeof preview.digest === 'string');
      const handedOff = await service.run(
        manifest,
        root,
        followup,
        { ...handoff, digest: preview.digest },
        true,
      );
      assert.equal(handedOff.status, 'handed-off', JSON.stringify(handedOff));
      assert.deepEqual((await record()).work!.implementation, originalInput);
      assert.equal(
        (
          await service.run(
            manifest,
            root,
            followup,
            { action: 'implementation-context', id: input.id },
            true,
          )
        ).status,
        'verified',
      );
      assert.equal((await record()).work!.caller!.runId, 'followup');
      assessmentReply(input.id);
      service = new OpenClawDispatch(service.dependencies);
      await workPass('recover-direct-delivery');
      assert.equal((await record()).work?.result?.outcome, 'done');
      assert.equal((await record()).work?.deliveryTurn?.runId, `${input.id}:delivery`);
      assert.equal(sends().length, 2);
      assert.equal(creates().length, 1);
    });

  for (const legacy of [false, true])
    it(`should recover ${legacy ? 'legacy' : 'current'} interrupted operator work without another approval or assessment`, async () => {
      const id = await readyWork('plan');
      const who = { ...assessor(id), runId: 'operator-implementation' };
      messages.push({
        role: 'user',
        content: 'Implement the plan.',
        idempotencyKey: `${who.runId}:user`,
        __openclaw: {
          id: 'operator-input',
          idempotencyKey: `${who.runId}:user`,
          senderIsOwner: true,
        },
      });
      const verified = await service.run(
        manifest,
        root,
        who,
        { action: 'implementation-context', id },
        true,
      );
      assert.equal(verified.status, 'verified');
      assert.equal((await record()).work?.turn?.origin, 'input');
      assert.equal((await record()).work?.turn?.runId, who.runId);
      if (legacy) {
        const scope = await service.scope(manifest, root);
        await scope.journal.exclusive(async (state, save) => {
          delete state.records[0]!.work!.turn;
          await save();
        });
      }
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'Interrupted before result.' }],
        stopReason: 'stop',
        __openclaw: {
          id: 'operator-reply',
          runId: who.runId,
          mirrorOrigin: 'codex-app-server',
          runTerminal: true,
        },
      });
      service = new OpenClawDispatch(service.dependencies);
      let recovered = await workPass('recover-operator-work');
      if (legacy) {
        assert.equal(recovered.status, 'implementation-incomplete', JSON.stringify(recovered));
        assert.ok('nextAction' in recovered && recovered.nextAction === 'next');
        recovered = await workPass('continue-recovered-operator-work');
      }
      assert.equal(recovered.status, 'implementation-pending', JSON.stringify(recovered));
      const saved = await record();
      assert.equal(saved.work?.previousTurns?.[0]?.turn.runId, who.runId);
      assert.equal(saved.work?.turn?.runId, `${id}:implementation:resume:1`);
      assert.equal(saved.progression?.via, 'operator');
      assert.deepEqual(saved.result, plan);
      assert.equal(creates().length, 1);
      assert.equal(sends().length, 2);
    });

  for (const outcome of ['interrupted', 'clarification-needed'] as const)
    it(`should recover direct work after ${outcome} without repeating assessment or approval`, async () => {
      manifest.github!.notifications!.issueAssignment!.mode = 'work';
      const input = await next();
      await prepare(input);
      await assess(input.id);
      await context(input.id);
      await submit(input.id, plan);
      inputReceipts = [];
      const who = assessor(input.id);
      await service.run(manifest, root, who, { action: 'implementation-context', id: input.id });
      if (outcome === 'clarification-needed')
        await service.run(manifest, root, who, {
          action: 'implementation-result',
          id: input.id,
          implementationResult: {
            outcome,
            summary: 'Need input.',
            fullResult: 'Partial work.',
            questions: ['30 or 60 days?'],
          },
        });
      assessmentReply(input.id);
      service = new OpenClawDispatch(service.dependencies);
      const recovered = await workPass('recover-direct-work');
      if (outcome === 'interrupted') {
        assert.equal(recovered.status, 'implementation-pending', JSON.stringify(recovered));
        const saved = await record();
        assert.equal(saved.work!.previousTurns![0]!.turn.origin, 'assessment');
        assert.equal(saved.work!.turn!.runId, `${input.id}:implementation:resume:1`);
        assert.equal(saved.work!.turn!.origin, undefined);
        assert.equal(sends().length, 2);
      } else {
        assert.equal(recovered.status, 'idle');
        assert.equal((await workPass('leave-questions')).status, 'idle');
        assert.equal(sends().length, 1);
        messages.push({
          role: 'user',
          content: '30 days.',
          idempotencyKey: 'answer:user',
          __openclaw: { id: 'answer-event', idempotencyKey: 'answer:user' },
        });
        const answer = await service.run(
          manifest,
          root,
          { ...who, runId: 'answer' },
          { action: 'implementation-context', id: input.id },
        );
        assert.equal(answer.status, 'verified', JSON.stringify(answer));
        assert.ok('previousImplementationResult' in answer);
        assert.equal(answer.previousImplementationResult?.outcome, 'clarification-needed');
      }
      assert.deepEqual((await record()).result, plan);
      assert.equal((await record()).progression!.stage, 'implementation');
      assert.equal(creates().length, 1);
    });

  for (const stage of ['assessment', 'implementation'] as const)
    it(`should resume ${stage} through the current coordinator and retain original creation evidence`, async () => {
      let id: string;
      if (stage === 'implementation') id = await readyWork('work');
      else {
        const routed = await next();
        id = routed.id;
        await prepare(routed);
      }
      const original = structuredClone(await record());
      const replacement = {
        ...coordinator,
        sessionKey: 'agent:receiver:automation:replacement',
        sessionId: 'replacement-id',
        runId: 'replacement-run',
      };
      service.dependencies.coordinator = async () => replacement.sessionKey;
      await assert.rejects(workPass('obsolete-coordinator'), /dispatch-intake-caller-required/);
      const selected = await service.run(manifest, root, replacement, { action: 'next' });
      assert.ok('id' in selected);
      assert.equal(selected.id, id);
      if (stage === 'assessment') {
        assert.equal(selected.status, 'assessment-required');
        await service.run(manifest, root, replacement, { action: 'assess', id });
      } else assert.equal(selected.status, 'implementation-pending');
      service = new OpenClawDispatch(service.dependencies);
      await service.run(manifest, root, replacement, { action: 'next' });
      const retained = await record();
      assert.equal(retained.sourceThreadId, original.sourceThreadId);
      assert.deepEqual(retained.sessionCreation, original.sessionCreation);
      assert.equal(retained.threadId, original.threadId);
      assert.equal(retained.worktree, original.worktree);
      assert.deepEqual(retained.result, original.result);
      assert.equal(creates().length, 1);
      assert.equal(sends().length, stage === 'assessment' ? 1 : 2);
    });

  for (const decision of ['plan', 'work'] as const)
    it(`should request a missing auto decision in the same plan session and honor ${decision}`, async () => {
      const id = await readyWork('plan');
      const original = await record();
      manifest.github!.notifications!.issueAssignment!.mode = 'auto';
      loseSend = true;
      assert.equal((await workPass('decision-pass')).status, 'assessment-pending');
      assert.equal((await record()).decisionTurn?.status, 'attempted');
      assert.deepEqual((await record()).result, original.result);
      assert.deepEqual((await record()).stageReceipt, original.stageReceipt);
      assert.equal((await record()).work, undefined);
      assert.equal((await record()).progression, undefined);
      loseSend = false;
      service = new OpenClawDispatch(service.dependencies);
      await workPass('recover-decision');
      assert.equal(sends().length, 2);
      assert.equal(creates().length, 1);
      inputReceipts = [];
      const who = assessor(id, `${id}:auto-decision`);
      const verified = await service.run(manifest, root, who, { action: 'context', id });
      assert.equal(verified.status, 'verified', JSON.stringify(verified));
      assert.ok('previousResultDigest' in verified);
      const result = await service.run(manifest, root, who, {
        action: 'result',
        id,
        previousResultDigest: verified.previousResultDigest as string,
        result: { ...plan, decision: { mode: decision, reasons: ['Bounded assessment.'] } },
      });
      assert.equal(result.status, 'recorded', JSON.stringify(result));
      await retainConfirmedSummary(id);
      active = false;
      messages.push({
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Decision retained.' }],
        __openclaw: { id: 'decision-reply', runId: `${id}:auto-decision`, runTerminal: true },
      });
      const finished = await workPass('finish-decision');
      assert.equal((await record()).decisionTurn!.status, 'completed', JSON.stringify(finished));
      await workPass('after-decision');
      assert.equal(sends().length, decision === 'work' ? 3 : 2);
      assert.equal(Boolean((await record()).work), decision === 'work');
      assert.equal((await record()).threadId, original.threadId);
    });

  it('should resume an auto decision that ended without a result', async () => {
    const id = await readyWork('auto');
    await workPass('decision-pass');
    active = false;
    inputReceipts = [];
    messages.push({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Interrupted before recording.' }],
      __openclaw: { id: 'unfinished-decision', runId: `${id}:auto-decision`, runTerminal: true },
    });
    await workPass('reconcile-decision');
    await workPass('resume-decision');
    const saved = await record();
    assert.equal(saved.previousDecisionTurns?.length, 1);
    assert.equal(saved.previousDecisionTurns?.[0]?.runId, `${id}:auto-decision`);
    assert.equal(saved.decisionTurn?.runId, `${id}:auto-decision:resume:1`);
    assert.equal(saved.progression, undefined);
    assert.equal(saved.work, undefined);
    assert.equal(creates().length, 1);
  });

  it('should recover legacy failed implementation without a new authorization', async () => {
    const id = await readyWork('work');
    await workPass('start-work');
    active = false;
    inputReceipts = [];
    waitResult = { status: 'error' };
    const current = await service.scope(manifest, root);
    await current.journal.exclusive(async (state, save) => {
      state.records[0]!.work!.code = 'dispatch-turn-failed';
      state.records[0]!.work!.turn!.inactive = true;
      await save();
    });
    await workPass('failed-work');
    waitResult = { status: 'timeout' };
    await workPass('resume-work');
    const saved = await record();
    assert.equal(saved.work?.previousTurns?.[0]?.turn.failed, true);
    assert.equal(saved.work?.turn?.runId, `${id}:implementation:resume:1`);
    assert.equal(saved.progression?.stage, 'implementation');
    assert.equal(creates().length, 1);
  });

  it('should preserve cancellation of an auto decision request across a live work edit', async () => {
    const id = await readyWork('auto');
    await workPass('decision-pass');
    active = false;
    inputReceipts = [
      { runId: `${id}:auto-decision`, state: 'pending', cancelled: true, queued: false },
    ];
    const cancelled = await workPass('cancelled-decision');
    assert.equal('code' in cancelled && cancelled.code, 'dispatch-turn-cancelled');
    assert.equal((await record()).decisionTurn!.inactive, true);
    manifest.github!.notifications!.issueAssignment!.mode = 'work';
    await workPass('after-cancellation');
    assert.equal(sends().length, 2);
    assert.equal((await record()).work, undefined);
    assert.equal((await record()).progression, undefined);
  });

  for (const mode of ['work', 'auto'] as const) {
    it(`should automatically continue ${mode} once in the same issue chat and reconcile a lost response`, async () => {
      const id = await readyWork(mode, mode === 'auto' ? 'work' : undefined);
      const original = await record();
      loseSend = true;
      const sent = await workPass('work-pass');
      assert.equal(sent.status, 'implementation-pending', JSON.stringify(sent));
      assert.equal((await record()).work?.turn?.status, 'attempted');
      assert.equal((await record()).progression?.via, mode);
      assert.equal(sends().length, 2);
      assert.equal(creates().length, 1);
      assert.equal(sends()[1]!.params.sessionKey, original.threadId);
      assert.equal(sends()[1]!.params.sessionId, original.sessionCreation!.sessionId);
      assert.equal(sends()[1]!.params.expectedLeafEntryId, 'assessment-reply');
      loseSend = false;
      service = new OpenClawDispatch(service.dependencies);
      assert.equal((await workPass('recover-pass')).status, 'implementation-pending');
      assert.equal((await record()).work?.turn?.status, 'accepted');
      assert.equal(sends().length, 2);
      assert.equal((await workPass('recover-pass')).status, 'pass-completed');
      inputReceipts = [];
      const who = assessor(id, `${id}:implementation`);
      const verified = await service.run(manifest, root, who, {
        action: 'implementation-context',
        id,
      });
      assert.equal(verified.status, 'verified', JSON.stringify(verified));
      assert.equal(
        (await record()).work?.selection?.requestedSkill,
        'agent-system:agent-system-issue-implementation',
      );
      await service.run(manifest, root, who, {
        action: 'implementation-result',
        id,
        implementationResult: { outcome: 'done', summary: 'Done.', fullResult: 'Validated work.' },
      });
      active = false;
      inputReceipts = [];
      messages.push({
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Done.' }],
        __openclaw: { id: 'work-reply', runId: `${id}:implementation`, runTerminal: true },
      });
      const finished = await workPass('finish-pass');
      assert.equal(finished.status, 'implementation-pending', JSON.stringify(finished));
      assert.equal((await record()).work?.turn?.status, 'completed');
      assert.equal((await workPass('delivery-pass')).status, 'implementation-pending');
      assert.equal((await record()).work?.deliveryTurn?.runId, `${id}:delivery`);
      assert.match(String(sends()[2]!.params.message), /Do not repeat implementation/);
      await workPass('delivery-recovery');
      inputReceipts = [];
      const skillReads = calls.filter(({ method }) => method === 'skills.status').length;
      const delivery = await service.run(manifest, root, assessor(id, `${id}:delivery`), {
        action: 'implementation-context',
        id,
      });
      assert.ok('deliveryOnly' in delivery && delivery.deliveryOnly);
      assert.equal(calls.filter(({ method }) => method === 'skills.status').length, skillReads);
      assert.equal(sends().length, 3);
      assert.equal(creates().length, 1);
    });
  }
  for (const mode of ['plan', 'auto'] as const) {
    it(`should leave ${mode} planning decisions waiting without an implementation send`, async () => {
      await readyWork(mode, mode === 'auto' ? 'plan' : undefined);
      assert.equal((await workPass('held-pass')).status, 'idle');
      assert.equal(sends().length, 1);
      assert.equal((await record()).work, undefined);
    });
  }
  for (const outcome of ['blocked', 'clarification-needed'] as const) {
    it(`should not restart or deliver automatic work after ${outcome}`, async () => {
      const id = await readyWork('work');
      consumeSend = true;
      await workPass('start-work');
      const who = assessor(id, `${id}:implementation`);
      await service.run(manifest, root, who, { action: 'implementation-context', id });
      await service.run(manifest, root, who, {
        action: 'implementation-result',
        id,
        implementationResult: {
          summary: 'Need input.',
          fullResult: 'Partial work retained.',
          ...(outcome === 'clarification-needed'
            ? { outcome, questions: ['Which behavior?'] }
            : { outcome }),
        },
      });
      active = false;
      inputReceipts = [];
      messages.push({
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Need input.' }],
        __openclaw: { id: 'work-reply', runId: `${id}:implementation`, runTerminal: true },
      });
      assert.equal((await workPass('finish-work')).status, 'idle');
      assert.equal((await record()).work?.turn?.status, 'completed');
      assert.equal((await workPass('leave-waiting')).status, 'idle');
      assert.equal((await record()).progression?.stage, 'implementation');
      assert.equal(sends().length, 2);
    });
  }

  for (const stage of ['implementation', 'delivery'] as const) {
    it(`should resume incomplete ${stage} with retained receipts and no renewed approval`, async () => {
      const id = await readyWork('work');
      consumeSend = true;
      await workPass('start-work');
      const who = assessor(id, `${id}:implementation`);
      await service.run(manifest, root, who, { action: 'implementation-context', id });
      if (stage === 'delivery')
        await service.run(manifest, root, who, {
          action: 'implementation-result',
          id,
          implementationResult: {
            outcome: 'done',
            summary: 'Done.',
            fullResult: 'Committed and checked.',
          },
        });
      const end = (runId: string) => {
        active = false;
        inputReceipts = [];
        messages.push({
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Turn ended.' }],
          __openclaw: { id: runId + ':reply', runId, runTerminal: true },
        });
      };
      end(`${id}:implementation`);
      const resumed = await workPass('finish-implementation');
      assert.equal(resumed.status, 'implementation-pending', JSON.stringify(resumed));
      if (stage === 'delivery') {
        end(`${id}:delivery`);
        assert.equal((await workPass('finish-delivery')).status, 'implementation-pending');
      }
      const saved = await record();
      const slot = stage === 'delivery' ? 'deliveryTurn' : 'turn';
      assert.equal(saved.work!.previousTurns!.length, 1);
      assert.equal(saved.work!.previousTurns![0]!.turn.status, 'completed');
      assert.equal(saved.work![slot]!.runId, `${id}:${stage}:resume:1`);
      assert.equal(saved.progression!.stage, 'implementation');
      if (stage === 'delivery') assert.equal(saved.work!.result!.outcome, 'done');
      const sent = sends().length;
      await workPass('reconcile-resume');
      assert.equal(sends().length, sent);
      assert.equal(creates().length, 1);
    });
  }

  for (const scenario of ['approved', 'unapproved', 'unavailable', 'reassignment'] as const) {
    it(`should retain the openclaw owner and stage unless removal is approved: ${scenario}`, async () => {
      const id = await readyWork('work');
      consumeSend = true;
      await workPass('start-work');
      const who = assessor(id, `${id}:implementation`);
      await service.run(manifest, root, who, { action: 'implementation-context', id });
      const original = await record();
      const event = removeFixtureAssignment(fixture);
      if (scenario === 'unapproved' || scenario === 'reassignment')
        event.actor = { ...event.actor, nodeId: 'U_outsider', login: 'outsider' };
      if (scenario === 'unavailable')
        fixture.client.listAssignmentEvents = async () => {
          throw new Error('provider-unavailable');
        };
      if (scenario === 'approved')
        await assert.rejects(
          service.run(manifest, root, who, { action: 'implementation-context', id }),
          /assignment-removed/,
        );
      else {
        const after = await service.run(manifest, root, who, {
          action: 'implementation-context',
          id,
        });
        assert.equal(after.status, 'verified');
        assert.ok('assignmentObservation' in after && after.assignmentObservation?.missing);
        assert.ok(
          'assignmentWarning' in after &&
            /assignment is missing/i.test(after.assignmentWarning!.summary),
        );
        if (scenario === 'reassignment') {
          fixture.item.assignees = [fixture.client.identity];
          fixture.events.push({
            ...event,
            nodeId: 'E_reassigned',
            databaseId: 32,
            event: 'assigned',
            createdAt: '2026-10-07T10:03:00Z',
          });
          const restored = await service.run(manifest, root, who, {
            action: 'implementation-context',
            id,
          });
          assert.ok('assignmentObservation' in restored && !restored.assignmentObservation);
        }
      }
      const checkedAt = service.dependencies.now!();
      service.dependencies.now = () => checkedAt + 60_000;
      await workPass('removal-lifecycle-check');
      const saved = await record();
      assert.equal(
        saved.retirement?.reason,
        scenario === 'approved' ? 'assignment-removed' : undefined,
      );
      if (scenario !== 'approved')
        assert.equal(
          openClawCapacity([saved], 1).occupied,
          openClawCapacity([original], 1).occupied,
        );
      assert.equal(saved.threadId, original.threadId);
      assert.equal(saved.worktree, original.worktree);
      assert.deepEqual(saved.progression, original.progression);
      assert.equal(saved.retired, undefined);
      assert.equal(
        calls.some((call) => call.method === 'sessions.patch' && call.params.archived === true),
        false,
      );
    });
  }

  it('should retain implementation after intake disablement and unresolved removal', async () => {
    const id = await readyWork('work');
    consumeSend = true;
    await workPass('start-work');
    manifest.github!.notifications!.issueAssignment!.enabled = false;
    manifest.github!.notifications!.issueAssignment!.allowed = [];
    manifest.github!.notifications!.issueAssignment!.mode = 'plan';
    const who = assessor(id, `${id}:implementation`);
    assert.equal(
      (await service.run(manifest, root, who, { action: 'implementation-context', id })).status,
      'verified',
    );
    fixture.item.assignees = [];
    const unresolved = await service.run(manifest, root, who, {
      action: 'implementation-context',
      id,
    });
    assert.equal(unresolved.status, 'verified');
    assert.ok('assignmentObservation' in unresolved && unresolved.assignmentObservation?.missing);
  });

  it('should share the fixed intake capacity between automatic implementation owners', async () => {
    await assignments(2, 2);
    for (let i = 0; i < 2; i++) {
      const input = await next();
      await prepare(input);
      await assess(input.id);
      await completeAssessment(input.id);
    }
    manifest.github!.notifications!.issueAssignment!.mode = 'work';
    manifest.github!.notifications!.maxConcurrentItems = 1;
    assert.equal((await workPass('bounded-work')).status, 'implementation-pending');
    const sendsBefore = sends().length;
    assert.equal((await workPass('bounded-work')).status, 'pass-completed');
    await workPass('next-bounded-work');
    assert.equal(sends().length, sendsBefore);
    assert.equal(creates().length, 2);
    const state = await (await service.scope(manifest, root)).journal.read();
    assert.equal(state.records.filter((record) => record.work?.turn).length, 1);
  });

  it('should leave a busy owner queued and stop a cancelled automatic implementation', async () => {
    const id = await readyWork('work');
    active = true;
    assert.equal((await workPass('busy-pass')).status, 'at-capacity');
    assert.equal(sends().length, 1);
    assert.equal((await record()).work, undefined);
    active = false;
    await workPass('free-pass');
    active = false;
    inputReceipts = [{ runId: `${id}:implementation`, cancelled: true, queued: false }];
    const cancelled = await workPass('cancel-pass');
    assert.ok('code' in cancelled && cancelled.code === 'dispatch-turn-cancelled');
    assert.equal((await record()).work?.code, 'dispatch-turn-cancelled');
    await workPass('after-cancel');
    assert.equal(sends().length, 2);
  });

  for (const debug of [false, true]) {
    it(`should deliver only the issue assignment card with debug ${debug ? 'on' : 'off'} without provider payloads`, async () => {
      manifest.debug = debug;
      const input = await next();
      await prepare(input);
      await assess(input.id);
      const message = String(sends()[0]!.params.message);
      assert.match(message, /Issue assigned/);
      assert.match(message, /Assess this issue and prepare a plan/);
      assert.ok(!message.includes('Model routing'));
      assert.match(message, /https:\/\/github.com\/receiver/);
      assert.match(message, /owner\/repo#3/);
      assert.ok(!message.includes('Assessment instructions'));
      assert.ok(!message.includes('Effective settings'));
      assert.doesNotMatch(message, /Return the missing result/);
      const snapshot = (await record()).context;
      service.dependencies.connect = async () => ({
        ...fixture.client,
        async getItemContext() {
          return {
            title: 'Fresh title',
            body: 'FRESH-PRIVATE-FACT',
            comments: [],
            labels: [],
            truncated: false,
          };
        },
      });
      const fresh = await context(input.id);
      assert.ok(
        'evidence' in fresh && JSON.stringify(fresh.evidence).includes('FRESH-PRIVATE-FACT'),
      );
      assert.equal((await record()).context, snapshot);
      const recorded = await submit(input.id);
      assert.ok(
        'presentation' in recorded && !recorded.presentation?.includes('FRESH-PRIVATE-FACT'),
      );
    });
  }

  it('should let the child retain its plan before the coordinator send returns', async () => {
    const input = await next();
    await prepare(input);
    afterSend = async () => {
      assert.equal((await context(input.id)).status, 'verified');
      assert.equal((await submit(input.id)).status, 'recorded');
      assessmentReply(input.id);
    };
    const result = await assess(input.id);
    assert.equal(result.status, 'assessment-completed');
    assert.equal((await record()).phase, 'complete');
    assert.deepEqual((await record()).result, plan);
    assert.equal((await record()).assessmentTurn?.status, 'completed');
    assert.equal(sends().length, 1);
  });

  for (const loseResponse of [false, true]) {
    it(`should retain one assessment summary in openclaw after ${loseResponse ? 'a lost response' : 'successful publication'}`, async () => {
      const input = await next();
      await prepare(input);
      await assess(input.id);
      await context(input.id);
      const recorded = await submit(input.id);
      assert.ok(
        'presentation' in recorded && recorded.presentation?.includes(plan.fullAssessment!),
      );
      let writes = 0;
      let receipt: { nodeId: string; databaseId: number; body: string } | undefined;
      service.dependencies.feedbackConnect = async () => ({
        ...fixture.client,
        getItemContext: async () => ({
          title: 'issue',
          body: '',
          comments: [],
          labels: [],
          truncated: false,
        }),
        listIssueComments: async () => ({ comments: [], truncated: false }),
        getIssueComment: async () => {
          throw new Error('unexpected source lookup');
        },
        createIssueComment: async (_o, _n, number, body) => {
          assert.equal(number, 3);
          writes++;
          receipt = { nodeId: 'SUMMARY', databaseId: 901, body };
          if (loseResponse) throw new Error('response-lost');
          return receipt;
        },
        findOwnIssueComment: async () => receipt,
        replies: {
          create: async () => {
            throw new Error('unexpected reply');
          },
          find: async () => undefined,
        },
      });
      const summary = async (
        operation: 'compose' | 'candidate' | 'publish' | 'reconcile',
        digest?: string,
        publicText?: string,
      ) =>
        service.run(manifest, root, assessor(input.id), {
          action: 'summary',
          id: input.id,
          operation,
          digest,
          publicText,
        });
      const composed = await summary('compose');
      assert.equal(composed.status, 'composition-ready');
      assert.ok('digest' in composed);
      assert.equal(
        (
          await summary(
            'candidate',
            composed.digest,
            'The proposal would show your result immediately, so you can keep going.',
          )
        ).status,
        'candidate-recorded',
      );
      const preview = await summary('publish');
      assert.ok('digest' in preview);
      const competing = await Promise.allSettled([
        summary('publish', preview.digest),
        summary('publish', preview.digest),
      ]);
      assert.ok(
        competing.some(
          (entry) =>
            entry.status === 'fulfilled' &&
            entry.value.status === (loseResponse ? 'blocked' : 'published'),
        ),
      );
      assert.equal(writes, 1);
      service = new OpenClawDispatch(service.dependencies);
      if (loseResponse) {
        assert.equal((await summary('publish', preview.digest)).status, 'reconcile-required');
        assert.equal((await summary('reconcile')).status, 'published');
      }
      assert.equal((await summary('compose')).status, 'published');
      assert.equal(writes, 1);
      assert.deepEqual((await record()).result, plan);
      assert.equal((await record()).assessmentSummaries?.[0]?.receipt?.nodeId, 'SUMMARY');
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
    assert.equal(saved.phase, 'complete');
    assert.equal(saved.assessmentTurn?.status, 'consumed');
    assert.equal(saved.resultTurnId, `${input.id}:assessment`);
    assert.equal(saved.stageReceipt?.binding.threadId, assessor(input.id).sessionKey);
    assert.equal(saved.stageReceipt?.binding.worktree, join(root, 'worktree'));
    assessmentReply(input.id);
    service = new OpenClawDispatch(service.dependencies);
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    await retainConfirmedSummary(input.id);
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(
      (
        await service.run(
          manifest,
          root,
          { ...coordinator, runId: 'empty-run' },
          { action: 'next' },
        )
      ).status,
      'idle',
    );
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    assert.equal(sends().length, 1);
    assert.equal(creates().length, 1);
  });

  it('should reconcile an uncertain summary-only native send after restart without sending again', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    await submit(input.id);
    assessmentReply(input.id);
    await assess(input.id);
    loseSend = true;
    const started = await workPass('summary-recovery');
    assert.equal(started.status, 'assessment-pending');
    const retained = await record();
    assert.equal(retained.summaryRecovery?.turn.status, 'attempted');
    assert.ok(retained.summaryRecovery?.code);
    loseSend = false;
    service = new OpenClawDispatch(service.dependencies);
    await workPass('summary-receipt-recovery');
    assert.equal((await record()).summaryRecovery?.turn.status, 'accepted');
    assert.equal((await record()).summaryRecovery?.code, undefined);
    assert.equal(sends().length, 2);
    assert.deepEqual((await record()).result, retained.result);
    assert.equal(creates().length, 1);
  });

  it('should allow an overlapping coordinator scan and preserve the completed assessment', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completing = service.run(
      manifest,
      root,
      assessor(input.id),
      { action: 'result', id: input.id, result: plan },
      false,
      {
        assertCurrent: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    );
    await entered.promise;
    try {
      const before = await record();
      const callsBefore = calls.length;
      assert.deepEqual(
        await service.run(
          manifest,
          root,
          { ...coordinator, runId: 'overlapping-run' },
          { action: 'next' },
        ),
        {
          status: 'reconcile-required',
          id: input.id,
        },
      );
      assert.deepEqual(
        { ...(await record()), lifecycleCheckedAt: 0, feedback: undefined },
        { ...before, lifecycleCheckedAt: 0, feedback: undefined },
      );
      assert.ok(
        calls
          .slice(callsBefore)
          .every((call) => ['sessions.describe', 'chat.history'].includes(call.method)),
      );
    } finally {
      release.resolve();
      await completing;
    }
    assert.equal((await completing).status, 'recorded');
    const saved = await record();
    assert.deepEqual(saved.result, plan);
    assessmentReply(input.id);
    service = new OpenClawDispatch(service.dependencies);
    const resumed = await service.run(
      manifest,
      root,
      { ...coordinator, runId: 'after-result' },
      { action: 'next' },
    );
    assert.equal(resumed.status, 'reconcile-required');
    assert.ok('id' in resumed && resumed.id === input.id);
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'reconcile', id: input.id }))
        .status,
      'assessment-completed',
    );
    assert.equal(
      (
        await service.run(
          manifest,
          root,
          { ...coordinator, runId: 'empty-run' },
          { action: 'next' },
        )
      ).status,
      'assessment-pending',
    );
    const completed = await record();
    assert.match(
      completed.summaryRecovery!.turn.message,
      /recover only the pending public assessment summary/,
    );
    assert.deepEqual(completed.result, saved.result);
    assert.deepEqual(completed.stageReceipt, saved.stageReceipt);
    assert.equal(completed.threadId, saved.threadId);
    assert.equal(completed.worktree, saved.worktree);
    assert.equal(creates().length, 1);
    assert.equal(sends().length, 2);
    assert.equal(preparedWorktrees, 1);
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
      assert.ok(recorded.presentation.includes('Model routing'));
      const reloaded = await context(input.id);
      assert.ok('previousPresentation' in reloaded);
      assert.equal(reloaded.previousPresentation, recorded.presentation);
      assert.ok('previousResult' in reloaded && 'resultSchema' in reloaded);
      assert.deepEqual(reloaded.previousResult, plan);
      assert.equal(Value.Check(reloaded.resultSchema, plan), true);
      // native tool search includes both content and details in its model-facing envelope.
      const transported = JSON.stringify(
        {
          tool: {
            id: 'openclaw:agent-system:agent_system_dispatch',
            name: 'agent_system_dispatch',
            source: 'openclaw',
          },
          result: {
            content: [{ type: 'text', text: JSON.stringify(reloaded) }],
            details: reloaded,
          },
        },
        null,
        2,
      );
      assert.ok(
        transported.length < 32000,
        `assessment context exceeds the 128k model tool budget: ${transported.length}`,
      );
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

  for (const mismatch of ['missing text', 'conflicting key']) {
    it(`should reject ${mismatch} in assessment input before retaining caller authority`, async () => {
      const input = await next();
      await prepare(input);
      await assess(input.id);
      const user = messages[0]!;
      if (mismatch === 'missing text')
        user.content = [{ type: 'text', text: user.content }, { type: 'text' }];
      else user.idempotencyKey = 'unrelated:user';
      await assert.rejects(context(input.id), /dispatch-assessment-input-mismatch/);
      assert.equal((await record()).assessmentCaller, undefined);
      assert.equal((await record()).result, undefined);
      assert.equal(sends().length, 1);
    });
  }

  it('should reject inconsistent persisted assessment receipts', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
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
          Object.assign(state.records[0]!.assessmentTurn!, change);
          await save();
        }),
      );
    }
    assert.equal((await record()).assessmentTurn?.status, 'accepted');
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
      idempotencyKey: 'followup:user',
      __openclaw: { id: 'answer-event', idempotencyKey: 'followup:user' },
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
    assert.equal((await assess(input.id)).status, 'waiting');
    assert.equal((await record()).assessmentTurn?.status, 'attempted');
    await context(input.id);
    await submit(input.id);
    assessmentReply(input.id);
    service = new OpenClawDispatch(service.dependencies);
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    assert.equal(sends().length, 1);
  });

  it('should reject conflicting followup custody before retaining a new assessment caller', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    await submit(input.id);
    assessmentReply(input.id);
    const followup = {
      role: 'user',
      content: 'Revise the plan.',
      idempotencyKey: 'followup:user',
      __openclaw: { id: 'followup-event', idempotencyKey: 'followup:user' },
    };
    const who = assessor(input.id, 'followup');
    for (const changed of [
      { ...followup, idempotencyKey: 'unrelated:user' },
      { ...followup, __openclaw: { ...followup.__openclaw, runId: 'unrelated' } },
      { ...followup, __openclaw: { ...followup.__openclaw, truncated: true } },
    ]) {
      messages.push(changed);
      await assert.rejects(context(input.id, who), /dispatch-assessment-input-unverified/);
      messages.pop();
      assert.equal((await record()).assessmentCaller?.runId, `${input.id}:assessment`);
      assert.deepEqual((await record()).result, plan);
    }
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
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, false);
    messages.push({
      role: 'user',
      content: 'Retain the completed plan.',
      idempotencyKey: 'repair:user',
      __openclaw: { id: 'repair-event', idempotencyKey: 'repair:user' },
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
    removeFixtureAssignment(fixture);
    await assert.rejects(context(input.id), /dispatch-assignment-removed/);
    assert.deepEqual((await record()).result, plan);
    assert.equal((await record()).phase, 'complete');
    assert.equal(sends().length, 1);
  });

  it('should reject incomplete results but accept a complete plan without a redundant summary', async () => {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    await assert.rejects(
      submit(input.id, { ...plan, fullAssessment: undefined }),
      /assessment-result-incomplete/,
    );
    await writeFile(join(root, 'SKILL.md'), '# changed selection');
    const concise = { ...plan };
    delete concise.planSummary;
    await submit(input.id, concise);
    assert.deepEqual((await record()).result, concise);
  });

  it('should keep an uncertain assessment send blocked and never reinterpret it as a fresh attempt', async () => {
    const input = await next();
    await prepare(input);
    loseSend = true;
    acceptSend = false;
    assert.equal((await assess(input.id)).status, 'waiting');
    assert.equal((await assess(input.id)).status, 'waiting');
    service = new OpenClawDispatch(service.dependencies);
    assert.equal((await assess(input.id)).status, 'waiting');
    assert.equal(sends().length, 1);
    await acknowledgeReport();
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
        idempotencyKey: 'later:user',
        __openclaw: { id: 'later-event', idempotencyKey: 'later:user' },
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
    await acknowledgeReport();
    assert.equal((await service.check(manifest, root)).changed, false);
    assert.equal(sends().length, 1);
  });
  async function operatorFollowup(owner = true) {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    await submit(input.id);
    assessmentReply(input.id);
    messages.push({
      role: 'user',
      content: 'Implement this plan and open a PR.',
      idempotencyKey: 'operator:user',
      __openclaw: {
        id: 'operator-event',
        idempotencyKey: 'operator:user',
        ...(owner ? {} : { senderIsOwner: false }),
      },
    });
    return { id: input.id, who: assessor(input.id, 'operator') };
  }

  async function originalAssignment() {
    const setup = await operatorFollowup();
    const { journal } = await service.scope(manifest, root);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.manifestDigest = automationHash({
        policy: originalIntakeDigest(manifest),
        models: manifest.models,
      });
      await save();
    });
    const before = await record();
    service = new OpenClawDispatch(service.dependencies);
    return { ...setup, before };
  }

  it('should include a github plan revision in direct planning context without entering work', async () => {
    const { id, who } = await operatorFollowup();
    const { journal } = await service.scope(manifest, root);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.feedback = {
        baseline: {},
        events: [
          {
            id: 'a'.repeat(64),
            sourceId: 'plan-comment',
            nodeId: 'I_issue',
            number: 3,
            itemType: 'issue',
            source: '{}',
            revision: 'b'.repeat(64),
            createdAt: 1,
            policyDigest: 'c'.repeat(64),
            phase: 'published',
            result: { privateText: 'Keep the smaller approach.' },
          },
        ],
      };
      await save();
    });
    const response = await context(id, who);
    assert.equal(response.status, 'verified');
    assert.ok('feedbackWork' in response && response.feedbackWork);
    assert.equal(response.feedbackWork[0]!.privateText, 'Keep the smaller approach.');
    assert.equal((await record()).progression, undefined);
  });

  it('should refresh an original assignment and hand off in the same native owner after upgrade', async () => {
    const { id, who, before } = await originalAssignment();
    const refreshed = await context(id, who);
    assert.equal(refreshed.status, 'verified');
    assert.ok('previousResult' in refreshed && 'previousResultDigest' in refreshed);
    assert.deepEqual(refreshed.previousResult, plan);
    assert.equal(refreshed.previousResultDigest, automationHash(plan));
    const afterRefresh = await record();
    assert.deepEqual(afterRefresh.stageReceipt, before.stageReceipt);
    assert.deepEqual(afterRefresh.result, before.result);
    const revised = { ...plan, plan: plan.plan + ' Preserve existing callers.' };
    assert.equal(
      (await submit(id, revised, refreshed.previousResultDigest, who)).status,
      'recorded',
    );
    messages.push({
      role: 'user',
      content: 'Implement the revised plan and open a PR.',
      idempotencyKey: 'implement:user',
      __openclaw: { id: 'implement-event', idempotencyKey: 'implement:user', senderIsOwner: true },
    });
    const operator = { ...who, runId: 'implement' };
    const request = {
      action: 'handoff' as const,
      id,
      permission: 'implementation-and-publication' as const,
    };
    const preview = await service.run(manifest, root, operator, request, true);
    assert.ok('digest' in preview && typeof preview.digest === 'string');
    assert.equal(
      (await service.run(manifest, root, operator, { ...request, digest: preview.digest }, true))
        .status,
      'handed-off',
    );
    assert.equal(
      (await service.run(manifest, root, operator, { action: 'implementation-context', id }, true))
        .status,
      'verified',
    );
    const after = await record();
    for (const key of [
      'id',
      'intakeId',
      'threadId',
      'sessionCreation',
      'worktree',
      'routing',
      'effective',
      'manifestDigest',
      'assessmentTurn',
    ] as const)
      assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(after.result, revised);
    assert.equal(after.assessmentRevision, before.assessmentRevision! + 1);
    assert.deepEqual(after.stageReceipt, {
      binding: { ...before.stageReceipt!.binding, turnId: who.runId },
      resultDigest: automationHash(revised),
    });
    assert.deepEqual(after.assessmentCaller, { runId: who.runId, inputEventId: 'operator-event' });
    assert.equal(after.work?.implementation?.inputEventId, 'implement-event');
    assert.equal(after.work?.publication, undefined);
    assert.equal(after.progression?.stage, 'implementation');
    assert.equal(after.reset, undefined);
    assert.equal(after.retirement, undefined);
    assert.equal(after.retired, undefined);
    assert.equal(creates().length, 1);
    assert.equal(preparedWorktrees, 1);
    assert.equal(sends().length, 1);
  });

  for (const change of [
    'policy',
    'models',
    'cleanup',
    'stale-readback',
    'notifications-removed',
  ] as const) {
    it(`should retain original custody after changed ${change} without renewed authorization`, async () => {
      const { id, who } = await originalAssignment();
      if (change === 'policy') manifest.github!.notifications!.issueAssignment!.feedback = true;
      if (change === 'models') manifest.models!.medium!.effort = 'medium';
      if (change === 'cleanup')
        manifest.github!.notifications!.cleanup = { enabled: false, graceMinutes: 60 };
      if (change === 'stale-readback') {
        const manifests = service.dependencies.intake.dependencies.manifestService;
        const load = manifests.loadForAgentId.bind(manifests);
        const fresh = structuredClone(manifest);
        fresh.models!.medium!.effort = 'medium';
        manifests.loadForAgentId = async (...args) => ({
          ...(await load(...args)),
          manifest: fresh,
        });
      } else await service.dependencies.intake.run(manifest, root, 'activate');
      const before = await record();
      assert.equal((await context(id, who)).status, 'verified');
      const handoff = await service.run(
        manifest,
        root,
        who,
        { action: 'handoff', id, permission: 'implementation' },
        true,
      );
      assert.equal(handoff.status, 'handoff-available');
      const after = await record();
      for (const key of [
        'id',
        'threadId',
        'worktree',
        'manifestDigest',
        'result',
        'stageReceipt',
      ] as const)
        assert.deepEqual(after[key], before[key], key);
      assert.equal(creates().length, 1);
    });
  }
  for (const change of ['account', 'repository', 'assignment'] as const) {
    it(`should reject original custody with invalid ${change} before native credentials`, async () => {
      const { id, who } = await originalAssignment();
      const connect = service.dependencies.connect;
      service.dependencies.connect = async (...args) => {
        const client = await connect(...args);
        if (change === 'account')
          return { ...client, identity: { ...client.identity, nodeId: 'foreign' } };
        return client;
      };
      if (change === 'repository') fixture.repository.nodeId = 'foreign';
      if (change === 'assignment') {
        const event = removeFixtureAssignment(fixture);
        manifest.github!.notifications!.issueAssignment!.allowed = [event.actor];
      }
      service.dependencies.credential.use = async () => {
        throw new Error('native credentials must not resolve');
      };
      await assert.rejects(
        context(id, who),
        new RegExp(
          {
            account: 'dispatch-receiver-account-changed',
            repository: 'dispatch-repository-identity-changed',
            assignment: 'dispatch-assignment-removed',
          }[change],
        ),
      );
      assert.equal(creates().length, 1);
      assert.equal(preparedWorktrees, 1);
    });
  }
  for (const change of ['session', 'source', 'worktree'] as const) {
    it(`should reject original custody with diverged ${change} without duplicate creation`, async () => {
      const { id, who } = await originalAssignment();
      if (change === 'session') who.sessionId = 'foreign';
      if (change === 'source')
        messages.at(-1)!.__openclaw = {
          id: 'foreign',
          idempotencyKey: 'foreign:user',
          senderIsOwner: true,
        };
      if (change === 'worktree') await rm(join(root, 'worktree'), { recursive: true });
      await assert.rejects(
        service.run(
          manifest,
          root,
          who,
          { action: 'handoff', id, permission: 'implementation' },
          true,
        ),
        /dispatch-(assessment-caller-mismatch|operator-input-unverified|worktree-diverged|worktree-unavailable)/,
      );
      assert.equal((await record()).work, undefined);
      assert.equal(creates().length, 1);
      assert.equal(preparedWorktrees, 1);
    });
  }

  async function publishedFollowup(onInspect: () => Promise<void> = async () => {}) {
    const { id, who } = await operatorFollowup();
    const request = { action: 'handoff' as const, id, permission: 'publication' as const };
    const preview = await service.run(manifest, root, who, request, true);
    assert.ok('digest' in preview && typeof preview.digest === 'string');
    await service.run(manifest, root, who, { ...request, digest: preview.digest }, true);
    const { journal, admitted } = await service.scope(manifest, root);
    const retained = await record();
    const intake = admitted.records.find((entry) => entry.id === retained.intakeId)!;
    const head = 'a'.repeat(40);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.work!.delivery = {
        id: 'd'.repeat(64),
        title: 'Fix the result',
        body: 'Closes #3',
        creationAttempted: true,
        reconciled: true,
        pushedHead: head,
        pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
        binding: {
          repositoryId: intake.repository.nodeId,
          issueId: intake.issue.nodeId,
          sessionId: who.sessionId,
          threadId: who.sessionKey,
          worktree: retained.worktree!,
          branch: 'issue-3',
          base: 'main',
          head,
          authorId: 'U_agent',
          policyDigest: retained.manifestDigest,
        },
      };
      await save();
    });
    const effects: string[][] = [];
    service.dependencies.delivery = async () => {
      throw new Error('presentation must not connect to github or git');
    };
    const use = service.dependencies.credential.use;
    service.dependencies.credential.use = async (authority, callback) =>
      use(authority, async (request) =>
        callback(async (...args) => {
          if (args[0] === 'sessions.describe') await onInspect();
          return request(...args);
        }),
      );
    const present = (authority = {}) =>
      service.run(
        manifest,
        root,
        who,
        { action: 'delivery', operation: 'present', id },
        true,
        authority,
      );
    return { id, who, journal, present, effects };
  }

  for (const outcome of ['plan-ready', 'clarification-needed'] as const)
    it(`should preserve feedback-created pr state after an original ${outcome} assessment across restart`, async () => {
      const { journal } = await publishedFollowup();
      const before = await record();
      const original: AssessmentResult =
        outcome === 'plan-ready'
          ? plan
          : {
              version: 1,
              outcome,
              summary: 'Need the expected return value.',
              assessment: 'The expected value is not specified.',
              questions: ['Which value should be returned?'],
              evidence: [],
              progress: { completed: [], remaining: [] },
            };
      await journal.exclusive(async (state, save) => {
        const current = state.records[0]!;
        current.result = original;
        current.stageReceipt!.resultDigest = automationHash(original);
        delete current.handoff;
        current.progression = { stage: 'implementation', via: 'work', enteredAt: 2 };
        current.work = {
          assessmentDigest: automationHash(original),
          delivery: before.work!.delivery,
        };
        current.feedback = {
          baseline: {},
          events: [
            {
              id: 'e'.repeat(64),
              sourceId: 'answer',
              nodeId: fixture.item.nodeId,
              number: 3,
              itemType: 'issue',
              source: '{}',
              revision: 'f'.repeat(64),
              createdAt: 2,
              policyDigest: before.manifestDigest,
              phase: 'running',
              work: {
                selection: current.assessment!,
                decision: {
                  mode: 'work',
                  reasons: ['The answer resolves scope.'],
                  plan: 'Return the agreed value.',
                },
                result: {
                  outcome: 'done',
                  summary: 'Fixed.',
                  fullResult: 'Changed and tested the return value.',
                },
                head: before.work!.delivery!.pushedHead,
              },
              workDelivery: before.work!.delivery,
            },
          ],
        };
        await save();
      });
      service = new OpenClawDispatch(service.dependencies);
      const restored = await record();
      assert.deepEqual(restored.result, original);
      assert.equal(restored.handoff, undefined);
      assert.equal(restored.progression?.stage, 'implementation');
      assert.deepEqual(restored.work!.delivery, before.work!.delivery);
      assert.equal(restored.work!.result, undefined);
      assert.equal(restored.feedback!.events[0]!.work!.result!.outcome, 'done');
      assert.equal(restored.threadId, before.threadId);
      assert.equal(restored.worktree, before.worktree);
      assert.equal(creates().length, 1);
      await assert.rejects(
        journal.exclusive(async (state, save) => {
          delete state.records[0]!.progression;
          await save();
        }),
        /dispatch-state-invalid/,
      );
    });

  it('should recover an older openclaw policy blocker without replacing work or pr receipts', async () => {
    const { journal } = await publishedFollowup();
    await journal.exclusive(async (state, save) => {
      const current = state.records[0]!;
      current.blocker = 'dispatch-policy-changed';
      current.phase = 'blocked';
      current.work!.implementation = { runId: 'implementation', inputEventId: 'answer' };
      delete current.progression;
      await save();
    });
    const before = await journal.file.read();
    service = new OpenClawDispatch(service.dependencies);
    const restored = await record();
    assert.equal(restored.blocker, undefined);
    assert.equal(restored.phase, 'complete');
    assert.deepEqual(restored.progression, { stage: 'implementation', via: 'legacy' });
    assert.deepEqual(restored.compatibilityRecovery?.codes, ['dispatch-policy-changed']);
    assert.deepEqual(restored.work, JSON.parse(before!).records[0].work);
    await journal.exclusive(async (_state, save) => save());
    assert.deepEqual((await record()).work, restored.work);
    assert.equal(creates().length, 1);
  });

  it('should release the presentation lock during native reads and recover the same complete card', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { journal, present, effects } = await publishedFollowup(async () => {
      entered.resolve();
      await release.promise;
    });
    const before = (await record()).work!.delivery!;
    const pending = present();
    await entered.promise;
    try {
      await journal.exclusive(async (state) => {
        assert.deepEqual(state.records[0]!.work!.delivery, before);
      });
    } finally {
      release.resolve();
    }
    const shown = await pending;
    assert.ok('presentation' in shown && typeof shown.presentation === 'string');
    assert.match(shown.presentation, /^> ## 🔀 Pull request opened/m);
    assert.match(shown.presentation, /issues\/3/);
    assert.match(shown.presentation, /pull\/7/);
    service = new OpenClawDispatch(service.dependencies);
    const retried = await present();
    assert.ok('presentation' in retried);
    assert.equal(retried.presentation, shown.presentation);
    assert.deepEqual(
      { ...(await record()).work!.delivery, presentation: undefined },
      { ...before, presentation: undefined },
    );
    assert.ok(
      effects.every(
        (argv) => !argv.includes('push') && !argv.includes('POST') && !argv.includes('PATCH'),
      ),
    );
  });

  it('should report enabled feedback when recovering a published pr card', async () => {
    manifest.github!.notifications!.issueAssignment!.feedback = true;
    await service.dependencies.intake.run(manifest, root, 'activate');
    const { present } = await publishedFollowup();
    const shown = await present();
    assert.ok('presentation' in shown && typeof shown.presentation === 'string');
    assert.match(shown.presentation, /Approved feedback/);
    assert.doesNotMatch(shown.presentation, /feedback delivery is not available/);
    assert.equal((await record()).work!.delivery!.presentation, shown.presentation);
  });

  for (const stage of ['snapshot', 'commit'] as const) {
    it(`should report retryable ${stage} contention without changing the publication receipt`, async () => {
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let locking: Promise<void> | undefined;
      const setup = await publishedFollowup(async () => {
        if (stage === 'commit' && !locking) {
          locking = setup.journal.exclusive(async () => {
            held.resolve();
            await release.promise;
          });
          await held.promise;
        }
      });
      if (stage === 'snapshot') {
        locking = setup.journal.exclusive(async () => {
          held.resolve();
          await release.promise;
        });
        await held.promise;
      }
      const before = await record();
      try {
        const result = await setup.present();
        assert.equal(result.status, 'busy');
        assert.ok(
          'retryable' in result && result.retryable && 'stage' in result && result.stage === stage,
        );
        assert.deepEqual(
          { ...(await record()), lifecycleCheckedAt: 0 },
          { ...before, lifecycleCheckedAt: 0 },
        );
      } finally {
        release.resolve();
        await locking;
      }
      assert.equal((await setup.present()).status, 'presented');
    });
  }

  it('should reject a changed record instead of saving a stale presentation snapshot', async () => {
    const setup = await publishedFollowup(async () => {
      await setup.journal.exclusive(async (state, save) => {
        state.records[0]!.work!.delivery!.reconciled = false;
        await save();
      });
    });
    const result = await setup.present();
    assert.ok('code' in result && result.code === 'delivery-presentation-state-changed');
    assert.equal((await record()).work!.delivery!.reconciled, false);
    assert.equal((await record()).work!.delivery!.presentation, undefined);
  });

  it('should preserve the published receipt across cancellation and later owner recovery', async () => {
    const controller = new AbortController();
    let cancel = true;
    const setup = await publishedFollowup(async () => {
      if (cancel) controller.abort(new Error('dispatch-test-cancelled'));
    });
    const before = await record();
    await assert.rejects(setup.present({ signal: controller.signal }), /dispatch-test-cancelled/);
    assert.deepEqual(
      { ...(await record()), lifecycleCheckedAt: 0 },
      { ...before, lifecycleCheckedAt: 0 },
    );
    cancel = false;
    setup.who.runId = 'later-owner';
    anchoredMessages = [
      {
        role: 'user',
        content: 'Show the existing PR.',
        __openclaw: {
          id: 'later-event',
          runId: 'later-owner',
          idempotencyKey: 'later-owner:user',
          senderIsOwner: true,
        },
      },
    ];
    inputReceipts = [{ runId: 'later-owner', state: 'consumed', consumedByEventId: 'later-event' }];
    assert.equal((await setup.present()).status, 'presented');
    inputReceipts = [];
    service = new OpenClawDispatch(service.dependencies);
    assert.equal((await setup.present()).status, 'presented');
    const retained = await record();
    assert.deepEqual(retained.work!.operatorInput, before.work!.operatorInput);
    assert.deepEqual(retained.work!.publication, before.work!.publication);
    assert.equal(retained.work!.caller, undefined);
  });

  for (const code of [
    'private-state-file-lock-busy',
    'private-state-file-lock-lost',
    'dispatch-policy-changed',
  ]) {
    it(`should not classify verification failure ${code} as presentation acquisition contention`, async () => {
      const setup = await publishedFollowup(async () => {
        throw Object.assign(new Error(code), { code });
      });
      const before = await record();
      const result = await setup.present();
      assert.equal(result.status, 'blocked');
      assert.ok('code' in result && result.code === code);
      assert.equal('retryable' in result, false);
      assert.deepEqual(
        { ...(await record()), lifecycleCheckedAt: 0, feedback: undefined },
        { ...before, lifecycleCheckedAt: 0, feedback: undefined },
      );
    });
  }

  it('should display retained cards after assignment removal without renewed publication permission', async () => {
    const setup = await publishedFollowup();
    fixture.item.assignees = [];
    await setup.journal.exclusive(async (state, save) => {
      delete state.records[0]!.work!.publication;
      state.records[0]!.work!.delivery!.reconciled = false;
      await save();
    });
    const result = await service.run(
      manifest,
      root,
      setup.who,
      { action: 'delivery', operation: 'present', id: setup.id },
      false,
    );
    assert.equal(result.status, 'presented');
    assert.ok('presentation' in result);
    assert.equal((await record()).work!.delivery!.reconciled, false);
    const plan = await service.run(
      manifest,
      root,
      setup.who,
      { action: 'present', id: setup.id },
      false,
    );
    assert.equal(plan.status, 'presented');
    assert.ok('presentation' in plan);
    const before = await record();
    const detailed = await service.run(
      manifest,
      root,
      setup.who,
      { action: 'present', id: setup.id, includeDetails: true },
      false,
    );
    assert.equal(detailed.status, 'presented');
    assert.ok('presentation' in detailed && typeof detailed.presentation === 'string');
    assert.ok(detailed.presentation.includes(before.result!.progress.completed[0]!));
    assert.deepEqual(await record(), before);
    const foreign = await service.run(
      manifest,
      root,
      { ...setup.who, sessionId: 'foreign' },
      { action: 'present', id: setup.id },
    );
    assert.equal(foreign.status, 'blocked');
  });

  it('should use live assessment content and guidance while preserving the original assessment selection', async () => {
    const { id, who } = await operatorFollowup();
    const before = await record();
    manifest.github!.notifications!.issueAssignment!.assessment = {
      guidance: 'Use the revised requirements.',
    };
    await writeFile(join(root, 'SKILL.md'), '# updated assessment content');
    const output = await context(id, who);
    assert.equal(output.status, 'verified');
    assert.ok('assessment' in output);
    const selected = output.assessment as {
      guidance: { content: string };
      skill: { digest: string };
    };
    assert.equal(selected.guidance.content, 'Use the revised requirements.');
    assert.notEqual(selected.skill.digest, before.assessment!.skill.digest);
    assert.deepEqual((await record()).assessment, before.assessment);
    assert.deepEqual((await record()).result, before.result);
  });

  it('should resume native work after feedback resolved an original clarification without rewriting that assessment', async () => {
    const { id, who } = await operatorFollowup();
    const { journal } = await service.scope(manifest, root);
    const question: AssessmentResult = {
      version: 1,
      outcome: 'clarification-needed',
      summary: 'Choose approach.',
      assessment: 'The approach needs a decision.',
      questions: ['Which approach?'],
      evidence: [],
      progress: { completed: [], remaining: ['Answer.'] },
    };
    await journal.exclusive(async (state, save) => {
      const retained = state.records[0]!;
      retained.result = question;
      retained.stageReceipt!.resultDigest = automationHash(question);
      retained.progression = { stage: 'implementation', via: 'work' };
      retained.feedback = {
        baseline: {},
        events: [
          {
            id: 'd'.repeat(64),
            sourceId: 'plan-comment',
            nodeId: 'I_issue',
            number: 3,
            itemType: 'issue',
            source: '{}',
            revision: 'e'.repeat(64),
            createdAt: 0,
            policyDigest: 'c'.repeat(64),
            phase: 'published',
            result: { privateText: 'Keep the smaller approach.' },
          },
          {
            id: 'a'.repeat(64),
            sourceId: 'answer-comment',
            nodeId: 'I_issue',
            number: 3,
            itemType: 'issue',
            source: '{}',
            revision: 'b'.repeat(64),
            createdAt: 1,
            policyDigest: 'c'.repeat(64),
            phase: 'running',
            work: {
              selection: retained.assessment!,
              decision: {
                mode: 'work',
                reasons: ['Resolved by approved feedback.'],
                plan: 'Implement the agreed approach.',
              },
              result: {
                outcome: 'clarification-needed',
                summary: 'Choose a value.',
                fullResult: 'Partial change retained.',
                questions: ['Which value?'],
              },
            },
          },
        ],
      };
      await save();
    });
    const response = await service.run(
      manifest,
      root,
      who,
      { action: 'implementation-context', id },
      false,
    );
    assert.equal(response.status, 'verified');
    assert.ok('feedbackWork' in response);
    assert.equal(response.feedbackWork?.[0]?.privateText, 'Keep the smaller approach.');
    assert.equal(response.feedbackWork?.[1]?.decision?.plan, 'Implement the agreed approach.');
    assert.equal(response.feedbackWork?.[1]?.result?.outcome, 'clarification-needed');
    assert.deepEqual((await record()).result, question);
    assert.equal((await record()).progression?.stage, 'implementation');
    assert.equal(creates().length, 1);
  });

  it('should retain one implementation transition without replacing the assessment', async () => {
    const { id, who } = await operatorFollowup();
    const request = {
      action: 'handoff' as const,
      id,
      permission: 'implementation-and-publication' as const,
    };
    const preview = await service.run(manifest, root, who, request, true);
    assert.ok('digest' in preview && typeof preview.digest === 'string');
    assert.equal((await record()).work, undefined);
    await service.run(manifest, root, who, { ...request, digest: preview.digest }, true);
    const retained = await record();
    assert.deepEqual(retained.result, plan);
    assert.equal(retained.progression?.via, 'operator');
    assert.equal(retained.work?.publication, undefined);
    assert.equal(retained.work?.implementation?.runId, 'operator');
    const verified = await service.run(
      manifest,
      root,
      who,
      { action: 'implementation-context', id },
      true,
    );
    assert.equal(verified.status, 'verified');
    assert.ok('assessment' in verified);
    assert.deepEqual(verified.assessment, plan);
    const result = {
      outcome: 'done' as const,
      summary: 'Implemented.',
      fullResult: 'Implemented and checked the change.',
    };
    await service.run(
      manifest,
      root,
      who,
      { action: 'implementation-result', id, implementationResult: result },
      true,
    );
    assert.deepEqual((await record()).work?.result, result);
    await assert.rejects(context(id, who), /dispatch-assessment-handed-off/);
    await assert.rejects(
      service.run(manifest, root, who, { ...request, digest: preview.digest }, true),
      /dispatch-handoff-stale/,
    );
  });

  for (const mode of ['work', 'auto'] as const) {
    it(`should enter ${mode} implementation without a human followup or separate handoff`, async () => {
      const { id } = await operatorFollowup(false);
      const who = assessor(id);
      // The assessment turn itself may continue under current standing policy.
      inputReceipts = [];
      manifest.github!.notifications!.issueAssignment!.mode = mode;
      if (mode === 'auto') {
        const { journal } = await service.scope(manifest, root);
        await journal.exclusive(async (state, save) => {
          const retained = state.records[0]!;
          retained.result = { ...plan, decision: { mode: 'work', reasons: ['Bounded change.'] } };
          retained.stageReceipt!.resultDigest = automationHash(retained.result);
          await save();
        });
      }
      const before = await record();
      const verified = await service.run(
        manifest,
        root,
        who,
        { action: 'implementation-context', id },
        false,
      );
      assert.equal(verified.status, 'verified');
      const after = await record();
      assert.equal(after.progression?.via, mode);
      assert.equal(after.work?.publication, undefined);
      assert.deepEqual(after.result, before.result);
      assert.equal(after.threadId, before.threadId);
      assert.equal(after.worktree, before.worktree);
      assert.equal(creates().length, 1);
      const saved = await service.run(
        manifest,
        root,
        who,
        {
          action: 'implementation-result',
          id,
          implementationResult: {
            outcome: 'done',
            summary: 'Done',
            fullResult: 'Done and checked.',
          },
        },
        false,
      );
      assert.ok('handoff' in saved && saved.handoff);
      assert.equal(saved.handoff.next, 'delivery');
      assert.deepEqual('request' in saved.handoff && saved.handoff.request, {
        action: 'delivery',
        id,
        operation: 'prepare',
      });
      assert.equal((await record()).work?.result?.outcome, 'done');
    });
  }

  it('should keep plan feedback in planning even when native metadata says owner', async () => {
    const { id } = await feedbackOwner(false);
    consumeSend = true;
    await service.check(manifest, root);
    await service.run(manifest, root, coordinator, { action: 'reconcile', id });
    await service.run(manifest, root, coordinator, { action: 'next' });
    const event = (await record()).feedback!.events[0]!;
    assert.ok(event.turn);
    const result = await service.run(
      manifest,
      root,
      assessor(id, event.turn.runId),
      { action: 'implementation-context', id },
      true,
    );
    assert.equal(result.status, 'policy-held');
    assert.equal((await record()).progression, undefined);
  });

  it('should preserve a legacy publication-only request without promoting implementation', async () => {
    const { id, who } = await operatorFollowup();
    const request = { action: 'handoff' as const, id, permission: 'publication' as const };
    const preview = await service.run(manifest, root, who, request, true);
    assert.ok('digest' in preview);
    await service.run(manifest, root, who, { ...request, digest: preview.digest }, true);
    const retained = await record();
    assert.equal(retained.progression, undefined);
    assert.equal(retained.work?.implementation, undefined);
    assert.equal(retained.work?.publication?.runId, who.runId);
  });

  it('should resume implementation questions on a new native input without another handoff', async () => {
    const { id, who } = await operatorFollowup();
    await service.run(manifest, root, who, { action: 'implementation-context', id }, true);
    const question = {
      outcome: 'clarification-needed' as const,
      summary: 'Choose retention.',
      fullResult: 'Partial implementation retained.',
      questions: ['30 or 60 days?'],
    };
    await service.run(
      manifest,
      root,
      who,
      { action: 'implementation-result', id, implementationResult: question },
      false,
    );
    assert.equal(
      (await service.run(manifest, root, who, { action: 'implementation-context', id }, false))
        .status,
      'clarification-needed',
    );
    messages.push({
      role: 'user',
      content: '30 days.',
      idempotencyKey: 'answer:user',
      __openclaw: { id: 'answer-event', idempotencyKey: 'answer:user' },
    });
    const initialSkill = (await record()).work!.selection!.skill;
    await writeFile(join(root, 'SKILL.md'), '# updated implementation guidance');
    manifest.github!.notifications!.issueAssignment!.implementation = {
      guidance: 'Use the new implementation guidance.',
    };
    const answer = { ...who, runId: 'answer' };
    const resumed = await service.run(
      manifest,
      root,
      answer,
      { action: 'implementation-context', id },
      false,
    );
    assert.equal(resumed.status, 'verified');
    assert.ok('previousImplementationResult' in resumed);
    assert.deepEqual(resumed.previousImplementationResult, question);
    assert.ok('implementation' in resumed);
    const resumedSelection = resumed.implementation as {
      skill: { digest: string };
      guidance: { content: string };
    };
    assert.equal(resumedSelection.guidance.content, 'Use the new implementation guidance.');
    assert.notEqual(resumedSelection.skill.digest, initialSkill.digest);
    assert.deepEqual((await record()).work!.selection!.skill, initialSkill);
    await service.run(
      manifest,
      root,
      answer,
      {
        action: 'implementation-result',
        id,
        implementationResult: {
          outcome: 'done',
          summary: 'Done',
          fullResult: 'Completed with 30 days.',
        },
      },
      false,
    );
    assert.equal((await record()).work!.result!.outcome, 'done');
    assert.equal((await record()).progression?.stage, 'implementation');
    assert.equal(creates().length, 1);
  });

  it('should recover an existing implementation stage without replacing the openclaw issue', async () => {
    const { id, who } = await operatorFollowup();
    const request = { action: 'handoff' as const, id, permission: 'implementation' as const };
    const preview = await service.run(manifest, root, who, request, true);
    assert.ok('digest' in preview && typeof preview.digest === 'string');
    await service.run(manifest, root, who, { ...request, digest: preview.digest }, true);
    const before = await record();
    assert.equal(before.progression?.via, 'operator');
    const journal = (await service.scope(manifest, root)).journal;
    await journal.exclusive(async (state, save) => {
      delete state.records[0]!.progression;
      await save();
    });
    for (const mode of ['work', 'auto', 'plan'] as const) {
      manifest.github!.notifications!.issueAssignment!.mode = mode;
      const context = await service.run(
        manifest,
        root,
        who,
        { action: 'implementation-context', id },
        true,
      );
      assert.equal(context.status, 'verified');
      assert.ok('issueStage' in context && context.issueStage === 'implementation');
    }
    const after = await record();
    assert.equal(after.progression?.via, 'legacy');
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.worktree, before.worktree);
    assert.deepEqual(after.result, before.result);
    assert.deepEqual(after.work!.implementation, before.work!.implementation);
  });

  it('should verify the retained owner input after it leaves the recent history page', async () => {
    const { id, who } = await operatorFollowup();
    const request = { action: 'handoff' as const, id, permission: 'implementation' as const };
    const preview = await service.run(manifest, root, who, request, true);
    assert.ok('digest' in preview && typeof preview.digest === 'string');
    await service.run(manifest, root, who, { ...request, digest: preview.digest }, true);
    anchoredMessages = [messages.pop()!];
    const verified = await service.run(
      manifest,
      root,
      who,
      { action: 'implementation-context', id },
      true,
    );
    assert.equal(verified.status, 'verified');
    assert.ok(
      calls.some(
        ({ method, params }) =>
          method === 'chat.history' &&
          params.messageId === 'operator-event' &&
          params.sessionId === who.sessionId,
      ),
    );
  });

  it('should include ordinary publication in implementation while requiring context and a completed result', async () => {
    const { id, who } = await operatorFollowup();
    const request = { action: 'handoff' as const, id, permission: 'implementation' as const };
    const preview = await service.run(manifest, root, who, request, true);
    assert.ok('digest' in preview && typeof preview.digest === 'string');
    await service.run(manifest, root, who, { ...request, digest: preview.digest }, true);
    assert.equal((await record()).work?.publication, undefined);
    await assert.rejects(
      service.run(
        manifest,
        root,
        who,
        {
          action: 'implementation-result',
          id,
          implementationResult: { outcome: 'done', summary: 'Done', fullResult: 'Done' },
        },
        true,
      ),
      /implementation-context-missing/,
    );
    const delivery = await service.run(
      manifest,
      root,
      who,
      { action: 'delivery', operation: 'prepare', id },
      true,
    );
    assert.equal(delivery.status, 'waiting');
    assert.ok('code' in delivery && delivery.code === 'delivery-implementation-incomplete');
  });

  it('should reject owner-looking tool requests without native owner input evidence', async () => {
    const { id, who } = await operatorFollowup(false);
    const request = {
      action: 'handoff' as const,
      id,
      permission: 'implementation-and-publication' as const,
    };
    await assert.rejects(
      service.run(manifest, root, who, request, true),
      /dispatch-operator-input-unverified/,
    );
    assert.equal((await service.run(manifest, root, who, request, false)).status, 'policy-held');
    await assert.rejects(
      service.run(manifest, root, coordinator, request, true),
      /dispatch-assessment-caller-mismatch/,
    );
    assert.equal(
      (await service.run(manifest, root, assessor(id), request, true)).status,
      'policy-held',
    );
    assert.equal((await record()).work, undefined);
    assert.deepEqual((await record()).result, plan);
  });
  async function feedbackOwner(implementation = true) {
    if (!implementation) {
      manifest.github!.notifications!.issueAssignment!.feedback = true;
      await service.dependencies.intake.run(manifest, root, 'activate');
    }
    const { id, who } = await operatorFollowup();
    await retainConfirmedSummary(id);
    if (implementation) {
      const handoff = {
        action: 'handoff' as const,
        id,
        permission: 'implementation-and-publication' as const,
      };
      const preview = await service.run(manifest, root, who, handoff, true);
      assert.ok('digest' in preview);
      await service.run(manifest, root, who, { ...handoff, digest: preview.digest }, true);
    }
    const oldDigest = (await record()).manifestDigest;
    manifest.github!.notifications!.issueAssignment!.feedback = true;
    await service.dependencies.intake.run(manifest, root, 'activate');
    const comments: Array<GitHubCanonicalIssueComment> = [];
    service.dependencies.feedbackConnect = async () => ({
      ...fixture.client,
      getItemContext: async () => ({
        title: 'issue',
        body: '',
        comments: [],
        labels: [],
        truncated: false,
      }),
      listIssueComments: async () => ({ comments, truncated: false }),
      getIssueComment: async (_o, _n, _i, id) => {
        const comment = comments.find((c) => c.databaseId === id);
        if (!comment) throw new Error('comment-deleted');
        return comment;
      },
      createIssueComment: async () => {
        throw new Error('unexpected publication');
      },
      findOwnIssueComment: async () => undefined,
      replies: {
        create: async () => {
          throw new Error('unexpected reply');
        },
        find: async () => undefined,
      },
    });
    if (implementation) await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).manifestDigest, oldDigest);
    comments.push({
      nodeId: 'C_feedback',
      databaseId: 99,
      author: fixture.client.identity,
      body: '@receiver explain this',
      bodyTruncated: false,
      createdAt: '2026-10-07T10:03:00Z',
      updatedAt: '2026-10-07T10:03:00Z',
    });
    // feedback arrives on a later native occurrence, after the assessment pass.
    coordinator.runId = 'feedback-run';
    return { id, who, comments };
  }
  it('should dispatch assessment-only feedback on the next pass after completion reconciliation', async () => {
    const { id } = await feedbackOwner(false);
    assert.equal((await record()).handoff, undefined);
    assert.equal((await record()).assessmentTurn?.status, 'consumed');
    await service.check(manifest, root);
    assert.equal((await record()).feedback?.events.length, 1);
    const recovery = await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal(recovery.status, 'reconcile-required');
    const reconciled = await service.run(manifest, root, coordinator, { action: 'reconcile', id });
    assert.equal(reconciled.status, 'assessment-completed', JSON.stringify(reconciled));
    assert.equal((await record()).assessmentTurn?.status, 'completed');
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'next' })).status,
      'pass-completed',
    );
    assert.equal((await record()).feedback?.events[0]?.turn, undefined);
    coordinator.runId = 'after-assessment-reconciliation';
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.ok((await record()).feedback?.events[0]?.turn);
    assert.equal(creates().length, 1);
    assert.deepEqual((await record()).result, plan);
  });
  it('should reactivate unassigned openclaw feedback through ordinary intake without replacing the session', async () => {
    const { comments } = await feedbackOwner();
    fixture.item.assignees = [];
    fixture.events.push({
      ...fixture.events[0]!,
      nodeId: 'removed',
      databaseId: 31,
      event: 'unassigned',
      createdAt: '2026-10-07T10:02:00Z',
    });
    service.dependencies.now = () => baseline + 240_000;
    const before = await record();
    await service.run(
      manifest,
      root,
      { ...coordinator, runId: 'reactivation' },
      { action: 'next' },
    );
    const after = await record();
    assert.equal(after.retirement, undefined);
    assert.equal(after.feedbackReactivation?.assignmentEventId, 'removed');
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.feedback?.events[0]?.sourceId, comments[0]!.nodeId);
    assert.equal(creates().length, 1);
  });
  it('should reconcile an uncertain delivery announcement before discovering same-account feedback', async () => {
    const { comments } = await feedbackOwner();
    const announcement = attemptedAnnouncement(fixture.client.identity.nodeId);
    const connect = service.dependencies.feedbackConnect!;
    service.dependencies.feedbackConnect = async (...args) => ({
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
    const { journal } = await service.scope(manifest, root);
    await journal.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.work!.delivery = {
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
          authorId: fixture.client.identity.nodeId,
          policyDigest: 'a'.repeat(64),
        },
        title: 'Title',
        body: 'Body',
        creationAttempted: true,
        reconciled: true,
        announcement: announcement.state,
      };
      await save();
    });
    await service.check(manifest, root);
    assert.deepEqual(
      (await record()).feedback!.events.map((event) => event.sourceId),
      ['C_feedback'],
    );
  });
  it('should preserve a concurrently advanced owner at the first feedback checkpoint and resume later', async () => {
    await feedbackOwner();
    const current = await service.scope(manifest, root);
    const snapshot = await current.journal.read();
    await current.journal.exclusive(async (state, save) => {
      state.records[0]!.result = { ...state.records[0]!.result!, summary: 'A newer assessment.' };
      await save();
    });
    const newer = await current.journal.read();
    const scans = await scanOpenClawFeedback({
      service,
      state: snapshot,
      manifest,
      workspace: root,
      sourceThreadId: coordinator.sessionKey,
      authority: {},
      now: service.dependencies.now!(),
      checkpoint: (scan) => discoveryCheckpoint(current.journal, scan),
    });
    assert.deepEqual(scans, []);
    assert.deepEqual(await current.journal.read(), newer);
    await service.check(manifest, root);
    assert.equal((await record()).result?.summary, 'A newer assessment.');
    assert.equal((await record()).feedback!.events.length, 1);
  });
  it('should discover and deliver existing feedback while assignment search is incomplete', async () => {
    await feedbackOwner();
    const check = await service.check(manifest, root, undefined, {
      status: 'blocked',
      changed: true,
      code: 'intake-search-incomplete',
    });
    assert.equal(check.changed, true);
    assert.equal((await record()).feedback!.events.length, 1);
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.ok((await record()).feedback!.events[0]!.turn);
  });
  it('should keep feedback discovery paused for shared authentication or identity failures', async () => {
    await feedbackOwner();
    for (const code of [
      'intake-github-authentication',
      'intake-account-changed',
      'intake-automation-update-required',
    ]) {
      const check = await service.check(manifest, root, undefined, {
        status: 'blocked',
        changed: true,
        code,
      });
      assert.equal(check.outcome, 'failed');
      assert.equal((await record()).feedback?.events.length ?? 0, 0);
    }
  });
  it('should validate each feedback owner once during discovery and consume the saved result', async () => {
    await feedbackOwner();
    const validate = service.validate.bind(service);
    let validations = 0;
    service.validate = async (...args) => {
      validations++;
      return validate(...args);
    };
    const check = await service.check(manifest, root);
    assert.equal(check.changed, true);
    assert.equal(validations, 1);
    assert.equal((await record()).feedback!.events.length, 1);
    const discovery = (await record()).feedback!.watermarks;
    assert.ok(discovery && Object.keys(discovery).length === 1);
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events.length, 1);
  });
  it('should expose exhausted prerequisite budgets without claiming an attempted feedback read', async () => {
    await feedbackOwner();
    const current = await service.scope(manifest, root);
    service.dependencies.connect = async () => {
      throw new Error('no provider opportunity remains');
    };
    for (let poll = 0; poll < 3; poll++) {
      let clock = 0;
      const budget = new DiscoveryBudget(20000, undefined, () => clock);
      clock = 20000;
      await scanOpenClawFeedback({
        service,
        state: await current.journal.read(),
        manifest,
        workspace: root,
        sourceThreadId: coordinator.sessionKey,
        authority: {},
        now: service.dependencies.now!(),
        budget,
        checkpoint: (scan) => discoveryCheckpoint(current.journal, scan),
      });
    }
    const feedback = (await record()).feedback!;
    assert.equal(feedback.scannedTime, undefined);
    assert.equal(feedback.discoveryPending, true);
    assert.equal(feedback.code, 'feedback-discovery-no-progress');
    assert.equal(
      feedback.discoveryStalls![(await record()).id]!.operation,
      'occurrence-budget-before-feedback',
    );
  });

  it('should report repeated discovery interruptions and recover through the coordinator after restart', async () => {
    await feedbackOwner();
    const validate = service.validate.bind(service);
    for (let poll = 0; poll < 3; poll++) {
      const controller = new AbortController();
      service.validate = async (...args) => {
        const result = await validate(...args);
        controller.abort();
        return result;
      };
      const check = await service.check(manifest, root, controller.signal);
      assert.ok('more' in check && check.more);
      assert.equal((await record()).feedback!.discoveryPending, true);
      if (poll === 0) {
        await service.run(manifest, root, coordinator, { action: 'report' });
      }
      // reload the persisted journal through a new service, not a retained scan object.
      service = new OpenClawDispatch({ ...service.dependencies });
    }
    coordinator.runId = 'stalled-report';
    const report = await service.run(manifest, root, coordinator, { action: 'report' });
    assert.ok('response' in report && /feedback-discovery-no-progress/.test(report.response));
    service.validate = validate;
    // a recent incomplete attempt must not suppress the coordinator's bounded recovery.
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.discoveryPending, false);
    assert.equal((await record()).feedback!.events.length, 1);
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events.length, 1);
    assert.ok((await record()).feedback!.events[0]!.turn);
  });
  it('should rotate issue and pr discovery, report the stalled pr read, and admit its exact source once', async () => {
    const { comments } = await feedbackOwner();
    const current = await service.scope(manifest, root);
    await current.journal.exclusive(async (state, save) => {
      const owner = state.records[0]!;
      owner.work!.delivery = {
        id: 'd'.repeat(64),
        title: 'Delivery',
        body: 'Closes #3',
        creationAttempted: true,
        reconciled: true,
        pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
        binding: {
          repositoryId: fixture.repository.nodeId,
          issueId: fixture.item.nodeId,
          threadId: owner.threadId!,
          sessionId: owner.sessionCreation!.sessionId!,
          worktree: owner.worktree!,
          branch: 'issue-3',
          base: 'main',
          head: 'a'.repeat(40),
          authorId: fixture.client.identity.nodeId,
          policyDigest: owner.manifestDigest,
        },
      };
      await save();
    });
    let paused = true;
    const reads: number[] = [];
    const connect = service.dependencies.feedbackConnect!;
    service.dependencies.feedbackConnect = async (...args) => ({
      ...(await connect(...args)),
      getItem: async (_o, _n, number) =>
        number === 7
          ? {
              ...fixture.item,
              nodeId: 'PR_7',
              number: 7,
              itemType: 'pull-request',
              pullRequest: {
                baseRef: 'main',
                baseRepositoryDatabaseId: fixture.repository.databaseId,
                baseRepositoryNodeId: fixture.repository.nodeId,
                draft: false,
                headRef: 'issue-3',
                headSha: 'a'.repeat(40),
                merged: false,
              },
            }
          : fixture.item,
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
      await service.check(manifest, root);
      service = new OpenClawDispatch({ ...service.dependencies });
    }
    assert.deepEqual(reads, [3, 7, 7, 3, 7]);
    const stalled = (await record()).feedback!;
    assert.deepEqual(stalled.discovery!.PR_7!.reads, {});
    assert.equal(stalled.watermarks?.PR_7, undefined);
    assert.equal(stalled.discoveryStalls!.PR_7!.operation, 'comments');
    assert.equal(stalled.code, 'feedback-discovery-no-progress');
    coordinator.runId = 'pr-obstacle';
    const report = await service.run(manifest, root, coordinator, { action: 'report' });
    assert.ok('response' in report && report.response.includes('owner/repo/pull/7'));
    const before = reads.length;
    await service.run(manifest, root, coordinator, { action: 'next' });
    const after = reads.length;
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.ok(after > before);
    assert.equal(reads.length, after, 'one bounded recovery scan per native run');
    coordinator.runId = 'same-pr-obstacle';
    const unchanged = await service.run(manifest, root, coordinator, { action: 'report' });
    assert.ok('response' in unchanged && unchanged.response === '');
    paused = false;
    coordinator.runId = 'pr-recovery';
    await service.run(manifest, root, coordinator, { action: 'next' });
    const event = (await record()).feedback!.events[0]!;
    assert.equal(event.sourceId, comments[0]!.nodeId);
    assert.equal(event.nodeId, 'PR_7');
    assert.equal(event.itemType, 'pull-request');
    assert.deepEqual(JSON.parse(event.source), comments[0]);
    assert.ok(event.turn);
    assert.equal((await record()).feedback!.code, undefined);
    const recovery = await service.run(manifest, root, coordinator, { action: 'report' });
    assert.ok(
      'response' in recovery && recovery.response.includes('feedback-discovery-no-progress'),
    );
    coordinator.runId = 'healthy-pr-report';
    const healthy = await service.run(manifest, root, coordinator, { action: 'report' });
    assert.ok('response' in healthy && healthy.response === '');
    await service.check(manifest, root);
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events.length, 1);
    assert.equal((await record()).feedback!.events[0]!.turn!.runId, event.turn.runId);
  });

  it('should continue feedback discovery for another owner after an unrelated identity failure', async () => {
    await assignments(2, 2);
    const first = await next();
    await prepare(first);
    await assess(first.id);
    const second = await next();
    await prepare(second);
    await assess(second.id);
    await completeAssessment(first.id);
    await completeAssessment(second.id);
    manifest.github!.notifications!.issueAssignment!.feedback = true;
    const validate = service.validate.bind(service);
    service.validate = async (...args) => {
      if (args[2].id === first.id) throw new Error('dispatch-issue-identity-changed');
      return validate(...args);
    };
    const source: GitHubCanonicalIssueComment = {
      nodeId: 'C_sibling',
      databaseId: 123,
      author: fixture.client.identity,
      body: '@receiver explain this',
      bodyTruncated: false,
      createdAt: '2026-10-07T10:03:00Z',
      updatedAt: '2026-10-07T10:03:00Z',
    };
    const connect = service.dependencies.feedbackConnect!;
    service.dependencies.feedbackConnect = async (...args) => ({
      ...(await connect(...args)),
      listIssueComments: async () => ({ comments: [source], truncated: false }),
      getIssueComment: async () => source,
    });
    const current = await service.scope(manifest, root);
    await current.journal.exclusive(async (state, save) => {
      for (const owner of state.records)
        owner.feedback = { startedAt: baseline, baseline: {}, events: [] };
      await save();
    });
    await service.check(manifest, root);
    const state = await current.journal.read();
    assert.equal(
      state.records.find((r) => r.id === first.id)!.feedback!.code,
      'dispatch-issue-identity-changed',
    );
    const sibling = state.records.find((r) => r.id === second.id)!;
    assert.equal(sibling.feedback!.discoveryPending, false);
    assert.equal(sibling.feedback!.events[0]!.sourceId, source.nodeId);
    coordinator.runId = 'sibling-feedback';
    await service.run(manifest, root, coordinator, { action: 'next' });
    const fresh = (await current.journal.read()).records.find((r) => r.id === second.id)!;
    assert.ok(fresh.feedback!.events[0]!.turn);
  });

  it('should reactivate scoped feedback even when assignment membership was checked recently', async () => {
    const { comments } = await feedbackOwner(false);
    const comment = comments.pop()!;
    await service.check(manifest, root);
    const before = await record();
    fixture.item.assignees = [];
    fixture.events.push({
      ...fixture.events[0]!,
      nodeId: 'removed',
      databaseId: 31,
      event: 'unassigned',
      createdAt: new Date(service.dependencies.now!()).toISOString(),
    });
    comments.push({
      ...comment,
      createdAt: new Date(service.dependencies.now!() + 1000).toISOString(),
      updatedAt: new Date(service.dependencies.now!() + 1000).toISOString(),
    });
    const now = service.dependencies.now!() + 2000;
    service.dependencies.now = () => now;
    const intake = service.dependencies.intake;
    const selector = { repository: 'owner/repo', itemType: 'issue' as const, number: 3 };
    const observation = await intake.run(
      manifest,
      root,
      'scan',
      (await intake.select(manifest, root)).selected!.digest,
      undefined,
      selector,
    );
    await service.check(manifest, root, undefined, observation, { ...selector, number: 4 });
    assert.equal((await record()).lifecycleCheckedAt, before.lifecycleCheckedAt);
    assert.equal((await record()).feedbackReactivation, undefined);
    await service.check(manifest, root, undefined, observation, selector);
    const after = await record();
    assert.equal(after.retirement, undefined);
    assert.equal(after.feedbackReactivation?.assignmentEventId, 'removed');
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.feedback?.events[0]?.sourceId, comment.nodeId);
    assert.equal(creates().length, 1);
  });

  it('should discover new feedback on a scoped refresh despite a recent empty discovery', async () => {
    const { comments } = await feedbackOwner();
    const comment = comments.pop()!;
    await service.check(manifest, root);
    comments.push(comment);
    // reproduces the old selected-refresh path: next consumes the cached empty discovery.
    assert.equal(
      (await service.run(manifest, root, coordinator, { action: 'next' })).status,
      'idle',
    );
    assert.equal((await record()).feedback!.events.length, 0);
    const intake = service.dependencies.intake;
    const observation = await intake.run(
      manifest,
      root,
      'scan',
      (await intake.select(manifest, root)).selected!.digest,
      undefined,
      { repository: 'owner/repo', itemType: 'issue', number: 3 },
    );
    const run = intake.run.bind(intake);
    intake.run = async () => {
      throw new Error('scoped feedback discovery must not scan other assignments');
    };
    try {
      await service.check(manifest, root, undefined, observation);
    } finally {
      intake.run = run;
    }
    coordinator.runId = 'fresh-feedback-run';
    await service.run(manifest, root, coordinator, { action: 'next' });
    const events = (await record()).feedback!.events;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.sourceId, comment.nodeId);
    assert.ok(events[0]!.turn);
  });
  it('should enable feedback on a handed-off owner without changing historical assessment authority', async () => {
    const { id } = await feedbackOwner();
    consumeSend = true;
    assert.equal((await service.check(manifest, root)).changed, true);
    assert.equal((await record()).feedback!.events.length, 1);
    await service.run(manifest, root, coordinator, { action: 'next' });
    const event = (await record()).feedback!.events[0]!;
    assert.ok(event.turn);
    (messages.at(-1)!.__openclaw as Record<string, unknown>).id = 'feedback-input';
    assert.equal(creates().length, 1);
    assert.equal((await record()).result?.fullAssessment, plan.fullAssessment);
    const who = assessor(id, event.turn.runId);
    const context = await service.run(manifest, root, who, {
      action: 'feedback',
      operation: 'context',
      id,
      eventId: event.id,
    });
    assert.equal(context.status, 'verified');
    for (const action of ['context', 'implementation-context'] as const)
      assert.equal(
        (await service.run(manifest, root, who, { action, id }, false)).status,
        'verified',
      );
    const priorWork = (await record()).work?.result;
    const clarification = {
      outcome: 'clarification-needed' as const,
      summary: 'Need a value.',
      fullResult: 'Partial feedback work retained.',
      questions: ['Which value?'],
    };
    const completed = await service.run(manifest, root, who, {
      action: 'implementation-result',
      id,
      implementationResult: clarification,
    });
    assert.equal(completed.status, 'recorded');
    assert.deepEqual((await record()).feedback!.events[0]!.work!.result, clarification);
    assert.deepEqual((await record()).work?.result, priorWork);
    const result = await service.run(manifest, root, who, {
      action: 'feedback',
      operation: 'result',
      id,
      eventId: event.id,
      privateText: 'Complete private answer.',
    });
    assert.equal(result.status, 'recorded');
    assert.equal((await record()).feedback!.events[0]!.phase, 'published');
    assert.equal(creates().length, 1);
  });
  for (const source of ['implementation', 'auto-handoff'] as const)
    it(`should dispatch queued feedback in the pass that reconciles a finished ${source} turn`, async () => {
      const { id } = await feedbackOwner();
      const current = await service.scope(manifest, root);
      await current.journal.exclusive(async (state, save) => {
        const record = state.records[0]!;
        record.assessmentTurn!.status = 'completed';
        record.assessmentTurn!.replyEventId = 'assessment-reply';
        record.work!.turn = {
          runId: `${id}:implementation`,
          message: 'Continue work.',
          status: 'accepted',
        };
        if (source === 'auto-handoff') {
          record.work!.turn = {
            ...record.work!.turn,
            status: 'completed',
            consumedByEventId: 'old-work-input',
            replyEventId: 'old-work-reply',
          };
          record.decisionTurn = {
            runId: `${id}:auto-decision`,
            message: 'Choose plan or work.',
            status: 'accepted',
          };
        }
        record.work!.result = {
          outcome: 'clarification-needed',
          summary: 'Need input.',
          fullResult: 'Partial work.',
          questions: ['Which behavior?'],
        };
        await save();
      });
      active = false;
      inputReceipts = [];
      messages.push(
        {
          role: 'user',
          content: 'Continue work.',
          idempotencyKey: `${id}:implementation:user`,
          __openclaw: { id: 'old-work-input', idempotencyKey: `${id}:implementation:user` },
        },
        {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Which behavior?' }],
          __openclaw: { id: 'old-work-reply', runId: `${id}:implementation`, runTerminal: true },
        },
      );
      if (source === 'auto-handoff')
        messages.push(
          {
            role: 'user',
            content: 'Choose plan or work.',
            idempotencyKey: `${id}:auto-decision:user`,
            __openclaw: { id: 'decision-input', idempotencyKey: `${id}:auto-decision:user` },
          },
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'Work is ready.' }],
            __openclaw: { id: 'decision-reply', runId: `${id}:auto-decision`, runTerminal: true },
          },
        );
      const before = sends().length;
      const next = await workPass('feedback-after-work');
      assert.equal(next.status, 'feedback-pending', JSON.stringify(next));
      const saved = await record();
      assert.equal(saved.id, id);
      assert.equal(saved.work!.turn!.status, 'completed');
      if (source === 'auto-handoff') assert.equal(saved.decisionTurn!.status, 'completed');
      assert.equal(saved.feedback!.events[0]!.phase, 'running');
      assert.equal(sends().length, before + 1);
      await workPass('feedback-after-work');
      assert.equal(sends().length, before + 1);
    });

  it('should queue feedback during operator work and revoke an edited or removed source before sending', async () => {
    const { comments } = await feedbackOwner();
    active = true;
    const before = sends().length;
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events[0]!.phase, 'queued');
    assert.equal(sends().length, before);
    comments[0]!.body = 'mention removed';
    active = false;
    coordinator.runId = 'source-revocation-poll';
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events[0]!.phase, 'blocked');
    assert.equal(sends().length, before);
  });
  it('should reconcile an uncertain feedback send after restart without sending twice', async () => {
    await feedbackOwner();
    loseSend = true;
    const before = sends().length;
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events[0]!.turn?.status, 'attempted');
    loseSend = false;
    service = new OpenClawDispatch(service.dependencies);
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events[0]!.turn?.status, 'accepted');
    assert.equal(sends().length, before + 1);
  });
  it('should retain admitted feedback after its policy defaults change without resending', async () => {
    await feedbackOwner();
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events[0]!.phase, 'running');
    const before = sends().length;
    manifest.github!.notifications!.intervalMinutes += 1;
    manifest.github!.notifications!.maxConcurrentItems += 1;
    manifest.github!.notifications!.cleanup = { enabled: true, graceMinutes: 30 };
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events[0]!.phase, 'running');
    manifest.github!.notifications!.issueAssignment!.allowed = [
      ...manifest.github!.notifications!.issueAssignment!.allowed,
      { login: 'another', nodeId: 'U_another' },
    ];
    await service.dependencies.intake.run(manifest, root, 'activate');
    await service.run(manifest, root, coordinator, { action: 'next' });
    const saved = await record();
    assert.equal(saved.feedback!.events[0]!.code, undefined);
    assert.equal(saved.feedback!.events[0]!.phase, 'running');
    assert.equal(openClawCapacity([saved], 1).available, 0);
    active = false;
    inputReceipts = [];
    await service.run(manifest, root, coordinator, { action: 'next' });
    assert.equal((await record()).feedback!.events[0]!.phase, 'running');
    assert.equal(sends().length, before);
  });
  for (const limit of [1, 3])
    for (const olderAssignment of [true, false]) {
      it(`should select the oldest eligible ${olderAssignment ? 'assignment' : 'feedback'} in a shared pool of ${limit}`, async () => {
        manifest.github!.notifications!.maxConcurrentItems = limit;
        await service.dependencies.intake.run(manifest, root, 'activate');
        await feedbackOwner();
        const { store } = await service.dependencies.intake.select(manifest, root);
        const createdAt = olderAssignment ? '2026-10-07T10:01:30Z' : '2026-10-07T10:04:00Z';
        const other = { ...fixture.item, nodeId: 'I_other', databaseId: 21, number: 4 };
        const assignment = { ...fixture.events[0]!, nodeId: 'E_other', databaseId: 31, createdAt };
        const getItem = fixture.client.getItem;
        fixture.client.getItem = async (owner, name, number) =>
          number === 4 ? other : getItem(owner, name, number);
        fixture.client.listAssignmentEvents = async (_owner, _name, number) => ({
          events: number === 4 ? [assignment] : fixture.events,
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
        const selected = await service.run(manifest, root, coordinator, { action: 'next' });
        assert.equal(selected.status, olderAssignment ? 'routing-required' : 'feedback-pending');
        assert.equal(Boolean((await record()).feedback!.events[0]!.turn), !olderAssignment);
        if (limit === 3) {
          // resume the same native occurrence with its saved mixed-work snapshot.
          service = new OpenClawDispatch(service.dependencies);
          const second = await service.run(manifest, root, coordinator, { action: 'next' });
          assert.equal(second.status, olderAssignment ? 'feedback-pending' : 'routing-required');
          assert.equal(
            (await service.run(manifest, root, coordinator, { action: 'next' })).status,
            'pass-completed',
          );
          const state = await (await service.scope(manifest, root)).journal.read();
          const pass = state.openclawPasses!.find((entry) => entry.runId === coordinator.runId)!;
          assert.equal(pass.candidates.length, 2);
          assert.equal(new Set(pass.selected).size, 2);
        }
      });
    }
  it('should discard a stale provider snapshot without holding the journal during discovery', async () => {
    await feedbackOwner();
    active = true;
    await service.run(manifest, root, coordinator, { action: 'next' });
    const connect = service.dependencies.feedbackConnect!;
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    service.dependencies.feedbackConnect = async (...args) => {
      const provider = await connect(...args);
      const list = provider.listIssueComments;
      provider.listIssueComments = async (...parameters) => {
        started.resolve();
        await released.promise;
        return list(...parameters);
      };
      return provider;
    };
    coordinator.runId = 'concurrent-discovery-poll';
    const scan = service.run(manifest, root, coordinator, { action: 'next' });
    await started.promise;
    const { journal } = await service.scope(manifest, root);
    await journal.exclusive(async (state, save) => {
      const event = state.records[0]!.feedback!.events[0]!;
      event.phase = 'blocked';
      event.code = 'test-concurrent-revocation';
      await save();
    });
    released.resolve();
    await scan;
    assert.equal((await record()).feedback!.events[0]!.code, 'test-concurrent-revocation');
  });
  it('should refuse reconciliation as a way to send a queued event past capacity', async () => {
    const { id } = await feedbackOwner();
    active = true;
    await service.run(manifest, root, coordinator, { action: 'next' });
    const event = (await record()).feedback!.events[0]!;
    await assert.rejects(
      service.run(manifest, root, coordinator, {
        action: 'feedback',
        operation: 'reconcile',
        id,
        eventId: event.id,
      }),
      /feedback-send-unverified/,
    );
    assert.equal(event.turn, undefined);
  });
  it('should preserve the feedback baseline through initial routing and native creation', async () => {
    manifest.github!.notifications!.issueAssignment!.feedback = true;
    await service.dependencies.intake.run(manifest, root, 'activate');
    const input = await next();
    const baseline = (await record()).feedback?.startedAt;
    assert.equal(typeof baseline, 'number');
    assert.equal((await prepare(input)).status, 'session-created');
    assert.equal((await record()).feedback?.startedAt, baseline);
    assert.deepEqual((await record()).feedback?.events, []);
  });
});
