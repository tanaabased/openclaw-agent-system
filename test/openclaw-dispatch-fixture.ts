import { GatewayClientRequestError } from '@openclaw/gateway-client';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { automationHash } from '../agent/automation-hash.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import { nativeTurnFor } from '../agent/openclaw-native-turns.ts';
import type { DispatchCaller } from '../agent/openclaw-session-create.ts';
import { type AssessmentSubmission } from '../agent/tasks/assessment/assessment-result.ts';
import AssignmentClaimStore from '../agent/tasks/dispatch/assignment-claim-store.ts';
import type { ClaimClient } from '../agent/tasks/dispatch/assignment-claim.ts';
import OpenClawAssignmentClaims from '../agent/tasks/dispatch/openclaw-assignment-claims.ts';
import OpenClawDispatch from '../agent/tasks/dispatch/openclaw-dispatch.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import { sessionDispatchRequest } from '../credentials/session-dispatch-client.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { baseline, intakeFixture, originalIntakeDigest } from './github-intake-fixture.ts';

export default function openclawDispatchFixture(options: { discover?: boolean } = {}) {
  const fixtureState = {} as {
    fixtureIntake: OpenClawIntake;
    root: string;
    fixture: ReturnType<typeof intakeFixture>;
    manifest: AgentManifest;
    service: OpenClawDispatch;
    config: OpenClawConfig;
    session: Record<string, unknown> | null;
    calls: Array<{ method: string; params: Record<string, unknown> }>;
    lost: boolean;
    absent: boolean;
    active: boolean;
    historySessionId: string | undefined;
    historyRejected: boolean;
    onCreate: (() => void) | undefined;
    onSend: (() => void) | undefined;
    afterSend: (() => Promise<void>) | undefined;
    messages: Array<Record<string, unknown>>;
    anchoredMessages: Array<Record<string, unknown>>;
    inputReceipts: Array<Record<string, unknown>>;
    waitResult: Record<string, unknown>;
    loseSend: boolean;
    acceptSend: boolean;
    consumeSend: boolean;
    preparedWorktrees: number;
    multiple: boolean;
    cronJobs: unknown[];
    terminalInputs: Array<{ id: string; state: string }>;
    archiveError: boolean;
    foreignSessions: Array<Record<string, unknown>>;
    cronInventoryTotal: number | undefined;
    ordinarySkills: Array<Record<string, unknown>>;
    describeError: GatewayClientRequestError | undefined;
    reportRun: number;
  };
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
    if (options.discover === false) coordinator.jobId = 'fixture-job';
    else delete coordinator.jobId;
    fixtureState.root = await realpath(await mkdtemp('/tmp/openclaw-dispatch-'));
    fixtureState.fixture = intakeFixture();
    fixtureState.manifest = {
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
        notifications: {
          ...fixtureState.fixture.policy,
          maxConcurrentItems: 1,
          runtimes: ['openclaw'],
        },
      },
    };
    const manifestService = {
      async loadForAgentId() {
        return {
          status: 'loaded' as const,
          manifest: fixtureState.manifest,
          scope: { agentId: 'receiver', workspaceDir: fixtureState.root },
          path: join(fixtureState.root, 'agent.yaml'),
          digest: 'manifest',
          diagnostics: [],
          validationChecks: [],
        };
      },
    };
    let now = baseline;
    const intake = (fixtureState.fixtureIntake = new OpenClawIntake({
      root: join(fixtureState.root, 'intake'),
      namespace: fixtureState.root,
      manifestService,
      now: () => now,
      connect: async () => fixtureState.fixture.client,
    }));
    const discoverAssigned = fixtureState.fixture.client.discoverAssigned;
    if (options.discover === false)
      fixtureState.fixture.client.discoverAssigned = async () => ({
        candidates: [],
        incomplete: false,
        totalCount: 0,
        truncated: false,
      });
    await intake.run(fixtureState.manifest, fixtureState.root, 'activate');
    fixtureState.fixture.client.discoverAssigned = discoverAssigned;
    now += 120000;
    if (options.discover !== false)
      await intake.run(
        fixtureState.manifest,
        fixtureState.root,
        'scan',
        (await intake.select(fixtureState.manifest, fixtureState.root)).selected!.digest,
      );
    const worktree = {
      path: join(fixtureState.root, 'worktree'),
      branch: 'issue-3',
      repositoryId: 'github-10',
      workId: 'issue-20',
      status: 'existing' as const,
    };
    await mkdir(worktree.path);
    await writeFile(join(fixtureState.root, 'SKILL.md'), '# shared assessment fixture');
    fixtureState.session = null;
    fixtureState.calls = [];
    fixtureState.cronJobs = [];
    fixtureState.terminalInputs = [];
    fixtureState.archiveError = false;
    fixtureState.foreignSessions = [];
    fixtureState.cronInventoryTotal = undefined;
    await mkdir(join(fixtureState.root, 'ordinary'));
    await writeFile(
      join(fixtureState.root, 'ordinary', 'SKILL.md'),
      'Assess the request. Explain a useful plan or ask what you need.',
    );
    fixtureState.ordinarySkills = [
      {
        name: 'ordinary-assessment',
        source: 'openclaw-workspace',
        filePath: join(fixtureState.root, 'ordinary', 'SKILL.md'),
        eligible: true,
        modelVisible: true,
      },
    ];
    fixtureState.describeError = undefined;
    fixtureState.lost = false;
    fixtureState.absent = false;
    fixtureState.active = false;
    fixtureState.historySessionId = undefined;
    fixtureState.historyRejected = false;
    fixtureState.onCreate = undefined;
    fixtureState.onSend = undefined;
    fixtureState.afterSend = undefined;
    fixtureState.messages = [];
    fixtureState.anchoredMessages = [];
    fixtureState.inputReceipts = [];
    fixtureState.waitResult = { status: 'timeout' };
    fixtureState.loseSend = false;
    fixtureState.acceptSend = true;
    fixtureState.consumeSend = false;
    fixtureState.preparedWorktrees = 0;
    fixtureState.multiple = false;
    sessions.clear();
    histories.clear();
    fixtureState.config = {};
    fixtureState.service = new OpenClawDispatch({
      root: join(fixtureState.root, 'dispatch'),
      config: () => fixtureState.config,
      intake,
      taskContext: intake.dependencies,
      now: () => now,
      coordinator: async () => coordinator.sessionKey,
      connect: async () => ({
        ...fixtureState.fixture.client,
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
        ...fixtureState.fixture.client,
        identity: fixtureState.fixture.client.identity,
        listIssueComments: async () => ({ comments: [], truncated: false }),
        getIssueComment: async () => {
          throw new Error('no source');
        },
        createIssueComment: async () => {
          throw new Error('no publication expected');
        },
        findOwnIssueComment: async () => undefined,
        getItem: fixtureState.fixture.client.getItem,
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
          fixtureState.preparedWorktrees++;
          if (!fixtureState.multiple) return worktree;
          const path = join(fixtureState.root, `worktree-${input.itemNumber}`);
          await mkdir(path, { recursive: true });
          return { ...worktree, path };
        },
        inspectGitHub: async (input) =>
          fixtureState.multiple
            ? { ...worktree, path: join(fixtureState.root, `worktree-${input.itemNumber}`) }
            : worktree,
      },
      credential: {
        async use(authority, operation) {
          return operation(
            sessionDispatchRequest(async (method, params) => {
              await authority.assertCurrent?.();
              authority.signal?.throwIfAborted();
              fixtureState.calls.push({ method, params });
              if (method === 'sessions.create') {
                const persisted = (
                  await (
                    await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
                  ).journal.read()
                ).records.find(
                  (record) =>
                    record.request && 'key' in record.request && record.request.key === params.key,
                )!;
                assert.equal(persisted.sessionCreation?.attempted, true);
                fixtureState.onCreate?.();
                if (!fixtureState.absent)
                  fixtureState.session = {
                    key: params.key,
                    agentId: params.agentId,
                    sessionId: fixtureState.multiple ? `ordinary-${persisted.id}` : 'ordinary-id',
                    spawnedCwd: params.cwd,
                    label: params.label,
                    displayName: params.displayName,
                    category: params.category,
                    modelProvider: String(params.model).split('/')[0],
                    model: String(params.model).split('/').slice(1).join('/'),
                    thinkingLevel: params.thinkingLevel,
                    parentSessionKey: 'agent:receiver:main',
                    spawnDepth: 0,
                  };
                if (fixtureState.multiple && fixtureState.session) {
                  sessions.set(String(params.key), fixtureState.session);
                  histories.set(String(params.key), {
                    messages: [],
                    inputReceipts: [],
                    active: false,
                  });
                }
                if (fixtureState.lost) throw new Error('response-lost');
                return {
                  key: params.key,
                  sessionId: fixtureState.session?.sessionId,
                  runStarted: false,
                };
              }
              if (method === 'skills.status')
                return {
                  skills: [
                    ...fixtureState.ordinarySkills,
                    {
                      name: 'agent-system-github-reply',
                      source: 'openclaw-plugins',
                      filePath: join(fixtureState.root, 'SKILL.md'),
                      eligible: true,
                      modelVisible: true,
                    },
                    {
                      name: 'agent-system-task-assessment',
                      source: 'openclaw-plugins',
                      filePath: join(fixtureState.root, 'SKILL.md'),
                      eligible: true,
                      modelVisible: true,
                    },
                    {
                      name: 'agent-system-task-implementation',
                      source: 'openclaw-plugins',
                      filePath: join(fixtureState.root, 'SKILL.md'),
                      eligible: true,
                      modelVisible: true,
                    },
                  ],
                };
              if (method === 'cron.status')
                return { jobs: fixtureState.cronInventoryTotal ?? fixtureState.cronJobs.length };
              if (method === 'cron.list')
                return {
                  jobs: fixtureState.cronJobs
                    .slice(
                      Number(params.offset ?? 0),
                      Number(params.offset ?? 0) + Number(params.limit ?? 200),
                    )
                    .map((job, n) => ({
                      id: `job-${Number(params.offset ?? 0) + n}`,
                      configRevision: 'r',
                      enabled: true,
                      schedule: {},
                      payload: { kind: 'agentTurn' },
                      state: {},
                      ...(job as object),
                    })),
                  total: fixtureState.cronJobs.length,
                  hasMore:
                    Number(params.offset ?? 0) + Number(params.limit ?? 200) <
                    fixtureState.cronJobs.length,
                };
              if (method === 'sessions.patch') {
                if (fixtureState.archiveError)
                  throw new GatewayClientRequestError({ code: 'FORBIDDEN', message: 'private' });
                const target =
                  fixtureState.foreignSessions.find((row) => row.key === params.key) ??
                  (fixtureState.multiple
                    ? sessions.get(String(params.key))!
                    : fixtureState.session!);
                assert.equal(target.sessionId, params.expectedSessionId);
                target.archived = params.archived;
                return { ok: true };
              }
              if (method === 'sessions.describe') {
                if (fixtureState.describeError) throw fixtureState.describeError;
                return {
                  session:
                    fixtureState.foreignSessions.find((row) => row.key === params.key) ??
                    (fixtureState.multiple
                      ? sessions.get(String(params.key))
                      : fixtureState.session),
                };
              }
              if (method === 'sessions.list') {
                const rows = [
                  ...(fixtureState.multiple
                    ? [...sessions.values()]
                    : fixtureState.session
                      ? [fixtureState.session]
                      : []),
                  ...fixtureState.foreignSessions,
                ].filter((row) => row.spawnedCwd === params.workspaceDir && row.listed !== false);
                return {
                  sessions: rows.slice(
                    Number(params.offset ?? 0),
                    Number(params.offset ?? 0) + Number(params.limit),
                  ),
                  totalCount: rows.length,
                };
              }
              if (method === 'chat.send') {
                const feedbackTurn = (
                  await record(String(params.sessionKey))
                ).feedback?.events.find(
                  (event) => event.turn?.runId === params.idempotencyKey,
                )?.turn;
                const current = await record(String(params.sessionKey));
                const workTurn = current.nativeTurns?.find(
                  ({ turn }) => turn.runId === params.idempotencyKey,
                )?.turn;
                const turn = workTurn ?? feedbackTurn ?? nativeTurnFor(current, 'assessment');
                assert.equal(turn?.status, 'attempted');
                assert.equal(turn?.message, params.message);
                fixtureState.onSend?.();
                if (fixtureState.multiple)
                  fixtureState.messages = histories.get(String(params.sessionKey))!.messages;
                if (fixtureState.acceptSend) {
                  fixtureState.active = true;
                  fixtureState.inputReceipts = fixtureState.consumeSend
                    ? []
                    : [{ runId: params.idempotencyKey, state: 'pending', queued: true }];
                  fixtureState.messages = [
                    ...fixtureState.messages,
                    {
                      role: 'user',
                      content: params.message,
                      idempotencyKey: `${params.idempotencyKey}:user`,
                      __openclaw: {
                        id:
                          feedbackTurn ||
                          fixtureState.messages.some(
                            (entry) =>
                              (entry.__openclaw as Record<string, unknown>)?.id === 'input-event',
                          )
                            ? `${params.idempotencyKey}:input`
                            : 'input-event',
                        idempotencyKey: `${params.idempotencyKey}:user`,
                      },
                    },
                  ];
                }
                if (fixtureState.multiple)
                  histories.set(String(params.sessionKey), {
                    active: fixtureState.active,
                    messages: fixtureState.messages,
                    inputReceipts: fixtureState.inputReceipts,
                  });
                await fixtureState.afterSend?.();
                if (fixtureState.loseSend) throw new Error('SECRET lost response');
                return { runId: params.idempotencyKey, status: 'started' };
              }
              if (method === 'agent.wait') {
                assert.equal(params.timeoutMs, 0);
                return { runId: params.runId, ...fixtureState.waitResult };
              }
              if (fixtureState.historyRejected)
                throw new GatewayClientRequestError({
                  code: 'INVALID_REQUEST',
                  message: 'private-token',
                });
              if (params.sessionId !== undefined && params.messageId === undefined)
                throw new Error('sessionId requires messageId');
              const helper = fixtureState.foreignSessions.find(
                (row) => row.key === params.sessionKey,
              );
              const saved = helper
                ? { messages: [], inputReceipts: [], active: helper.active === true }
                : fixtureState.multiple
                  ? histories.get(String(params.sessionKey))!
                  : {
                      messages: fixtureState.messages,
                      inputReceipts: fixtureState.inputReceipts,
                      active: fixtureState.active,
                    };
              const currentMessages = saved.messages;
              const currentReceipts = saved.inputReceipts;
              const available = [...fixtureState.anchoredMessages, ...currentMessages];
              const anchor = available.findIndex(
                (entry) => (entry.__openclaw as Record<string, unknown>)?.id === params.messageId,
              );
              if (method === 'chat.message.get')
                return anchor < 0
                  ? { ok: false, unavailableReason: 'not_found' }
                  : { ok: true, message: available[anchor] };
              assert.equal(method, 'chat.history');
              return {
                sessionId:
                  fixtureState.historySessionId ??
                  helper?.sessionId ??
                  (fixtureState.multiple
                    ? sessions.get(String(params.sessionKey))?.sessionId
                    : fixtureState.session?.sessionId),
                messages: params.messageId
                  ? params.limit !== 1 && anchor >= 0
                    ? available.slice(Math.max(0, anchor - 1), anchor + Number(params.limit ?? 50))
                    : available.filter(
                        (entry) =>
                          (entry.__openclaw as Record<string, unknown>)?.id === params.messageId,
                      )
                  : params.limit === 1
                    ? currentMessages.slice(-1)
                    : currentMessages,
                inputReceipts: currentReceipts,
                pendingInputs: {
                  items: [
                    ...fixtureState.terminalInputs,
                    ...currentReceipts
                      .filter((entry) => entry.state === 'pending')
                      .map((entry) => ({ id: entry.runId, state: 'queued' })),
                  ],
                  total:
                    fixtureState.terminalInputs.length +
                    currentReceipts.filter((entry) => entry.state === 'pending').length,
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
    await rm(fixtureState.root, { recursive: true, force: true });
  });
  fixtureState.reportRun = 0;
  async function acknowledgeReport() {
    const result = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...coordinator, runId: 'report-' + ++fixtureState.reportRun },
      { action: 'report' },
    );
    assert.equal(result.status, 'reported');
  }
  async function next() {
    const value = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      coordinator,
      { action: 'next' },
    );
    assert.equal(value.status, 'routing-required');
    assert.ok(
      'id' in value &&
        'digest' in value &&
        typeof value.id === 'string' &&
        typeof value.digest === 'string',
    );
    return value;
  }
  function prepare(
    input: { id: string; digest: string },
    authority = {},
    title = 'repair the result',
  ) {
    return fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      coordinator,
      {
        action: 'prepare',
        id: input.id,
        digest: input.digest,
        title,
        assessment: { complexity: 'medium', reason: 'Interacting concerns.' },
      },
      false,
      authority,
    );
  }
  async function record(key?: string) {
    const records = (
      await (
        await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
      ).journal.read()
    ).records;
    return (key ? records.find((record) => record.threadId === key) : records[0])!;
  }
  const creates = () => fixtureState.calls.filter(({ method }) => method === 'sessions.create');
  function enableClaims(mode: 'local' | 'swarm' = 'swarm') {
    fixtureState.manifest.github!.notifications!.routing = [{ 'owner/*': mode }];
    const comments: GitHubCanonicalIssueComment[] = [];
    const client: ClaimClient = {
      async verify() {},
      async list() {
        return structuredClone(comments);
      },
      async create(source, body) {
        comments.push({
          databaseId: 1,
          nodeId: 'claim',
          body,
          bodyTruncated: false,
          author: { nodeId: source.receivingNodeId, login: 'receiver', type: 'User' },
          createdAt: new Date(baseline).toISOString(),
          updatedAt: new Date(baseline).toISOString(),
        });
        return 1;
      },
      async update(_source, id, previous, body) {
        assert.equal((await record()).sessionCreation?.verified, true);
        assert.equal(comments[0]!.databaseId, id);
        assert.equal(comments[0]!.body, previous);
        comments[0]!.body = body;
      },
      async remove() {
        throw new Error('unexpected-own-claim-removal');
      },
    };
    fixtureState.service.dependencies.claimStore = new AssignmentClaimStore(
      join(fixtureState.root, 'instance'),
    );
    fixtureState.service.dependencies.claims = new OpenClawAssignmentClaims(
      fixtureState.service.dependencies.claimStore,
      () => client,
    );
    return comments;
  }
  async function assignments(count: number, limit: number) {
    fixtureState.multiple = true;
    fixtureState.manifest.github!.notifications!.maxConcurrentItems = limit;
    const items = Array.from({ length: count }, (_, index) => ({
      ...fixtureState.fixture.item,
      nodeId: index ? `I_issue_${index}` : fixtureState.fixture.item.nodeId,
      databaseId: 20 + index,
      number: 3 + index,
    }));
    const events = items.map((_, index) => ({
      ...fixtureState.fixture.events[0]!,
      nodeId: index ? `E_assignment_${index}` : fixtureState.fixture.events[0]!.nodeId,
      databaseId: 30 + index,
      createdAt: new Date(baseline + 60000 + index * 1000).toISOString(),
    }));
    fixtureState.fixture.client.discoverAssigned = async () => ({
      candidates: items
        .toReversed()
        .map((item) => ({ ...item, repositoryPath: '/repos/owner/repo' })),
      incomplete: false,
      totalCount: items.length,
      truncated: false,
    });
    fixtureState.fixture.client.getItem = async (_owner, _name, number) =>
      items.find((item) => item.number === number)!;
    fixtureState.fixture.client.listAssignmentEvents = async (_owner, _name, number) => ({
      events: [events[number - 3]!],
      truncated: false,
    });
    // both consumers share this injected provider, including live assignment reauthorization.
    fixtureState.service.dependencies.connect = async () => ({
      ...fixtureState.fixture.client,
      getItemContext: async () => ({
        title: 'Repair',
        body: 'Return result.',
        comments: [],
        labels: [],
        truncated: false,
      }),
    });
    const intake = fixtureState.fixtureIntake;
    intake.dependencies.now = () => baseline;
    await intake.run(fixtureState.manifest, fixtureState.root, 'activate');
    intake.dependencies.now = () => baseline + 120000;
    await intake.run(
      fixtureState.manifest,
      fixtureState.root,
      'scan',
      (await intake.select(fixtureState.manifest, fixtureState.root)).selected!.digest,
    );
    return { items, events };
  }
  async function completeAssessment(id: string) {
    assert.equal((await context(id)).status, 'verified');
    assert.equal((await renderAssessment(id)).status, 'formatted');
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
  }
  const sends = () => fixtureState.calls.filter(({ method }) => method === 'chat.send');
  function sendAssessment(id: string, authority = {}) {
    return fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      coordinator,
      { action: 'assess', id },
      false,
      authority,
    );
  }
  async function finish(id: string) {
    const runId = `${id}:assessment`;
    fixtureState.active = false;
    fixtureState.inputReceipts = [];
    fixtureState.messages.push({
      role: 'assistant',
      stopReason: 'stop',
      __openclaw: { id: 'reply-event', runId, mirrorOrigin: 'codex-app-server', runTerminal: true },
      content: [{ type: 'text', text: 'The requested fix belongs in handler.ts:20.' }],
    });
    return fixtureState.service.run(fixtureState.manifest, fixtureState.root, coordinator, {
      action: 'reconcile',
      id,
    });
  }
  const plan: AssessmentSubmission = {
    outcome: 'plan-ready',
    summary: 'Restore the missing result.',
    reviewSummary: 'Restore the missing result.',
  };
  const assess = (id: string) =>
    fixtureState.service.run(fixtureState.manifest, fixtureState.root, coordinator, {
      action: 'assess',
      id,
    });
  const assessor = (id: string, runId = `${id}:assessment`): DispatchCaller => ({
    sessionKey: `agent:receiver:dashboard:agent-system-issue-${id}`,
    sessionId: fixtureState.multiple ? `ordinary-${id}` : 'ordinary-id',
    runId,
    toolCallId: 'assessment-tool',
  });
  const context = (id: string, who = assessor(id)) => {
    // An invocation in the issue turn follows native consumption of its queued input.
    const history = fixtureState.multiple
      ? histories.get(who.sessionKey)!
      : { messages: fixtureState.messages, inputReceipts: fixtureState.inputReceipts };
    const message = history.messages.find(
      (entry) =>
        (entry.__openclaw as Record<string, unknown>)?.idempotencyKey === `${who.runId}:user`,
    );
    const eventId = (message?.__openclaw as Record<string, unknown> | undefined)?.id;
    if (eventId)
      for (const receipt of history.inputReceipts) {
        if (receipt.runId === who.runId && receipt.state === 'pending') {
          receipt.state = 'consumed';
          receipt.consumedByEventId = eventId;
          delete receipt.queued;
        }
      }
    return fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, {
      action: 'context',
      id,
    });
  };
  const renderAssessment = async (
    id: string,
    result: AssessmentSubmission = plan,
    who = assessor(id),
  ) =>
    fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, {
      action: 'assessment',
      operation: 'render',
      result,
    });
  function assessmentReply(id: string) {
    fixtureState.active = false;
    fixtureState.inputReceipts = [];
    fixtureState.messages.push({
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
  async function readyWork(
    mode: 'plan' | 'work' | 'auto',
    decision?: 'plan' | 'work',
    assessment = plan,
  ) {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    await renderAssessment(
      input.id,
      decision
        ? {
            ...assessment,
            decision: { mode: decision, reasons: ['Bounded work.'] },
          }
        : assessment,
    );
    assessmentReply(input.id);
    assert.equal((await assess(input.id)).status, 'assessment-completed');
    fixtureState.manifest.github!.notifications!.issueAssignment!.mode = mode;
    return input.id;
  }
  const workPass = (runId: string) =>
    fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...coordinator, runId },
      { action: 'next' },
    );
  async function operatorFollowup(owner = true) {
    const input = await next();
    await prepare(input);
    await assess(input.id);
    await context(input.id);
    await renderAssessment(input.id);
    assessmentReply(input.id);
    fixtureState.messages.push({
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
    const { journal } = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.manifestDigest = automationHash({
        policy: originalIntakeDigest(fixtureState.manifest),
        models: fixtureState.manifest.models,
      });
      await save();
    });
    const before = await record();
    fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    return { ...setup, before };
  }
  async function publishedFollowup(onInspect: () => Promise<void> = async () => {}) {
    const { id, who } = await operatorFollowup();
    const request = { action: 'handoff' as const, id, permission: 'publication' as const };
    const preview = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      who,
      request,
      true,
    );
    assert.ok('digest' in preview && typeof preview.digest === 'string');
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      who,
      { ...request, digest: preview.digest },
      true,
    );
    const { journal, admitted } = await fixtureState.service.scope(
      fixtureState.manifest,
      fixtureState.root,
    );
    const retained = await record();
    const intake = admitted.records.find((entry) => entry.id === retained.intakeId)!;
    const head = 'a'.repeat(40);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.delivery = {
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
        },
      };
      await save();
    });
    const effects: string[][] = [];
    fixtureState.service.dependencies.delivery = async () => {
      throw new Error('presentation must not connect to github or git');
    };
    const use = fixtureState.service.dependencies.credential.use;
    fixtureState.service.dependencies.credential.use = async (authority, callback) =>
      use(authority, async (request) =>
        callback(async (...args) => {
          if (args[0] === 'sessions.describe') await onInspect();
          return request(...args);
        }),
      );
    const present = (authority = {}) =>
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        who,
        { action: 'delivery', operation: 'present', id },
        true,
        authority,
      );
    return { id, who, journal, present, effects };
  }
  async function feedbackOwner(implementation = true, discover = true) {
    if (!implementation) {
      fixtureState.manifest.github!.notifications!.issueAssignment!.feedback = {
        inherit: true,
        allowed: [],
      };
      await fixtureState.service.dependencies.intake.run(
        fixtureState.manifest,
        fixtureState.root,
        'activate',
      );
    }
    const { id, who } = await operatorFollowup();
    if (implementation) {
      const handoff = {
        action: 'handoff' as const,
        id,
        permission: 'implementation-and-publication' as const,
      };
      const preview = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        who,
        handoff,
        true,
      );
      assert.ok('digest' in preview);
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        who,
        { ...handoff, digest: preview.digest },
        true,
      );
    }
    const oldDigest = (await record()).manifestDigest;
    fixtureState.manifest.github!.notifications!.issueAssignment!.feedback = {
      inherit: true,
      allowed: [],
    };
    await fixtureState.service.dependencies.intake.run(
      fixtureState.manifest,
      fixtureState.root,
      'activate',
    );
    const comments: Array<GitHubCanonicalIssueComment> = [];
    fixtureState.service.dependencies.feedbackConnect = async () => ({
      ...fixtureState.fixture.client,
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
    if (implementation)
      await fixtureState.service.run(fixtureState.manifest, fixtureState.root, coordinator, {
        action: 'next',
      });
    assert.equal((await record()).manifestDigest, oldDigest);
    comments.push({
      nodeId: 'C_feedback',
      databaseId: 99,
      author: fixtureState.fixture.client.identity,
      body: '@receiver explain this',
      bodyTruncated: false,
      createdAt: '2026-10-07T10:03:00Z',
      updatedAt: '2026-10-07T10:03:00Z',
    });
    // feedback arrives on a later native occurrence, after the assessment pass.
    coordinator.runId = 'feedback-run';
    if (implementation && discover)
      await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    return { id, who, comments };
  }
  return Object.assign(fixtureState, {
    sessions,
    histories,
    coordinator,
    child,
    creates,
    sends,
    plan,
    assess,
    assessor,
    context,
    renderAssessment,
    workPass,
    acknowledgeReport,
    next,
    prepare,
    record,
    enableClaims,
    assignments,
    completeAssessment,
    sendAssessment,
    finish,
    assessmentReply,
    readyWork,
    operatorFollowup,
    originalAssignment,
    publishedFollowup,
    feedbackOwner,
  });
}
