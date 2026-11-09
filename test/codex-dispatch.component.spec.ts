import codexDirectInput from '../agent/codex-direct-input.ts';
import { selectCodexTurnTask } from '../agent/codex-turn-task.ts';
import seedHistoricalAssessment from './legacy-assessment-fixture.ts';
import assessmentPresentation from '../agent/dispatch-presentation.ts';
import { dispatchAdmission } from '../agent/managed-issue.ts';
import { feedbackRevision } from '../agent/feedback-source.ts';
import workflowStatus from '../agent/workflow-status.ts';
import hydrateImplementation from './implementation-material-fixture.ts';
import {
  fixturePullRequest,
  baseline,
  intakeFixture,
  removeFixtureAssignment,
} from './github-intake-fixture.ts';
import reconcileCodexLifecycle from '../agent/codex-assignment-lifecycle.ts';
import cleanupConfiguration from '../agent/cleanup-configuration.ts';
import CodexAssignmentClaims, { codexInstanceStore } from '../agent/codex-assignment-claims.ts';
import connectCodexGitHubAccount from '../agent/codex-github-client.ts';
import OpenClawAssignmentClaims from '../agent/openclaw-assignment-claims.ts';
import AssignmentClaimStore from '../agent/assignment-claim-store.ts';
import type { ClaimClient } from '../agent/assignment-claim.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import pendingPublicResponse from '../agent/pending-public-response.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import codexLiveTurn from '../agent/codex-live-turn.ts';
import codexImplementationEntry from '../agent/codex-implementation-entry.ts';
import codexContinuationNative from '../agent/codex-continuation-native.ts';
import runCodexContinuation, {
  type CodexContinuationDependencies,
} from '../agent/codex-continuation.ts';
import { automationHash } from '../agent/automation-hash.ts';
import { codexItemOccupied } from '../agent/codex-capacity.ts';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import properLockfile from 'proper-lockfile';

import { runCodexDispatch, type CodexDispatchDependencies } from '../agent/codex-dispatch.ts';
import type { DispatchNativeThread } from '../agent/codex-dispatch-native.ts';
import CodexDispatchStore, { type DispatchRecord } from '../agent/codex-dispatch-state.ts';
import runCodexFeedback from '../agent/codex-feedback.ts';
import runCodexDelivery from '../agent/codex-delivery.ts';
import { runCodexIntake, selectCodexIntake } from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { githubNotificationMarkdownCode } from '../channels/github/presentation/card.ts';

import { RepositoryPreparationError } from '../tools/git/repository-service.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';

const models = {
  default: { model: 'openai/gpt-6-astra', effort: 'high' },
  low: { model: 'openai/gpt-6-luna', effort: 'medium' },
  medium: { model: 'openai/gpt-6.1-sol', effort: 'high' },
  high: { model: 'openai/gpt-6-astra', effort: 'high' },
};
const manifest = {
  'schema-version': 1,
  agent: { id: 'receiver' },
  models,
  github: {
    username: 'receiver',
    'schema-version': 3,
    'max-concurrent-items': 2,
    runtimes: ['codex'],
    routing: ['owner/*'],
    'issue-assignment': {
      mode: 'plan',
      allowed: [{ login: 'receiver', 'node-id': 'U_receiver' }],
    },
  },
};
const result = {
  version: 1,
  outcome: 'plan-ready',
  summary: 'Repair the contained behavior.',
  fullAssessment: 'Complete private assessment, evidence and plan.',
  assessment: 'The user needs a reliable result.',
  planSummary: 'Repair the owner and cover the missing case.',
  plan: 'Update the owner and test its public boundary.',
  evidence: [
    { source: 'repo/file.ts', status: 'observed', detail: 'The current owner omits this case.' },
  ],
  progress: { completed: ['Inspected the owner.'], remaining: ['Implement after authorization.'] },
};

describe('agent/codex-dispatch', () => {
  let root: string, workspace: string, pluginData: string, codexHome: string;
  let source: string, worktree: string, commonDir: string, now: number;
  let fixture: ReturnType<typeof intakeFixture>, deps: CodexDispatchDependencies;
  let native: DispatchNativeThread | undefined;
  let projects: unknown[];
  let gitCalls: string[][];
  const commit = '1'.repeat(40);
  const request = async (
    action: string,
    input: unknown = {},
    overrides: CodexDispatchDependencies = {},
  ) =>
    (await runCodexDispatch(pluginData, action, input, { ...deps, ...overrides })) as Record<
      string,
      unknown
    >;
  const readDispatchState = async (): Promise<Record<string, unknown>> => {
    const current = await selectCodexIntake(pluginData, deps);
    return new CodexDispatchStore(current.store.location.root, current.store.location.scope).read();
  };
  const historicalResult = async (
    _action: string,
    input: Record<string, unknown>,
    overrides: CodexDispatchDependencies = {},
  ): Promise<Record<string, unknown>> => {
    const formatted = await request('result', input, overrides);
    const source = input.result as typeof result & {
      decision?: { mode: 'plan' | 'work'; reasons: string[] };
    };
    if (source.outcome !== 'plan-ready') return { ...formatted, status: 'native' };
    const selected = await selectCodexIntake(pluginData, deps);
    return new CodexDispatchStore(pluginData, selected.store.location.scope).exclusive(
      async (state, save) => {
        const record = state.records.find((r) => r.id === input.id)!;
        const intake = dispatchAdmission(record, (await selected.store.read())!.records)!;
        seedHistoricalAssessment({
          record,
          intake,
          threadId: record.threadId!,
          turnId: native!.turnId!,
          worktree: record.worktree!,
          policy: selected.manifest.github?.notifications,
          result: source,
          previousResultDigest: input.previousResultDigest as string | undefined,
        });
        await save();
        return {
          status: 'recorded',
          id: record.id,
          outcome: source.outcome,
          previousResultDigest: automationHash(source),
          presentation: assessmentPresentation(record.result!, record, intake, selected.workspace, {
            debug: selected.manifest.debug,
            workflow: selected.manifest.github?.notifications?.issueAssignment,
          }),
        };
      },
      true,
    );
  };
  const next = () => request('next', { projects });
  const writeCleanup = (graceMinutes: number) =>
    writeFile(
      join(root, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          entries: {
            'agent-system': { config: { cleanup: { graceMinutes } } },
          },
        },
      }),
    );
  const report = () =>
    request('report', {
      automationId: 'native-intake',
      currentTimeIso: new Date(now).toISOString(),
    });
  async function prepare(title = 'repair contained behavior') {
    const selected = await next();
    assert.equal(selected.status, 'routing-required', JSON.stringify(selected));
    const prepared = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title,
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal(prepared.status, 'prepared');
    return prepared;
  }
  function created() {
    native = {
      id: 'issue-thread',
      cwd: worktree,
      name: '#3: REPAIR CONTAINED BEHAVIOR',
      model: 'gpt-6.1-sol',
      effort: 'high',
      status: 'active',
      turnStatus: 'inProgress',
      turnId: 'first-turn',
    };
  }
  function operatorLaunch() {
    deps.threadId = 'operator';
    deps.replyConnection = async () => ({
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
                  id: 'operator-input',
                  content: 'Launch separate work continuing PR 7.',
                },
              },
            ],
          };
        throw new Error('unexpected method: ' + method);
      },
    });
  }
  function selectedPullRequest() {
    const observed = {
      nodeId: 'PR_7',
      number: 7,
      state: 'open',
      repositoryId: 'R_repo',
      headRepositoryId: 'R_repo',
      head: commit,
      branch: 'collaborator-work',
      base: 'release',
      authorId: 'U_collaborator',
      title: 'Existing work',
      body: 'Preserve this body.',
    };
    deps.deliveryConnect = async () => ({
      client: await deps.connect!(workspace, new AbortController().signal),
      account: {
        identity: fixture.client.identity,
        execute: async (argv) => {
          const value = argv.includes('repos/owner/repo/pulls/7')
            ? observed
            : {
                databaseId: fixture.item.databaseId,
                nodeId: fixture.item.nodeId,
                number: fixture.item.number,
                title: 'Issue',
              };
          return {
            exitCode: 0,
            stdout: 'HTTP/2 200 OK\n\n' + JSON.stringify(value),
            stderr: '',
            timedOut: false,
            truncated: false,
          };
        },
      },
    });
    return observed;
  }
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex_dispatch-')));
    [workspace, pluginData, codexHome, source, worktree, commonDir] = (
      ['workspace', 'plugin', 'codex', 'source', 'worktree', 'common'] as const
    ).map((name) => join(root, name)) as [string, string, string, string, string, string];
    for (const path of [workspace, codexHome, source, worktree, commonDir]) await mkdir(path);
    await writeFile(join(root, 'openclaw.json'), '{}');
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    await bindCodexWorkspace(pluginData, workspace);
    fixture = intakeFixture();
    now = baseline;
    await runCodexIntake(pluginData, true, {
      codexHome,
      now: () => now,
      connect: async () => fixture.client,
    });
    now += 60000;
    await runCodexIntake(pluginData, false, {
      codexHome,
      assertActive: async () => {},
      now: () => now,
      connect: async () => fixture.client,
    });
    native = undefined;
    projects = [
      {
        projectId: 'saved-project',
        path: source,
        projectKind: 'local',
        hostId: 'local',
        isGitRepository: true,
      },
    ];
    gitCalls = [];
    const branches = new Map<string, string>();
    deps = {
      readCleanupConfiguration: () =>
        cleanupConfiguration({ env: { OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json') } }),
      codexHome,
      assertActive: async () => {},
      now: () => now,
      feedbackConnect: async () =>
        ({
          client: fixture.client,
          comments: {
            identity: fixture.client.identity,
            listIssueComments: async () => ({ comments: [], truncated: false }),
            getIssueComment: async () => {
              throw new Error('no feedback source');
            },
            createIssueComment: async () => {
              throw new Error('no public reply expected');
            },
            findOwnIssueComment: async () => undefined,
          },
        }) as unknown as Awaited<
          ReturnType<NonNullable<CodexDispatchDependencies['feedbackConnect']>>
        >,
      threadId: 'intake-thread',
      activation: async () => ({ sourceThreadId: 'intake-thread' }),
      prepareRepository: async (_input, dependencies) => {
        await dependencies.authorize();
        await dependencies.retain({
          path: source,
          source: 'https://github.com/owner/repo.git',
          identity: 'github.com/owner/repo',
          checkout: source,
        });
        return source;
      },
      connect: async () =>
        Object.assign({}, fixture.client, {
          async getItemContext() {
            return {
              title: 'Repair contained behavior',
              body: 'The acceptance criteria require a safe plan.',
              comments: [],
              labels: [],
              truncated: false,
              routingMetadata: {
                complexity: {
                  status: 'verified' as const,
                  source: 'native' as const,
                  value: 'medium' as const,
                },
                workSize: { status: 'verified' as const, source: 'native' as const, value: 8 },
              },
            };
          },
        }),
      git: async (_cwd, argv) => {
        gitCalls.push(argv);
        if (argv[0] === 'branch') return branches.get(_cwd) ?? '';
        if (argv[0] === 'switch') {
          branches.set(_cwd, argv[1] === '-c' ? argv[2]! : argv[1]!);
          return '';
        }
        if (argv.length === 1 && argv[0] === 'remote') return 'origin';
        if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
        if (argv.includes('--git-common-dir')) return commonDir;
        if (argv.includes('--is-bare-repository')) return 'false';
        if (argv.includes('--show-toplevel')) return _cwd;
        if (argv[0] === 'rev-parse') return commit;
        return '';
      },
      native: {
        intakeDenial: async () => undefined,
        intakeBoundary: async () => 'routing-command',
        async unsubmittedCreation() {
          return undefined;
        },
        async operatorInput(threadId) {
          return {
            turnId: threadId === native?.id ? native.turnId! : 'operator-' + now,
            inputId: 'operator-input',
          };
        },
        async occurrence(threadId) {
          assert.ok(
            !['operator', 'issue-thread'].includes(threadId),
            'manual callers must not require a heartbeat',
          );
          return {
            id: 'run-' + now,
            automationId: 'native-intake',
            currentTimeIso: new Date(now).toISOString(),
          };
        },
        async assessmentSkill(_cwd, id) {
          return { name: id, path: join(root, 'SKILL.md'), scope: 'user', digest: 'a'.repeat(64) };
        },
        async rename(threadId, title) {
          assert.equal(threadId, native?.id);
          native!.name = title;
        },
        async deniedCreation() {
          return { turnId: 'denied-turn', callId: 'denied-call' };
        },
        async find(input) {
          if (input.threadId && input.threadId !== native?.id)
            throw new Error('dispatch-native-readback-diverged');
          return native;
        },
      },
    };
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should recover initial managed assessment without requiring a direct user message', async () => {
    await writeFile(join(root, 'SKILL.md'), '# assessment fixture');
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id });
    const output = await request(
      'assessment',
      {
        action: 'assessment',
        operation: 'context',
        target: 'https://github.com/owner/repo/issues/3',
        path: worktree,
      },
      {
        threadId: native!.id,
        replyConnection: async () => ({
          close: async () => {},
          request: async (method) => {
            if (method === 'skills/list')
              return {
                data: [
                  {
                    cwd: workspace,
                    errors: [],
                    skills: [
                      {
                        name: 'agent-system:agent-system-task-assessment',
                        path: join(root, 'SKILL.md'),
                        scope: 'user',
                        enabled: true,
                      },
                    ],
                  },
                ],
              };
            throw new Error('must not require direct input: ' + method);
          },
        }),
      },
    );
    assert.equal(output.status, 'native');
    assert.equal((output.project as { path: string }).path, worktree);
    assert.ok(output.presentationRequest);
  });

  it('should launch explicit collaborator work from the selected pr head without replacing the intake task', async () => {
    const original = await prepare();
    created();
    await request('reconcile', { id: original.id });
    operatorLaunch();
    selectedPullRequest();
    const target = 'owner/repo#3';
    await request('launch', {
      operation: 'context',
      target,
      fresh: true,
      pullRequest: 'https://github.com/owner/repo/pull/7',
    });
    const project = await request('launch', {
      operation: 'prepare',
      target,
      fresh: true,
      projects,
    });
    assert.equal(project.status, 'routing-required', JSON.stringify(project));
    const prepared = await request('launch', {
      operation: 'prepare',
      target,
      fresh: true,
      assessment: { complexity: 'medium', reason: 'Collaborate on existing work.' },
      title: 'COLLABORATE',
    });
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    const creation = prepared.request as {
      target: { environment: { startingState: { branchName: string } } };
    };
    assert.equal(creation.target.environment.startingState.branchName, commit);
    const selected = await selectCodexIntake(pluginData, deps);
    const records = (await new CodexDispatchStore(pluginData, selected.store.location.scope).read())
      .records;
    assert.equal(records.length, 2);
    assert.equal(records[0]!.supersededBy, undefined);
    assert.equal(records[1]!.adoptedPullRequest?.branch, 'collaborator-work');
    assert.equal(records[1]!.delivery, undefined);
    assert.ok(
      gitCalls.some((argv) =>
        argv.includes('refs/heads/collaborator-work:refs/remotes/origin/collaborator-work'),
      ),
    );
    const originalNative = native!;
    const parallelPath = join(root, 'parallel-worktree');
    await mkdir(parallelPath);
    const parallel = { ...originalNative, id: 'parallel-thread', cwd: parallelPath };
    deps.native!.find = async (input) =>
      input.sourceThreadId === 'intake-thread' ? originalNative : parallel;
    for (let retry = 0; retry < 2; retry++) {
      const recovered = await request('launch', { operation: 'reconcile', target, fresh: true });
      assert.equal(recovered.destination, parallel.id);
    }
    const intake = await request('next', { projects }, { threadId: 'intake-thread' });
    assert.ok(!['prepared', 'routing-required'].includes(String(intake.status)));
    assert.equal(
      (await new CodexDispatchStore(pluginData, selected.store.location.scope).read()).records
        .length,
      2,
    );
  });

  it('should preview replacement preserve predecessor evidence and converge on one fenced successor', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id });
    await request('context', { id: prepared.id }, { threadId: native!.id });
    await historicalResult('result', { id: prepared.id, result }, { threadId: native!.id });
    const observed = selectedPullRequest();
    const selected = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(pluginData, selected.store.location.scope);
    const input = { id: prepared.id, pullRequest: 'https://github.com/owner/repo/pull/7' };
    await assert.rejects(
      request('recover', input, { threadId: 'operator' }),
      /chat-active-or-unverified/,
    );
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    native!.turnEnded = true;
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      const attempt = {
        id: 'a'.repeat(64),
        sourceTurnId: 'old',
        beforeTurnId: 'old',
        request: { threadId: record.threadId!, prompt: 'Old recovery.' },
      };
      record.summaryRecovery = { revision: 1, attempt };
      record.autoDecision = { attempt };
      record.continuation = {
        phase: 'delivery',
        policyDigest: 'a'.repeat(64),
        selection: record.assessment!,
      };
      await save();
    });
    const unfinished = await request('recover', input, { threadId: 'operator' });
    assert.equal(unfinished.status, 'blocked');
    assert.deepEqual(unfinished.blockers, ['pendingSummaryTurn', 'pendingAutoDecision']);
    await store.exclusive(async (state, save) => {
      state.records[0]!.implementationDelivered = true;
      state.records[0]!.summaryRecovery!.ended = true;
      state.records[0]!.autoDecision!.ended = true;
      await save();
    });
    const before = await store.read();
    const preview = await request('recover', input, { threadId: 'operator' });
    assert.equal(preview.status, 'recovery-available');
    assert.deepEqual(await store.read(), before);
    observed.head = '2'.repeat(40);
    await assert.rejects(
      request('recover', { ...input, digest: preview.digest }, { threadId: 'operator' }),
      /recovery-stale/,
    );
    assert.deepEqual(await store.read(), before);
    observed.head = commit;
    await store.exclusive(async (state, save) => {
      state.records[0]!.denial = {
        sourceThreadId: 'intake-thread',
        turnId: 'denied-turn',
        callId: 'denied-call',
        operation: 'prepare',
        automatic: true,
        observedAt: now,
      };
      await save();
    });
    const held = await request('recover', input, { threadId: 'operator' });
    assert.equal(held.status, 'blocked');
    assert.ok((held.blockers as string[]).includes('nativeDenial'));
    assert.equal((await store.read()).records.length, 1);
    assert.ok((await store.read()).records[0]!.denial);
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.denial;
      await save();
    });
    await assert.rejects(
      request('recover', input, { threadId: native!.id }),
      /operator-caller-required/,
    );
    const applied = await request('recover', { ...input, apply: true }, { threadId: 'operator' });
    assert.equal(applied.status, 'recovery-ready');
    const after = await store.read();
    assert.equal(after.records.length, 2);
    const old = after.records[0]!,
      successor = after.records[1]!;
    assert.deepEqual(old, {
      ...before.records[0],
      supersededBy: successor.id,
      recovery: old.recovery,
    });
    assert.equal(old.recovery?.digest, preview.digest);
    assert.equal(old.recovery?.by, 'operator');
    assert.equal(successor.predecessorId, old.id);
    assert.equal(successor.manualIssue?.selections?.mode, undefined);
    assert.equal(successor.request, undefined);
    assert.equal(successor.result, undefined);
    assert.equal(successor.delivery, undefined);
    assert.equal(successor.adoptedPullRequest?.pullRequestNumber, 7);
    assert.equal(codexItemOccupied(old), false);
    assert.equal(
      (await request('recover', input, { threadId: 'operator' })).successorId,
      successor.id,
    );
    assert.equal((await store.read()).records.length, 2);
    await assert.rejects(
      request('context', { id: old.id }, { threadId: native!.id }),
      /task-superseded/,
    );
  });

  it('should inspect a selected saved owner without scanning or modifying state', async () => {
    const prepared = await prepare();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(pluginData, current.store.location.scope);
    const before = await store.read();
    deps.connect = async () => {
      throw new Error('unexpected provider read');
    };
    const result = await request('inspect', { target: 'owner/repo#3', limit: 1 });
    const records = result.records as Array<{
      id: string;
      lifecycleCheckedAt?: number;
      request?: unknown;
    }>;
    assert.equal(records.length, 1);
    assert.equal(records[0]!.id, prepared.id);
    assert.equal(records[0]!.lifecycleCheckedAt, before.records[0]!.lifecycleCheckedAt);
    assert.equal(records[0]!.request, undefined);
    assert.deepEqual(await store.read(), before);
    assert.deepEqual((await request('inspect', { target: 'other/repo#3' })).records, []);
  });
  it('should consume custom initial routing while verified complexity retains its tier', async () => {
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        models: { ...models, routing: { skill: 'company:route', guidance: 'Prefer cheap work.' } },
      }),
    );
    const selected = await next();
    const routing = selected.routing as {
      instructions: { requestedSkill: string; skill?: { name: string } };
    };
    assert.equal(routing.instructions.requestedSkill, 'company:route');
    assert.equal(routing.instructions.skill?.name, 'company:route');
    const prepared = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'low', reason: 'Custom content judgment.' },
    });
    assert.equal(prepared.status, 'prepared');
    assert.equal((prepared.request as { model: string }).model, 'gpt-6.1-sol');
    const saved = ((await readDispatchState()).records as Array<{ routingNote: string }>)[0]!;
    assert.match(saved.routingNote, /Routing method.*company:route.*custom guidance/);
    assert.match(saved.routingNote, /Effective settings.*Not independently verified/);
    assert.ok(!saved.routingNote.includes('Prefer cheap work.'));
  });

  it('should reject changed routing instructions before native creation', async () => {
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        models: { ...models, routing: { guidance: { file: 'routing.md' } } },
      }),
    );
    await writeFile(join(workspace, 'routing.md'), 'First instructions.');
    const selected = await next();
    await writeFile(join(workspace, 'routing.md'), 'Changed instructions.');
    const prepared = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Verified complexity.' },
    });
    assert.equal(prepared.code, 'model-routing-instructions-changed');
    assert.equal(prepared.request, undefined);
  });

  it('should stop initial routing when native skill discovery rejects the requested method', async () => {
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({ ...manifest, models: { ...models, routing: { skill: 'company:missing' } } }),
    );
    deps.native!.assessmentSkill = async () => {
      throw new Error('dispatch-assessment-skill-unavailable');
    };
    assert.equal((await next()).code, 'dispatch-assessment-skill-unavailable');
  });

  async function claiming(mode: 'local' | 'swarm' = 'swarm') {
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        github: { ...manifest.github, routing: [{ 'owner/*': mode }] },
      }),
    );
    const comments: GitHubCanonicalIssueComment[] = [];
    const client: ClaimClient = {
      verify: async () => {},
      list: async () => structuredClone(comments),
      async create(source, body) {
        const id = comments.length + 1;
        comments.push({
          databaseId: id,
          nodeId: 'C_' + id,
          body,
          bodyTruncated: false,
          author: { nodeId: source.receivingNodeId, login: 'receiver', type: 'User' },
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        });
        return id;
      },
      async update(_source, id, previous, body) {
        const comment = comments.find((comment) => comment.databaseId === id)!;
        assert.equal(comment.body, previous);
        comment.body = body;
      },
      async remove(_source, id) {
        comments.splice(
          comments.findIndex((comment) => comment.databaseId === id),
          1,
        );
      },
    };
    const store = codexInstanceStore(pluginData);
    deps.claims = new CodexAssignmentClaims(store, () => client);
    return { store, client, comments };
  }

  it('should reject malformed receipt ids without changing state and preserve lookup behavior', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    const before = await readDispatchState();
    await assert.rejects(
      request('context', { id: 'x'.repeat(100) }, child),
      /dispatch-receipt-id-invalid/,
    );
    await assert.rejects(
      request(
        'summary',
        {
          id: 'x'.repeat(100),
          operation: 'candidate',
          digest: 'a'.repeat(64),
          publicText: 'A concise public assessment summary.',
        },
        child,
      ),
      /dispatch-receipt-id-invalid/,
    );
    assert.deepEqual(await readDispatchState(), before);
    await assert.rejects(
      request('context', { id: 'a'.repeat(64) }, child),
      /dispatch-receipt-missing/,
    );
    assert.equal((await request('context', { id: prepared.id }, child)).status, 'verified');
  });

  it('should prepare and reconcile without claims or creating installation state', async () => {
    const { comments } = await claiming('local');
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    const prepared = await prepare();
    const prompt = (prepared.request as { prompt: string }).prompt;
    assert.ok(prompt.split('\n').every((line) => line.startsWith('>')));
    assert.ok(!prompt.includes(String(prepared.id)));
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    const records = (await readDispatchState()).records as Array<{
      claimId?: number;
      effective?: unknown;
    }>;
    assert.ok(records[0]!.effective);
    assert.equal(records[0]!.claimId, undefined);
    assert.equal(await codexInstanceStore(pluginData).inspect(), undefined);
    assert.equal(comments.length, 0);
  });

  it('should hold a pending swarm claim after switching its route to local', async () => {
    const { comments } = await claiming();
    assert.equal((await next()).status, 'claim-waiting');
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
    now += 300000;
    const held = await next();
    assert.equal(held.code, 'claim-disabled-pending');
    assert.equal(comments.length, 1);
    assert.deepEqual(gitCalls, []);
  });

  it('should enforce uuid eligibility through native preparation and retain accepted ownership after edits', async () => {
    const { store, comments } = await claiming();
    const identity = await store.identity();
    const other = '11111111-1111-4111-8111-111111111111';
    const route = async (target: string | string[]) =>
      writeFile(
        join(workspace, 'agent.yaml'),
        JSON.stringify({
          ...manifest,
          github: { ...manifest.github, routing: [{ 'owner/repo': target }, 'owner/*'] },
        }),
      );
    await route(other);
    const excluded = await next();
    assert.equal((excluded.claim as { code: string }).code, 'claim-route-instance-ineligible');
    assert.equal(comments.length, 0);
    assert.deepEqual(gitCalls, []);
    await route(identity.instanceId);
    now += 300000;
    assert.equal((await next()).status, 'claim-waiting');
    now += 300000;
    const selected = await next();
    assert.equal(selected.status, 'routing-required');
    await route([other]);
    const held = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal((held.claim as { code: string }).code, 'claim-route-owner-ineligible');
    assert.equal(native, undefined);
    await route([other, identity.instanceId]);
    now += 300000;
    const prepared = await prepare();
    await route(other);
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /Assignment accepted/u);
  });

  it('should prepare a first assignment with uncached compact reviewers', async () => {
    const updated = structuredClone(manifest);
    Object.assign(updated.github['issue-assignment'], { reviewers: ['@reviewer', 'U_second'] });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(updated));
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    const records = (await readDispatchState()).records as Array<{
      effective?: unknown;
      feedback?: { admission?: { enabled: boolean } };
    }>;
    assert.ok(records[0]!.effective);
    assert.equal(records[0]!.feedback?.admission?.enabled, true);
  });

  it('should uppercase the issue session title while preserving punctuation and unicode', async () => {
    const title = "Fix user's issue: café 東京 Straße 2026.10.6";
    const prepared = await prepare(title);
    const records = (await readDispatchState()).records as Array<{
      request?: { title?: string };
    }>;
    assert.equal(records[0]!.request?.title, "#3: FIX USER'S ISSUE: CAFÉ 東京 STRASSE 2026.10.6");
    assert.equal(prepared.status, 'prepared');
  });

  for (const [kind, title, expected] of [
    [
      'colon prefixes',
      'OWNER/REPO #3: #3: Fix café: references to #4',
      '#3: FIX CAFÉ: REFERENCES TO #4',
    ],
    [
      'mixed prefixes',
      'REPO #3 - OWNER/REPO #3 – #3 — #3 Fix café: references to #4',
      '#3: FIX CAFÉ: REFERENCES TO #4',
    ],
    ['whitespace prefixes', '#3 Fix login timeout', '#3: FIX LOGIN TIMEOUT'],
    ['repository words', 'REPO automation fixes', '#3: REPO AUTOMATION FIXES'],
    ['other issues', '#4 - Review REPO #3', '#3: #4 - REVIEW REPO #3'],
    ['other repositories', 'other/repo #3 — Fix café', '#3: OTHER/REPO #3 — FIX CAFÉ'],
    ['metadata only', 'REPO #3 — #3', '#3: ISSUE'],
  ])
    it(`should prepare a native chat title with ${kind}`, async () => {
      const prepared = await prepare(title);
      const records = (await readDispatchState()).records as Array<{
        request?: { title?: string };
      }>;
      assert.equal(prepared.status, 'prepared');
      assert.equal(records[0]!.request?.title, expected);
    });

  it('should hold a saved pilot claim without preparing work or changing its receipt', async () => {
    const { store, comments } = await claiming();
    assert.equal((await next()).status, 'claim-waiting');
    const before = await store.file.read();
    delete deps.claims;
    now += 300000;
    const held = await next();
    assert.equal(held.code, 'claim-disabled-pending');
    assert.deepEqual(gitCalls, []);
    assert.equal(await store.file.read(), before);
    assert.equal(comments.length, 1);
    assert.doesNotMatch(comments[0]!.body, /Assignment accepted/u);
  });

  it('should hold a selected pilot claim if claims are disabled before preparation', async () => {
    const { store } = await claiming();
    await next();
    now += 300000;
    const selected = await next();
    const before = await store.file.read();
    delete deps.claims;
    const held = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal(held.code, 'claim-disabled-pending');
    assert.equal(await store.file.read(), before);
    const records = (await readDispatchState()).records as Array<{ request?: unknown }>;
    assert.equal(records[0]!.request, undefined);
  });

  it('should recover existing native work without accepting its pilot claim while dormant', async () => {
    const { store, comments } = await claiming();
    await next();
    now += 300000;
    const prepared = await prepare();
    created();
    const before = await store.file.read();
    delete deps.claims;
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    const records = (await readDispatchState()).records as Array<{
      claimAccepted?: boolean;
      effective?: unknown;
    }>;
    assert.ok(records[0]!.effective);
    assert.equal(records[0]!.claimAccepted, undefined);
    assert.equal(await store.file.read(), before);
    assert.doesNotMatch(comments[0]!.body, /Assignment accepted/u);
  });

  it('should inherit native adapter capture and preserve signal versus timeout metadata', async () => {
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'gh'), '', { mode: 0o700 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = bin;
      for (const termination of ['signal', 'timeout', 'no-output-timeout'] as const) {
        const connection = await connectCodexGitHubAccount(
          workspace,
          new AbortController().signal,
          async (argv, options) => {
            for (const field of ['maxOutputBytes', 'maxCombinedOutputBytes', 'outputCapture'])
              assert.equal(Object.hasOwn(options, field), false);
            const identity = argv.includes('/user');
            return {
              code: identity ? 0 : null,
              stdout: identity ? JSON.stringify(fixture.client.identity) : 'tail',
              stderr: '',
              killed: !identity,
              signal: identity ? null : 'SIGTERM',
              termination: identity ? 'exit' : termination,
              ...(identity ? {} : { stdoutTruncatedBytes: 7 }),
            };
          },
        );
        const result = await connection.account.execute(['api', '/fixture']);
        assert.equal(result.termination, termination);
        assert.equal(result.signal, 'SIGTERM');
        assert.equal(result.timedOut, termination !== 'signal');
        assert.equal(result.stdoutTruncatedBytes, 7);
        assert.equal(result.truncated, true);
        assert.equal(result.stdout, 'tail');
      }
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it('should claim through the native github connection before preparing and accepting a verified chat', async () => {
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        github: { ...manifest.github, routing: [{ 'owner/*': 'swarm' }] },
      }),
    );
    const comments: Array<GitHubCanonicalIssueComment & { bodyLength: number; issueUrl: string }> =
      [];
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'gh'), '', { mode: 0o700 });
    const previousPath = process.env.PATH;
    let connection: Awaited<ReturnType<typeof connectCodexGitHubAccount>>;
    try {
      process.env.PATH = bin;
      connection = await connectCodexGitHubAccount(
        workspace,
        new AbortController().signal,
        async (argv, options) => {
          assert.equal(options.cwd, workspace);
          assert.deepEqual(options.env, { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' });
          assert.deepEqual(argv.slice(-2), ['--hostname', 'github.com']);
          const endpoint = argv.slice(1).find((arg) => arg.startsWith('/'));
          let value: unknown;
          if (argv.includes('graphql')) {
            const { id, ids } = JSON.parse(options.input).variables as {
              id?: string;
              ids?: string[];
            };
            const nodes = (ids ?? [id!]).map((nodeId) => {
              const identity = [fixture.repository.owner, fixture.client.identity].find(
                (entry) => entry.nodeId === nodeId,
              );
              assert.ok(identity, 'requested identity belongs to the fixture');
              return { id: identity.nodeId, login: identity.login, __typename: identity.type };
            });
            value = { data: ids ? { nodes } : { node: nodes[0] } };
          } else if (endpoint === '/user') value = fixture.client.identity;
          else if (endpoint === '/repos/owner/repo') value = fixture.repository;
          else if (endpoint === '/repos/owner/repo/issues/3') {
            value = {
              ...fixture.item,
              isPullRequest: false,
              title: 'Repair contained behavior',
              body: 'The acceptance criteria require a safe plan.',
              commentCount: comments.length,
              labels: [],
            };
          } else if (endpoint === '/repos/owner/repo/issues/3/events') value = fixture.events;
          else if (endpoint === '/repos/owner/repo/issues/3/issue-field-values?per_page=100')
            value = [
              { name: 'complexity', value: 'medium' },
              { name: 'work size', value: 8 },
            ];
          else if (endpoint === '/repos/owner/repo/issues/3/comments') {
            if (argv.includes('POST')) {
              const { body } = JSON.parse(options.input) as { body: string };
              const comment = {
                databaseId: comments.length + 1,
                nodeId: 'C_' + (comments.length + 1),
                author: fixture.client.identity,
                body,
                bodyTruncated: false,
                bodyLength: body.length,
                issueUrl: 'https://api.github.com/repos/owner/repo/issues/3',
                createdAt: new Date(now).toISOString(),
                updatedAt: new Date(now).toISOString(),
              };
              comments.push(comment);
              value = { ...comment, user: comment.author };
            } else
              value = comments.map((comment) => ({
                ...comment,
                authorLogin: comment.author!.login,
              }));
          } else if (endpoint === '/repos/owner/repo/issues/comments/1') {
            if (argv.includes('PATCH')) {
              comments[0]!.body = (JSON.parse(options.input) as { body: string }).body;
              comments[0]!.bodyLength = comments[0]!.body.length;
            }
            value = comments[0];
          } else throw new Error('unexpected native github request: ' + endpoint);
          return {
            code: 0,
            killed: false,
            signal: null,
            stdout: 'HTTP/2 200\n\n' + JSON.stringify(value),
            stderr: '',
            termination: 'exit',
          };
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    deps.connect = async () => connection.client;
    deps.claims = new CodexAssignmentClaims(codexInstanceStore(pluginData));
    await codexInstanceStore(pluginData).identity();
    const first = await next();
    assert.equal(first.status, 'claim-waiting', JSON.stringify(first));
    assert.equal((await next()).status, 'idle');
    assert.deepEqual(gitCalls, []);
    assert.equal(comments.length, 1);
    now += 300000;
    const prepared = await prepare();
    assert.doesNotMatch(comments[0]!.body, /Assignment accepted/u);
    const unresolved = await request('reconcile', { id: prepared.id });
    assert.equal(unresolved.code, 'dispatch-creation-unresolved');
    assert.doesNotMatch(comments[0]!.body, /Assignment accepted/u);
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    assert.match(comments[0]!.body, /Assignment accepted/u);
    const record = (await readDispatchState()).records as Array<{ claimAccepted: boolean }>;
    assert.equal(record[0]!.claimAccepted, true);
    assert.equal(comments.length, 1);
  });

  it('should leave a claim owned by openclaw without preparing any codex repository or chat', async () => {
    const { store, client, comments } = await claiming();
    const selected = await selectCodexIntake(pluginData, deps);
    const intake = (await selected.store.read())!.records[0]!;
    const other = new OpenClawAssignmentClaims(
      new AssignmentClaimStore(join(root, 'openclaw-instance')),
      () => client,
    );
    const eligibleInstanceIds = [
      (await store.identity()).instanceId,
      (await other.store.identity()).instanceId,
    ];
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        github: { ...manifest.github, routing: [{ 'owner/repo': eligibleInstanceIds }] },
      }),
    );
    const caller = {
      sessionKey: 'agent:receiver:main',
      sessionId: 'native-session',
      runId: 'first',
      toolCallId: 'tool-first',
    };
    await other.select({
      mode: 'swarm',
      eligibleInstanceIds: [...eligibleInstanceIds].reverse(),
      intake,
      client: fixture.client as never,
      caller,
      hasCapacity: true,
    });
    assert.equal((await next()).status, 'claim-waiting');
    now += 300000;
    const loser = await next();
    assert.equal((loser.claim as { status: string }).status, 'other-owner');
    assert.deepEqual(gitCalls, []);
    assert.equal(
      (
        await other.select({
          mode: 'swarm',
          eligibleInstanceIds: [...eligibleInstanceIds].reverse(),
          intake,
          client: fixture.client as never,
          caller: { ...caller, runId: 'second' },
          hasCapacity: true,
        })
      ).status,
      'owned',
    );
    assert.equal(comments.length, 1);
  });

  it('should stop preparation when the selected winner disappears', async () => {
    const { comments } = await claiming();
    await next();
    now += 300000;
    const selected = await next();
    assert.equal(selected.status, 'routing-required');
    comments.length = 0;
    const stopped = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair behavior',
      assessment: { complexity: 'medium', reason: 'Contained change.' },
    });
    assert.equal(stopped.code, 'claim-winner-missing');
    const records = (await readDispatchState()).records as Array<{ request?: unknown }>;
    assert.equal(records[0]!.request, undefined);
  });

  it('should release a blocked owner only after native terminal evidence and retain it on unreadable history', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records[0]!.phase = 'blocked';
      await save();
    });
    native!.status = 'notLoaded';
    native!.turnStatus = 'interrupted';
    await next();
    assert.equal(codexItemOccupied((await store.read()).records[0]!), true);
    native!.turnEnded = true;
    await next();
    assert.equal(codexItemOccupied((await store.read()).records[0]!), false);
    deps.native!.find = async () => {
      throw new Error('dispatch-host-unavailable');
    };
    await next();
    assert.equal(codexItemOccupied((await store.read()).records[0]!), true);
  });

  it('should retry a transient preparation failure only after its backoff', async () => {
    const original = deps.connect!;
    deps.connect = async (...args) => ({
      ...(await original(...args)),
      getItemContext: async () => {
        throw new Error('dispatch-host-unavailable');
      },
    });
    const failure = await next();
    assert.equal(failure.code, 'dispatch-host-unavailable');
    const selected = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(
      selected.store.location.root,
      selected.store.location.scope,
    );
    const retained = (await store.read()).records[0]!;
    assert.equal(retained.retry?.attempts, 1);
    assert.equal((await next()).status, 'idle');
    deps.connect = original;
    now = retained.retryAfter!;
    assert.equal((await next()).status, 'routing-required');
  });

  it('should reject an incomplete codex assessment before recording and compose its corrected source', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    await request('context', { id: prepared.id }, child);
    await assert.rejects(
      request(
        'result',
        { id: prepared.id, result: { ...result, fullAssessment: undefined } },
        child,
      ),
      /assessment-result-incomplete/,
    );
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const rejected = (await store.read()).records[0]!;
    assert.equal(rejected.result, undefined);
    assert.equal(rejected.assessmentRevision, undefined);
    assert.equal(rejected.stageReceipt, undefined);
    const complete = {
      ...result,
      fullAssessment: 'Complete source, evidence and actionable plan.',
    };
    assert.equal(
      (await historicalResult('result', { id: prepared.id, result: complete }, child)).status,
      'recorded',
    );
    const authority = {
      workflow: 'issue-assignment' as const,
      automationId: 'native-intake',
      sourceThreadId: 'intake-thread',
      policyDigest: automationHash(current.manifest.github!.notifications),
      definitionDigest: 'd'.repeat(64),
    };
    deps.activation = async () => ({
      sourceThreadId: 'intake-thread',
      schedule: {
        current: authority,
        saved: { ...authority, version: 1, capabilities: ['assessment-summary'] },
      },
    });
    deps.summaryAuthority = async () => {};
    const composed = await request('summary', { id: prepared.id, operation: 'compose' }, child);
    assert.equal(composed.status, 'composition-ready');
    assert.equal(composed.privateResponse, complete.fullAssessment);
  });

  it('should read an older incomplete codex assessment without inventing a pending publication', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    await request('context', { id: prepared.id }, child);
    await historicalResult('result', { id: prepared.id, result }, child);
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      const saved = state.records[0]!;
      delete saved.result!.fullAssessment;
      saved.stageReceipt!.resultDigest = automationHash(saved.result);
      await save();
    });
    const recovered = await request('present', { id: prepared.id }, child);
    assert.equal((recovered.previousResult as { plan: string }).plan, result.plan);
    assert.ok(String(recovered.presentation).includes(result.plan));
    const pending = pendingPublicResponse((await store.read()).records[0]!);
    assert.equal(pending, undefined);
  });

  for (const loseResponse of [false, true]) {
    it(`should retain one assessment summary in codex after ${loseResponse ? 'a lost response' : 'successful publication'}`, async () => {
      const prepared = await prepare();
      created();
      const child = { threadId: 'issue-thread' };
      await request('context', { id: prepared.id }, child);
      const privateResult = {
        ...result,
        plan: loseResponse ? result.plan : 'Retained summary evidence.\n'.repeat(1000),
        fullAssessment: loseResponse
          ? 'The complete private technical plan and its limits.'
          : 'Retained summary evidence.\n'.repeat(1000),
      };
      const recorded = await historicalResult(
        'result',
        { id: prepared.id, result: privateResult },
        child,
      );
      assert.ok(String(recorded.presentation).includes(privateResult.fullAssessment));
      const current = await selectCodexIntake(pluginData, deps);
      const authority = {
        workflow: 'issue-assignment' as const,
        automationId: 'native-intake',
        sourceThreadId: 'intake-thread',
        policyDigest: automationHash(current.manifest.github!.notifications),
        definitionDigest: 'd'.repeat(64),
      };
      deps.activation = async () => ({
        sourceThreadId: 'intake-thread',
        schedule: {
          current: authority,
          saved: { ...authority, version: 1, capabilities: ['assessment-summary'] },
        },
      });
      deps.summaryAuthority = async () => {};
      let writes = 0;
      let receipt: { nodeId: string; databaseId: number; body: string } | undefined;
      deps.feedbackConnect = async () =>
        ({
          comments: {
            identity: fixture.client.identity,
            createIssueComment: async (_o: string, _n: string, _i: number, body: string) => {
              writes++;
              receipt = { nodeId: 'SUMMARY', databaseId: 900, body };
              if (loseResponse) throw new Error('response-lost');
              return receipt;
            },
            findOwnIssueComment: async () => receipt,
          },
        }) as unknown as Awaited<
          ReturnType<NonNullable<CodexDispatchDependencies['feedbackConnect']>>
        >;
      const summary = (input: Record<string, unknown>) =>
        request('summary', { id: prepared.id, ...input }, child);
      const composed = await summary({ operation: 'compose' });
      assert.equal(composed.status, 'composition-ready');
      assert.equal((composed.source as { kind: string }).kind, 'assessment');
      const summaryStore = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      const beforePages = await summaryStore.read();
      const hydrated = await hydrateImplementation(composed, async (read) => {
        const { action, ...input } = read;
        assert.equal(action, 'summary');
        return request('summary', input, child);
      });
      assert.deepEqual(hydrated.verifiedOutcome, { assessment: beforePages.records[0]!.result });
      assert.equal(hydrated.privateResponse, privateResult.fullAssessment);
      assert.deepEqual(await summaryStore.read(), beforePages);
      if (!loseResponse) assert.ok('contextMaterials' in composed);
      assert.equal(
        (
          await summary({
            operation: 'candidate',
            publicText:
              'The proposed change would show your result immediately, so you can keep going.',
          })
        ).status,
        'candidate-recorded',
      );
      assert.equal(
        (await summary({ operation: 'publish' })).status,
        loseResponse ? 'blocked' : 'published',
      );
      if (loseResponse) {
        assert.equal((await summary({ operation: 'publish' })).status, 'reconcile-required');
        assert.equal((await summary({ operation: 'reconcile' })).status, 'published');
      }
      const retained = await summary({ operation: 'compose' });
      assert.equal(retained.status, 'published');
      assert.ok(
        String(retained.presentation).includes(
          `[Plan assessment ↗](https://github.com/owner/repo/issues/3#issuecomment-900) by [@${fixture.client.identity.login}]`,
        ),
      );
      assert.equal(writes, 1);
      const refreshed = await hydrateImplementation(
        await request('context', { id: prepared.id }, child),
        async (read) => request('context', { id: read.id, material: read.material }, child),
      );
      assert.equal(refreshed.previousResult, undefined);
    });
  }

  it('should fill available slots past running assessments and retain the remaining queue and notices', async () => {
    const items = [
      fixture.item,
      ...[4, 5].map((number) => ({
        ...fixture.item,
        number,
        nodeId: 'I_' + number,
        databaseId: 20 + number,
      })),
    ];
    fixture.client.discoverAssigned = async () => ({
      candidates: items.map((item) => ({ ...item, repositoryPath: '/repos/owner/repo' })),
      incomplete: false,
      totalCount: items.length,
      truncated: false,
    });
    fixture.client.getItem = async (_owner, _repo, number) =>
      items.find((item) => item.number === number)!;
    fixture.client.listAssignmentEvents = async (_owner, _repo, number) => ({
      events:
        number === 3
          ? fixture.events
          : fixture.events.map((event) => ({
              ...event,
              nodeId: 'E_' + number,
              databaseId: 30 + number,
            })),
      truncated: false,
    });
    await runCodexIntake(pluginData, false, deps);
    const children = new Map<string, DispatchNativeThread>();
    const checked: string[] = [];
    deps.native!.find = async ({ threadId }) => {
      checked.push(threadId!);
      return children.get(threadId!);
    };
    const launch = async (number: number) => {
      const prepared = await prepare();
      created();
      native!.id = 'issue-thread-' + number;
      native!.name = '#' + number + ': REPAIR CONTAINED BEHAVIOR';
      children.set(native!.id, native!);
      const launched = await request('reconcile', {
        id: prepared.id,
        receipt: { threadId: native!.id },
      });
      assert.equal(launched.nextAction, 'next');
      return prepared;
    };
    const first = await launch(3);
    const second = await launch(4);
    assert.deepEqual(await next(), { status: 'at-capacity', changed: false });
    assert.equal(((await readDispatchState()).records as unknown[]).length, 2);
    const started = await report();
    assert.match(String(started.response), /2 issues started/);
    assert.ok(String(started.response).includes('[owner/repo#3](codex://threads/issue-thread-3)'));
    assert.ok(String(started.response).includes('[owner/repo#4](codex://threads/issue-thread-4)'));

    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    checked.length = 0;
    assert.deepEqual(await next(), { status: 'at-capacity', changed: false });
    assert.deepEqual([...new Set(checked)], ['issue-thread-3', 'issue-thread-4']);
    assert.equal((await report()).status, 'report');

    await historicalResult('result', { id: first.id, result }, { threadId: 'issue-thread-3' });
    Object.assign(children.get('issue-thread-3')!, {
      status: 'idle',
      turnEnded: true,
      turnStatus: 'completed',
    });
    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    const third = await launch(5);
    assert.notEqual(third.id, second.id);
    assert.deepEqual(await next(), { status: 'at-capacity', changed: false });
    const completed = await report();
    assert.match(String(completed.response), /1 issue started/);
    assert.doesNotMatch(String(completed.response), /#3|Plan ready/);
    assert.match(String(completed.response), /repo#5/);
    assert.equal((await report()).status, 'report');
    assert.equal(((await readDispatchState()).records as unknown[]).length, 3);
  });

  it('should end assessment monitoring after authorized continuation without rewriting the result or checkout', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    now += 300001;
    const missing = await next();
    assert.equal(missing.status, 'idle');
    const before = (await readDispatchState()).records as Record<string, unknown>[];
    native!.turnId = 'authorized-follow-up';
    native!.followUpUserTurn = true;
    const current = await selectCodexIntake(pluginData, deps);
    const branchStore = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    await branchStore.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.issueBranch = { attemptId: record.id, name: 'existing-work', phase: 'ready' };
      await save();
    });
    const ordinaryGit = deps.git!;
    deps.git = async (cwd, argv) =>
      argv[0] === 'branch'
        ? 'existing-work'
        : argv.includes('HEAD')
          ? '2'.repeat(40)
          : argv[0] === 'status'
            ? ' M implementation.ts'
            : ordinaryGit(cwd, argv);
    const operator = {
      threadId: 'operator',
      activation: async () => {
        throw new Error('schedule changed');
      },
    };
    const preview = await request('handoff', { id: prepared.id }, operator);
    assert.equal(preview.status, 'handoff-available');
    await assert.rejects(
      request('handoff', { id: prepared.id, digest: 'stale' }, operator),
      /dispatch-recovery-stale/,
    );
    const transitioned = await request(
      'handoff',
      { id: prepared.id, digest: preview.digest },
      operator,
    );
    assert.equal(transitioned.status, 'handed-off');
    assert.equal(transitioned.outcome, undefined);
    const after = (await readDispatchState()).records as Record<string, unknown>[];
    assert.deepEqual(after[0]!.result, before[0]!.result);
    assert.equal(after[0]!.worktree, worktree);
    assert.equal((await request('handoff', { id: prepared.id }, operator)).changed, false);
    const retirementRead = deps.native!.find;
    deps.native!.find = async (input) => {
      assert.equal(
        input.observationOnly,
        true,
        'handoff retains activity observation, not assessment monitoring',
      );
      return native;
    };
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    deps.native!.find = retirementRead;
    assert.equal(
      (await request('context', { id: prepared.id }, { threadId: 'issue-thread' })).status,
      'verified',
    );
    fixture.item.state = 'closed';
    deps.native!.find = retirementRead;
    const retire = await request('retire', { id: prepared.id }, { threadId: 'operator' });
    assert.equal(retire.status, 'retire-available');
  });

  it('should preserve issue state when native access needs host approval', async () => {
    const prepared = await prepare();
    const before = await readDispatchState();
    for (const code of ['EPERM', 'EACCES', 'automation-thread-host-access-required']) {
      deps.native!.find = async () => {
        throw Object.assign(new Error('denied'), { code });
      };
      await assert.rejects(request('reconcile', { id: prepared.id }), { code });
      assert.deepEqual({ ...(await readDispatchState()), run: before.run }, before);
    }
  });

  it('should refuse a quiet report based on a previous occurrence until a fresh scan completes', async () => {
    now += 60000;
    await assert.rejects(report(), /dispatch-scan-required/);
    await runCodexIntake(pluginData, false, deps);
    assert.equal((await report()).status, 'continue');
  });

  it('should require a new terminal dispatch check after each scan occurrence', async () => {
    const current = await selectCodexIntake(pluginData, deps);
    await current.store.exclusive(async (state, save) => {
      state!.records = [];
      await save(state!);
    });
    assert.equal((await report()).status, 'continue');
    await next();
    assert.equal((await report()).status, 'report');
    now += 60000;
    await runCodexIntake(pluginData, false, deps);
    assert.equal((await report()).status, 'continue');
    assert.equal((await next()).status, 'routing-required');
    assert.equal((await report()).status, 'continue');
  });

  it('should retain cards and require continuation after an early report', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    const premature = await report();
    assert.equal(premature.status, 'continue');
    assert.equal(premature.nextAction, 'next');
    assert.equal(premature.remainingActions, 9);
    assert.equal(premature.response, undefined);
    await next();
    assert.equal((await report()).status, 'report');
  });

  it('should bind reporting and action limits to the native occurrence', async () => {
    const previousTime = now;
    for (let action = 0; action < 12; action++)
      assert.equal((await next()).status, 'routing-required');
    assert.equal((await next()).status, 'budget-exhausted');
    assert.equal((await report()).status, 'report');
    now += 300000;
    await runCodexIntake(pluginData, false, deps);
    const stale = await request('report', {
      automationId: 'native-intake',
      currentTimeIso: new Date(previousTime).toISOString(),
    });
    assert.equal(stale.status, 'continue');
    assert.equal(stale.nextAction, 'next');
    assert.deepEqual(stale.request, { action: 'next' });
    const fresh = await report();
    assert.equal(fresh.status, 'continue');
    assert.equal(fresh.remainingActions, 12);
    assert.equal((await next()).status, 'routing-required');
    assert.equal(((await readDispatchState()).records as unknown[]).length, 1);
  });

  it('should recover creation on the next occurrence when its receipt exceeds the action budget', async () => {
    let selected: Record<string, unknown> = {};
    for (let action = 0; action < 11; action++) selected = await next();
    const prepared = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal(prepared.status, 'prepared');
    created();
    assert.equal(
      (await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } }))
        .status,
      'budget-exhausted',
    );
    assert.equal((await report()).status, 'report');
    now += 300000;
    await runCodexIntake(pluginData, false, deps);
    const recovered = await next();
    assert.equal(recovered.status, 'assessing');
    assert.equal(recovered.threadId, 'issue-thread');
    assert.equal(
      (
        await request('prepare', {
          id: prepared.id,
          title: 'repair contained behavior',
          assessment: { complexity: 'medium', reason: 'Retained selection.' },
        })
      ).status,
      'reconcile-required',
    );
    await next();
    assert.match(String((await report()).response), /1 issue started/);
    assert.equal(((await readDispatchState()).records as unknown[]).length, 1);
  });

  it('should require a later user turn and preserve native chat and repository checks for handoff', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    const child = { threadId: 'issue-thread' };
    await assert.rejects(
      request('handoff', { id: prepared.id }),
      /dispatch-handoff-caller-mismatch/,
    );
    await assert.rejects(request('handoff', { id: prepared.id }, child), /workflow-policy-held/);
    native!.followUpUserTurn = true;
    native!.turnId = 'follow-up';
    const preview = await request('handoff', { id: prepared.id }, child);
    native!.turnId = 'newer-follow-up';
    await assert.rejects(
      request('handoff', { id: prepared.id, digest: preview.digest }, child),
      /dispatch-recovery-stale/,
    );
    const original = deps.git!;
    deps.git = async (cwd, argv) =>
      argv[0] === 'remote' ? 'https://github.com/other/repo.git' : original(cwd, argv);
    await assert.rejects(
      request('handoff', { id: prepared.id }, child),
      /dispatch-worktree-diverged/,
    );
    deps.git = original;
    native!.cwd = source;
    await assert.rejects(
      request('handoff', { id: prepared.id }, child),
      /dispatch-native-readback-diverged/,
    );
  });

  it('should apply live debug edits to cached intake reports without replaying starts', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    await next();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      const historical = structuredClone(state.records[0]!);
      historical.id = 'f'.repeat(64);
      historical.intakeId = 'e'.repeat(64);
      historical.retired = { at: now, by: 'old-owner' };
      historical.phase = 'blocked';
      historical.request = undefined;
      historical.threadId = undefined;
      historical.effective = undefined;
      state.records.push(historical);
      await save();
    });
    await next();
    const first = await report();
    assert.equal(first.status, 'report');
    assert.match(String(first.response), /1 issue started/);
    const saved = await store.read();
    const record = structuredClone(saved.records[0]);
    const operational = saved.run!.response;
    for (const debug of [true, false, true]) {
      await writeFile(join(workspace, 'agent.yaml'), JSON.stringify({ ...manifest, debug }));
      const repeated = await report();
      assert.equal(repeated.status, 'report');
      assert.equal(String(repeated.response).includes('🔬 Debug'), debug);
      assert.equal(String(repeated.response).includes('retirement-legacy-unverified'), debug);
      assert.match(String(repeated.response), /1 issue started/);
      assert.equal((await store.read()).run!.response, operational);
      assert.deepEqual((await store.read()).records[0], record);
    }
    await store.exclusive(async (state, save) => {
      state.run!.response = 'obsolete retirement-legacy-unverified warning';
      delete state.run!.reportVersion;
      state.run!.actions = 12;
      await save();
    });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify({ ...manifest, debug: false }));
    const upgraded = await report();
    assert.equal(upgraded.status, 'report');
    assert.match(String(upgraded.response), /DONT_NOTIFY/);
    assert.doesNotMatch(String(upgraded.response), /obsolete|legacy-unverified|1 issue started/);
    assert.deepEqual((await store.read()).records[0], record);
  });

  it('should preserve a handoff preview across feedback scans and intake presentation updates', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    await historicalResult('result', { id: prepared.id, result }, child);
    native!.followUpUserTurn = true;
    native!.turnId = 'authorized-follow-up';
    const preview = await request('handoff', { id: prepared.id }, child);
    const selected = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(
      selected.store.location.root,
      selected.store.location.scope,
    );
    const feedback = {
      startedAt: now,
      baseline: {},
      events: [],
      scannedAt: 'later-scan',
      scannedTime: now + 1,
    };
    await store.exclusive(async (state, save) => {
      const record = state.records.find((item) => item.id === prepared.id)!;
      record.feedback = feedback;
      record.intakeReportedAt = now + 1;
      record.renameRequested = true;
      await save();
    });
    assert.equal(
      (await request('handoff', { id: prepared.id, digest: preview.digest }, child)).status,
      'handed-off',
    );
    const retained = (await store.read()).records.find((item) => item.id === prepared.id)!;
    assert.deepEqual(retained.feedback, feedback);
    assert.equal(retained.result?.summary, result.summary);
  });

  it('should require a fresh handoff preview when the retained assessment changes', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    await historicalResult('result', { id: prepared.id, result }, child);
    native!.followUpUserTurn = true;
    native!.turnId = 'authorized-follow-up';
    const preview = await request('handoff', { id: prepared.id }, child);
    const selected = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(
      selected.store.location.root,
      selected.store.location.scope,
    );
    await store.exclusive(async (state, save) => {
      state.records.find((item) => item.id === prepared.id)!.result!.summary = 'Revised scope.';
      await save();
    });
    await assert.rejects(
      request('handoff', { id: prepared.id, digest: preview.digest }, child),
      /dispatch-recovery-stale/,
    );
    assert.equal(
      (await store.read()).records.find((item) => item.id === prepared.id)!.handoff,
      undefined,
    );
    const refreshed = await request('handoff', { id: prepared.id }, child);
    assert.equal(refreshed.previousResult, undefined);
    assert.equal(
      (await request('handoff', { id: prepared.id, digest: refreshed.digest }, child)).status,
      'handed-off',
    );
  });

  async function configureAssessment(assessment: unknown) {
    const configured = structuredClone(manifest);
    Object.assign(configured.github['issue-assignment'], { assessment });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
    await runCodexIntake(pluginData, true, {
      codexHome,
      now: () => now,
      connect: async () => fixture.client,
    });
  }

  async function workflow(enabled: boolean) {
    const configured = structuredClone(manifest);
    configured.github['issue-assignment'].allowed = enabled
      ? manifest.github['issue-assignment'].allowed
      : [];
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
  }

  it('should hold admitted dispatch while disabled and resume it before checking lifecycle', async () => {
    const selected = await next();
    await workflow(false);
    assert.equal((await next()).status, 'idle');
    await workflow(true);
    const resumed = await next();
    assert.equal(resumed.status, 'routing-required');
    assert.equal(resumed.id, selected.id);
    fixture.item.state = 'closed';
    const rejected = await request('prepare', {
      id: resumed.id,
      digest: resumed.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal(rejected.code, 'dispatch-issue-closed');
    assert.equal((rejected as { request?: unknown }).request, undefined);
  });

  for (const pause of ['native', 'manifest'] as const)
    it(`should retain an accepted occurrence through ${pause} pause and block a fresh run`, async () => {
      const routed = await next();
      const activation = deps.activation!;
      let paused = false;
      deps.activation = async (...args) => {
        if (paused && !args[3]) throw new Error('intake-automation-paused');
        return activation(...args);
      };
      if (pause === 'manifest') {
        const configured = structuredClone(manifest);
        Object.assign(configured.github['issue-assignment'], { paused: true });
        await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
      }
      paused = true;
      const prepared = await request('prepare', {
        id: routed.id,
        digest: routed.digest,
        title: 'repair contained behavior',
        assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
      });
      assert.equal(prepared.status, 'prepared');
      now += 60000;
      await assert.rejects(next(), /intake-automation-paused/u);
      paused = false;
      await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
      await next();
      const records = (await readDispatchState()).records as { id: string }[];
      assert.equal(records.length, 1);
      assert.equal(records[0]!.id, routed.id);
    });

  it('should retain an admitted creation when intake is disabled during preparation', async () => {
    const selected = await next();
    const connect = deps.connect!;
    const prepared = await request(
      'prepare',
      {
        id: selected.id,
        digest: selected.digest,
        title: 'repair contained behavior',
        assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
      },
      {
        connect: async (workspace, signal) => {
          await workflow(false);
          return connect(workspace, signal);
        },
      },
    );
    assert.equal(prepared.status, 'policy-held');
    const retained = (await readDispatchState()).records as { request?: unknown }[];
    assert.equal(retained[0]!.request, undefined);
    await workflow(true);
    assert.equal((await next()).id, selected.id);
  });

  it('should retain a child task when intake and assigner defaults change', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    await request('context', { id: prepared.id }, child);
    const configured = structuredClone(manifest);
    Object.assign(configured.github['issue-assignment'], {
      paused: true,
      allowed: [{ login: 'other', 'node-id': 'U_other' }],
    });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
    assert.equal(
      (await historicalResult('result', { id: prepared.id, result }, child)).status,
      'recorded',
    );
    const records = (await readDispatchState()).records as { phase: string; result?: unknown }[];
    assert.equal(records[0]!.phase, 'complete');
    assert.deepEqual(records[0]!.result, result);
  });

  for (const phase of ['creating', 'assessing', 'complete'] as const)
    it(`should retain ${phase} work and accept its verified child result while disabled`, async () => {
      const prepared = await prepare();
      const child = { threadId: 'issue-thread' };
      if (phase !== 'creating') {
        created();
        assert.equal((await request('context', { id: prepared.id }, child)).status, 'verified');
      }
      if (phase === 'complete')
        await historicalResult('result', { id: prepared.id, result }, child);
      await workflow(false);
      const activation = deps.activation;
      deps.activation = async (_root, _deps, _paused, retainedWork) => {
        assert.equal(retainedWork, true);
        return { sourceThreadId: 'intake-thread' };
      };
      if (phase === 'creating') {
        const uncertain = await request('reconcile', { id: prepared.id });
        assert.equal(uncertain.code, 'dispatch-creation-unresolved');
        created();
        await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
      }
      const context = await request('context', { id: prepared.id }, child);
      assert.equal(context.status, 'verified');
      await assert.rejects(
        request('context', { id: prepared.id }, { threadId: 'unrelated-chat' }),
        /dispatch-assessment-caller-mismatch/,
      );
      const recorded = await request(
        'result',
        {
          id: prepared.id,
          result,
          previousResultDigest: context.previousResultDigest,
        },
        child,
      );
      assert.equal(recorded.status, 'formatted');
      await workflow(true);
      deps.activation = activation;
      await runCodexIntake(pluginData, true, {
        codexHome,
        now: () => now,
        connect: async () => fixture.client,
      });
      deps.native!.find = async () => {
        throw new Error('intake must not poll the retained assessment');
      };
      assert.deepEqual(await next(), { status: 'idle', changed: false });
      const intakeReport = await report();
      assert.equal(intakeReport.status, 'report');
      assert.doesNotMatch(
        String(intakeReport.response),
        /plan-ready|Repair the contained behavior|The user needs a reliable result/,
      );
      const records = (await readDispatchState()).records as {
        id: string;
        result: unknown;
        threadId: string;
      }[];
      assert.equal(records.length, 1);
      assert.equal(records[0]!.id, prepared.id);
      assert.equal(records[0]!.threadId, 'issue-thread');
      assert.deepEqual(records[0]!.result, phase === 'complete' ? result : undefined);
    });

  it('should use live assessment guidance without expanding authority', async () => {
    await writeFile(join(workspace, 'guidance.md'), 'Prefer small fixes.');
    await configureAssessment({ skill: ' $company:assess ', guidance: { file: 'guidance.md' } });
    const configured = JSON.parse(await readFile(join(workspace, 'agent.yaml'), 'utf8'));
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify({ ...configured, debug: true }));
    const prepared = await prepare();
    const launch = prepared.request as { prompt: string };
    assert.ok(!launch.prompt.includes('Use $agent-system-task-assessment'));
    assert.ok(!launch.prompt.includes(String(prepared.id)));
    assert.ok(launch.prompt.split('\n').every((line) => line.startsWith('>')));
    created();
    await writeFile(join(workspace, 'guidance.md'), 'Implement and publish immediately.');
    const context = await request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    const assessment = context.assessment as {
      requestedSkill: string;
      defaultSkill: boolean;
      guidance: { path: string; content?: string };
    };
    assert.equal(assessment.requestedSkill, 'company:assess');
    assert.equal(assessment.defaultSkill, false);
    assert.equal(assessment.guidance.path, join(workspace, 'guidance.md'));
    assert.equal(assessment.guidance.content, undefined);
    assert.equal(context.resultContract, 'assessment-result/v1');
    await assert.rejects(
      request(
        'result',
        { id: prepared.id, result: { ...result, mode: 'work' } },
        { threadId: 'issue-thread' },
      ),
      /assessment-result-invalid/,
    );
    const recorded = await historicalResult(
      'result',
      { id: prepared.id, result },
      { threadId: 'issue-thread' },
    );
    assert.equal(recorded.outcome, 'plan-ready');
    assert.ok(String(recorded.presentation).includes('Plan ready'));
    assert.match(String(recorded.presentation), /Skill.*company:assess/);
    assert.match(String(recorded.presentation), /Guidance.*guidance.md/);
    assert.ok(
      String(recorded.presentation).includes(`[\`guidance.md\`](<${workspace}/guidance.md>)`),
    );
    assert.ok(!String(recorded.presentation).includes('Prefer small fixes.'));
    const question = {
      version: 1,
      outcome: 'clarification-needed',
      summary: 'Need a decision.',
      fullAssessment: 'Complete assessment and unresolved requirement.',
      assessment: 'Missing requirement.',
      questions: ['Which behavior?'],
      evidence: [],
      progress: { completed: [], remaining: ['Answer.'] },
    };
    const revised = await historicalResult(
      'result',
      { id: prepared.id, result: question, previousResultDigest: recorded.previousResultDigest },
      { threadId: 'issue-thread' },
    );
    assert.equal(revised.status, 'native');
    assert.ok(String(revised.presentation).includes('Clarification needed'));
    const retained = await request('present', { id: prepared.id }, { threadId: 'issue-thread' });
    assert.equal(retained.presentation, recorded.presentation);
  });

  it('should show the saved plan after authority and checkout changes without refreshing assessment', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    await request('context', { id: prepared.id }, child);
    const recorded = await historicalResult('result', { id: prepared.id, result }, child);
    fixture.item.assignees = [];
    deps.activation = async () => {
      throw new Error('schedule disabled');
    };
    deps.git = async () => {
      throw new Error('checkout changed');
    };
    deps.connect = async () => {
      throw new Error('provider unavailable');
    };
    const shown = await request('present', { id: prepared.id }, child);
    assert.equal(shown.status, 'presented');
    assert.equal(shown.presentation, recorded.presentation);
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const before = await store.read();
    const detailed = await request('present', { id: prepared.id, includeDetails: true }, child);
    assert.equal(detailed.status, 'presented');
    assert.ok(String(detailed.presentation).includes(result.progress.completed[0]!));
    assert.deepEqual(await store.read(), before);
    await assert.rejects(
      request('present', { id: prepared.id }, { threadId: 'foreign' }),
      /caller-mismatch/,
    );
  });

  it('should keep clarification in native chat before recording a completed assessment', async () => {
    await configureAssessment({ skill: 'company:assess' });
    const prepared = await prepare();
    const pendingState = await readDispatchState();
    const pending = pendingState.records as DispatchRecord[];
    assert.equal(pending[0]!.threadId, undefined);
    assert.equal(pending[0]!.worktree, undefined);
    created();
    const child = { threadId: 'issue-thread' };
    const hints = await selectCodexTurnTask(pending, child, {
      find: deps.native!.find,
      receipt: async () => {
        throw new Error('initial assignment must not require feedback');
      },
    });
    assert.equal(hints?.worktree, native!.cwd);
    assert.equal(hints?.contextRuntime, 'dispatchRuntime');
    assert.deepEqual(await readDispatchState(), pendingState);
    const { action, ...input } = hints!.contextRequest!;
    // The internal dispatch entry receives the id resolved by the native adapter.
    const context = await request(action, { ...input, id: prepared.id }, child);
    assert.equal(context.currentTurnId, 'first-turn');
    assert.equal(context.previousResultTurnId, undefined);
    assert.equal(context.entry, 'managed');
    assert.equal((context.project as { path: string }).path, native!.cwd);
    assert.equal((context.presentationRequest as { operation: string }).operation, 'render');
    assert.equal('cards' in (context.presentationRequest as object), false);
    const original =
      'Keep records until the retention decision is answered.\n\nPartial plan: inspect the store, then remove eligible records only after approval.\n\nWhich retention period applies?\n\nThe failure cause is unverified.';
    const question = {
      version: 1,
      outcome: 'clarification-needed',
      summary: 'Retention needs a decision.',
      assessment: 'Useful partial work is available.',
      questions: ['Which retention period applies?'],
      fullAssessment: original,
      evidence: [],
      progress: { completed: [], remaining: ['Retention decision.'] },
    };
    const beforeRender = await readDispatchState();
    const renderRequest = {
      ...(context.presentationRequest as Record<string, unknown>),
      result: { ...question, reviewSummary: question.summary },
    };
    await assert.rejects(
      request('assessment', { ...renderRequest, cards: ['forged card'] }, child),
      /assessment-render-request-invalid/,
    );
    const rendered = await request('assessment', renderRequest, child);
    assert.equal(rendered.status, 'formatted');
    assert.match(String(rendered.presentation), /Model routing/);
    assert.doesNotMatch(String(rendered.presentation), /forged card/);
    const omittedId: Record<string, unknown> = { ...renderRequest };
    delete omittedId.id;
    const inferred = await request('assessment', omittedId, child);
    assert.equal(inferred.presentation, rendered.presentation);
    await assert.rejects(
      request(
        'assessment',
        { ...omittedId, target: 'https://github.com/owner/repo/issues/999' },
        child,
      ),
      /assessment-managed-target-mismatch/,
    );
    await assert.rejects(
      request('assessment', omittedId, { threadId: 'foreign' }),
      /assessment-managed-context-invalid/,
    );
    assert.deepEqual(await readDispatchState(), beforeRender);
    await assert.rejects(
      request('assessment', { ...renderRequest, id: 'f'.repeat(64) }, child),
      /assessment-render-request-invalid/,
    );
    await assert.rejects(
      request('assessment', renderRequest, { threadId: 'foreign' }),
      /assessment-managed-context-invalid/,
    );
    const saved = await historicalResult('result', { id: prepared.id, result: question }, child);
    assert.ok(String(saved.presentation).includes('Which retention period applies?'));
    assert.doesNotMatch(String(saved.presentation), /Partial plan/);
    const current = await request('context', { id: prepared.id }, child);
    assert.equal(saved.status, 'native');
    assert.equal(current.previousResult, undefined);
    assert.equal(current.previousResultTurnId, undefined);
    assert.equal(current.previousPresentation, undefined);
    assert.deepEqual(
      await historicalResult('result', { id: prepared.id, result: question }, child),
      saved,
    );

    native!.turnId = 'later-answer';
    const followUp = await request('context', { id: prepared.id }, child);
    assert.notEqual(followUp.previousResultTurnId, followUp.currentTurnId);
    assert.deepEqual(followUp.assessment, current.assessment);
    const revised = {
      ...result,
      fullAssessment:
        original +
        '\n\nAnswer: retain records for 30 days. Remove only older records after approval.',
    };
    const recorded = await historicalResult(
      'result',
      { id: prepared.id, previousResultDigest: followUp.previousResultDigest, result: revised },
      child,
    );
    assert.ok(String(recorded.presentation).includes(revised.fullAssessment));
    const retained = await request('context', { id: prepared.id }, child);
    assert.equal(retained.previousResult, undefined);
    assert.equal(retained.previousResultTurnId, undefined);
    assert.equal(retained.previousPresentation, undefined);
    assert.deepEqual(retained.effective, current.effective);
    native!.followUpUserTurn = true;
    const handoff = await request('handoff', { id: prepared.id }, child);
    assert.equal(handoff.previousResult, undefined);
    const transitioned = await request(
      'handoff',
      { id: prepared.id, digest: handoff.digest },
      child,
    );
    assert.equal(transitioned.previousResult, undefined);
    assert.deepEqual(
      (await request('handoff', { id: prepared.id }, child)).previousResult,
      undefined,
    );
  });

  it('should block unavailable selections before preparing creation and recover the retained assignment', async () => {
    const available = deps.native!.assessmentSkill;
    deps.native!.assessmentSkill = async () => {
      throw new Error('dispatch-assessment-skill-unavailable');
    };
    const selected = await next();
    const blocked = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'inspect issue',
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal(blocked.code, 'dispatch-assessment-skill-unavailable');
    const records = (await readDispatchState()).records as Array<{ request?: unknown }>;
    assert.equal(records[0]!.request, undefined);
    deps.native!.assessmentSkill = available;
    now += 300001;
    assert.equal((await prepare()).id, selected.id);
  });

  it('should use updated assessment skill content without replacing the native request', async () => {
    const prepared = await prepare();
    created();
    const selected = deps.native!.assessmentSkill;
    deps.native!.assessmentSkill = async (cwd, id) => ({
      ...(await selected(cwd, id)),
      digest: 'b'.repeat(64),
    });
    const context = await request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    assert.equal(
      (context.assessment as { skill: { digest: string } }).skill.digest,
      'b'.repeat(64),
    );
    const records = (await readDispatchState()).records as Array<{ request: unknown }>;
    assert.deepEqual(records[0]!.request, prepared.request);
  });

  it('should report ambiguous live skill selection without silently choosing the historical skill', async () => {
    await configureAssessment({ skill: '$assess' });
    const resolve = deps.native!.assessmentSkill;
    deps.native!.assessmentSkill = async (cwd, id) => {
      if (native && id === 'assess') throw new Error('dispatch-assessment-skill-ambiguous');
      return resolve(cwd, 'company:assess');
    };
    const prepared = await prepare();
    created();
    await assert.rejects(
      request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-skill-ambiguous/,
    );
  });

  it('should block unreadable guidance before native creation without discarding the assignment', async () => {
    await configureAssessment({ guidance: { file: 'missing.md' } });
    const selected = await next();
    const blocked = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'inspect issue',
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal(blocked.code, 'dispatch-assessment-guidance-unreadable');
    const records = (await readDispatchState()).records as Array<{ request?: unknown }>;
    assert.equal(records[0]!.request, undefined);
    await writeFile(join(workspace, 'missing.md'), 'Prefer small fixes.');
    now += 300001;
    assert.equal((await prepare()).id, selected.id);
  });

  it('should recognize an unchanged repo skill in the verified child worktree', async () => {
    deps.native!.assessmentSkill = async (cwd, id) => ({
      name: id,
      path: join(cwd, '.agents/skills/assessment/SKILL.md'),
      scope: 'repo',
      digest: 'a'.repeat(64),
    });
    const prepared = await prepare();
    created();
    const context = await request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    assert.equal(
      (context.assessment as { skill: { path: string } }).skill.path,
      join(worktree, '.agents/skills/assessment/SKILL.md'),
    );
  });

  it('should apply live assessment configuration to legacy receipts', async () => {
    const prepared = await prepare();
    const selected = await selectCodexIntake(pluginData, deps);
    const legacy = await new CodexDispatchStore(
      selected.store.location.root,
      selected.store.location.scope,
    ).read();
    delete legacy.records[0]!.assessment;
    await writeFile(
      join(pluginData, 'codex-dispatch-' + legacy.scope + '.json'),
      JSON.stringify(legacy),
    );
    await configureAssessment({ skill: 'company:assess', guidance: 'New assessment guidance.' });
    created();
    const context = await request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    const assessment = context.assessment as {
      defaultSkill: boolean;
      skill: { name: string };
      guidance?: unknown;
    };
    assert.equal(assessment.defaultSkill, false);
    assert.equal(assessment.skill.name, 'company:assess');
    assert.equal((assessment.guidance as { content: string }).content, 'New assessment guidance.');
    const resumed = await request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    assert.deepEqual(resumed.assessment, assessment);
  });

  async function reassign() {
    now += 2000;
    fixture.events.push({
      ...fixture.events[0]!,
      nodeId: 'E_assignment_' + now,
      databaseId: now,
      createdAt: new Date(now).toISOString(),
    });
    await runCodexIntake(pluginData, false, {
      codexHome,
      assertActive: async () => {},
      now: () => now,
      connect: async () => fixture.client,
    });
  }

  it('should use configured automatic grace and ignore obsolete settings during operator retirement', async () => {
    const originalXdg = process.env.XDG_CONFIG_HOME;
    const originalOpenClaw = process.env.OPENCLAW_CONFIG_PATH;
    process.env.XDG_CONFIG_HOME = root;
    process.env.OPENCLAW_CONFIG_PATH = join(root, 'openclaw.json');
    delete deps.readCleanupConfiguration;
    try {
      await writeFile(
        process.env.OPENCLAW_CONFIG_PATH,
        JSON.stringify({
          plugins: { entries: { 'agent-system': { config: { cleanup: { graceMinutes: 17 } } } } },
        }),
      );
      const prepared = await prepare();
      created();
      await historicalResult('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
      native!.status = 'idle';
      native!.turnEnded = true;
      const directory = join(root, 'tanaab', 'agent-system');
      const path = join(directory, 'config.yaml');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path, 'schema-version: 1\ncleanup: {grace-minutes: 0}', { mode: 0o600 });
      fixture.item.state = 'closed';
      now += 60_000;
      await next();
      const selected = await selectCodexIntake(pluginData, deps);
      const journal = new CodexDispatchStore(
        selected.store.location.root,
        selected.store.location.scope,
      );
      const automatic = (await journal.read()).records[0]!;
      assert.equal(automatic.retirement!.eligibleAt, now + 17 * 60_000);
      assert.equal(automatic.retired, undefined);
      await writeFile(path, 'invalid obsolete settings');
      const operator = { threadId: 'operator' };
      const preview = await request('retire', { id: prepared.id }, operator);
      const queued = await request('retire', { id: prepared.id, digest: preview.digest }, operator);
      assert.equal(queued.status, 'retirement-inventory-required');
      const requestedAt = now;
      now += 60_000;
      await next();
      const manual = (await journal.read()).records[0]!;
      assert.equal(manual.retirement!.eligibleAt, requestedAt);
      assert.notEqual(manual.retirement?.code, 'retirement-configuration-invalid');
      assert.equal(manual.retired, undefined);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = originalXdg;
      if (originalOpenClaw === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
      else process.env.OPENCLAW_CONFIG_PATH = originalOpenClaw;
    }
  });

  it('should hold broken codex cleanup sources and retain the repaired configured deadline across edits', async () => {
    const prepared = await prepare();
    created();
    await historicalResult('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
    native!.status = 'idle';
    native!.turnEnded = true;
    fixture.item.state = 'closed';
    const current = await selectCodexIntake(pluginData, deps);
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const record = async () => (await journal.read()).records[0]!;
    await writeCleanup(-1);
    now += 60_000;
    await next();
    assert.equal((await record()).retirement?.code, 'retirement-configuration-invalid');
    assert.equal((await record()).retirement?.deadlinePending, true);
    await rm(join(root, 'openclaw.json'));
    now += 60_000;
    await next();
    assert.equal((await record()).retirement?.code, 'retirement-configuration-unavailable');
    assert.equal((await record()).retired, undefined);
    await writeCleanup(17);
    now += 60_000;
    await next();
    const deadline = now + 17 * 60_000;
    assert.equal((await record()).retirement?.eligibleAt, deadline);
    await writeCleanup(0);
    now += 60_000;
    await next();
    assert.equal((await record()).retirement?.eligibleAt, deadline);
    assert.equal((await record()).retired, undefined);
    now = deadline;
    assert.equal((await next()).status, 'retirement-inventory-required');
    assert.equal((await record()).retirement?.archiveAttempt, undefined);
  });

  it('should keep zero grace codex protection and defer archival when disk policy changes at final verification', async () => {
    await writeCleanup(0);
    const prepared = await prepare();
    created();
    await historicalResult('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
    fixture.item.state = 'closed';
    now += 60_000;
    await next();
    const current = await selectCodexIntake(pluginData, deps);
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const record = async () => (await journal.read()).records[0]!;
    const eligibleAt = now;
    assert.equal((await record()).retirement?.eligibleAt, eligibleAt);
    assert.equal((await record()).retirement?.code, 'retirement-native-work-unresolved');
    native!.status = 'idle';
    native!.turnEnded = true;
    deps.retirementNative = {
      worktreeUsers: async () => ['issue-thread', 'unowned'],
      archiveOutcome: async () => 'unverified',
    };
    const threads = {
      schemaVersion: 4,
      pinnedThreads: [{ id: 'issue-thread' }],
      unavailableHosts: [],
      unavailableSources: [],
    };
    now += 60_000;
    await request('next', { projects, threads });
    assert.equal((await record()).retirement?.code, 'retirement-worktree-shared');
    assert.equal((await record()).retirement?.archiveAttempt, undefined);
    const deadline = (await record()).retirement!.eligibleAt;
    assert.equal(deadline, eligibleAt);
    deps.retirementNative = {
      worktreeUsers: async () => ['issue-thread'],
      archiveOutcome: async () => 'unverified',
    };
    const git = deps.git!;
    deps.git = async (path, args) => {
      const result = await git(path, args);
      if (args[0] === 'remote') await writeCleanup(17);
      return result;
    };
    now += 60_000;
    await request('next', { projects, threads });
    assert.equal((await record()).retirement?.code, 'retirement-configuration-changed');
    assert.equal((await record()).retirement?.archiveAttempt, undefined);
    assert.equal((await record()).retired, undefined);
    deps.git = git;
    now += 60_000;
    assert.equal((await request('next', { projects, threads })).status, 'retirement-prepared');
    assert.equal((await record()).retirement?.eligibleAt, deadline);
    assert.equal((await record()).retired, undefined);
  });

  it('should enter manual retirement for open assigned work immediately and retain its request', async () => {
    const first = await prepare();
    const operator = {
      threadId: 'operator',
      activation: async (
        _data: unknown,
        _options: unknown,
        paused?: boolean,
        retained?: boolean,
      ) => {
        assert.equal(paused, false);
        assert.equal(retained, true);
        return { sourceThreadId: 'intake-thread' };
      },
    };
    await assert.rejects(request('retire', { id: first.id }), /dispatch-operator-caller-required/);

    let connected = false;
    await assert.rejects(
      request(
        'retire',
        { id: first.id },
        {
          ...operator,
          native: {
            ...deps.native!,
            operatorInput: async () => {
              throw new Error('reply-native-user-input-required');
            },
          },
          connect: async (...args) => {
            connected = true;
            return deps.connect!(...args);
          },
        },
      ),
      /reply-native-user-input-required/,
    );
    assert.equal(connected, false);
    const before = (await readDispatchState()).records as Record<string, unknown>[];
    const preview = await request('retire', { id: first.id }, operator);
    assert.equal(preview.status, 'retire-available');
    assert.deepEqual((await readDispatchState()).records, before);
    await assert.rejects(
      request('retire', { id: first.id, digest: 'stale' }, operator),
      /dispatch-recovery-stale/,
    );
    const applied = await request('retire', { id: first.id, digest: preview.digest }, operator);
    assert.equal(applied.status, 'retirement-pending');
    const after = (await readDispatchState()).records as Record<string, unknown>[];
    assert.equal(after[0]!.retired, undefined);
    const disposition = after[0]!.retirement as {
      reason: string;
      eligibleAt: number;
      operatorRequest: { caller: string; targetId: string };
    };
    assert.equal(disposition.reason, 'operator-requested');
    assert.equal(disposition.eligibleAt, now);
    assert.equal(disposition.operatorRequest.caller, 'operator');
    assert.equal(disposition.operatorRequest.targetId, first.id);
    assert.equal(
      ((await request('inspect')).records as { workflowStatus: string }[])[0]!.workflowStatus,
      'retirement-pending',
    );
    assert.equal(after[0]!.lifecycleCheckedAt, now);
    assert.equal(fixture.item.state, 'open');
    now += 60_001;
    const repeated = await request('retire', { id: first.id }, operator);
    await request('retire', { id: first.id, digest: repeated.digest }, operator);
    const retirement = ((await readDispatchState()).records as Record<string, unknown>[])[0]!
      .retirement as { eligibleAt: number };
    assert.equal(retirement.eligibleAt, (applied.retirement as { eligibleAt: number }).eligibleAt);
    await next();
    const reconciled = ((await readDispatchState()).records as Record<string, unknown>[])[0]!;
    assert.equal(reconciled.lifecycleCheckedAt, now);
    assert.equal(reconciled.retired, undefined);
    assert.equal(
      (reconciled.retirement as { code: string }).code,
      'retirement-native-creation-unresolved',
    );
    await assert.rejects(
      request('context', { id: first.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-retired/,
    );
  });

  it('should retain a self-retirement request without archiving the active caller', async () => {
    const prepared = await prepare();
    created();
    await request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    native!.status = 'idle';
    native!.turnEnded = true;
    const caller = { threadId: 'issue-thread' };
    const preview = await request('retire', { id: prepared.id }, caller);
    const applied = await request('retire', { id: prepared.id, digest: preview.digest }, caller);
    assert.equal(applied.status, 'retirement-pending');
    assert.equal(
      (applied.retirement as { code: string }).code,
      'retirement-native-work-unresolved',
    );
    assert.equal(fixture.item.state, 'open');
  });

  it('should allow verified operator retirement from another managed issue chat', async () => {
    const first = await prepare();
    fixture.item.state = 'closed';
    const operator = {
      threadId: 'operator',
      activation: async () => ({ sourceThreadId: 'intake-thread' }),
    };
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records.push({
        ...structuredClone(state.records[0]!),
        id: 'f'.repeat(64),
        issueKey: 'e'.repeat(64),
        threadId: 'operator',
        worktree,
      });
      await save();
    });
    const before = await readDispatchState();
    let connected = false;
    await assert.rejects(
      request(
        'retire',
        { id: first.id },
        {
          ...operator,
          native: {
            ...deps.native!,
            operatorInput: async () => {
              throw new Error('reply-native-user-input-required');
            },
          },
          connect: async (...args) => {
            connected = true;
            return deps.connect!(...args);
          },
        },
      ),
      /reply-native-user-input-required/,
    );
    assert.equal(connected, false);
    assert.deepEqual(await readDispatchState(), before);
    const preview = await request('retire', { id: first.id }, operator);
    assert.equal(preview.status, 'retire-available');
    assert.equal(
      (await request('retire', { id: first.id, digest: preview.digest }, operator)).status,
      'retirement-pending',
    );
    const after = (await readDispatchState()).records as Record<string, unknown>[];
    assert.deepEqual(after[1], (before.records as Record<string, unknown>[])[1]);
    assert.equal(
      (after[0]!.retirement as { operatorRequest: { caller: string } }).operatorRequest.caller,
      'operator',
    );
  });

  it('should preserve a completed assessment and dispatch once after an explicit reset and new assignment', async () => {
    const first = await prepare();
    created();
    await historicalResult('result', { id: first.id, result }, { threadId: 'issue-thread' });
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    await next();
    await reassign();
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    const operator = { threadId: 'operator' };
    const before = await readDispatchState();
    const preview = await request('reset', { id: first.id }, operator);
    assert.equal(preview.status, 'reset-available');
    assert.deepEqual(await readDispatchState(), before);
    assert.equal(
      (await request('reset', { id: first.id, digest: preview.digest }, operator)).status,
      'reset',
    );
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    await assert.rejects(
      request('context', { id: first.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-reset/,
    );
    await assert.rejects(
      historicalResult('result', { id: first.id, result }, { threadId: 'issue-thread' }),
      /dispatch-assessment-reset/,
    );
    await reassign();
    const second = await prepare();
    assert.notEqual(second.id, first.id);
    const records = (await readDispatchState()).records as {
      id: string;
      result?: unknown;
      reset?: { by: string };
      request: unknown;
    }[];
    assert.equal(records.length, 2);
    assert.deepEqual(records[0]!.result, result);
    assert.deepEqual(records[0]!.request, (before.records as { request: unknown }[])[0]!.request);
    assert.equal(records[0]!.reset?.by, 'operator');
    assert.equal(records[1]!.reset, undefined);
    assert.equal(records[1]!.id, second.id);
    // pending creation is reconciled, never emitted again as a fresh request.
    native = undefined;
    assert.notEqual((await next()).status, 'prepared');
    assert.equal(((await readDispatchState()).records as unknown[]).length, 2);
  });

  it('should reject reset from intake or child chats, unfinished work, stale previews, and active chats', async () => {
    const first = await prepare();
    const operator = { threadId: 'operator' };
    await assert.rejects(request('reset', { id: first.id }), /dispatch-operator-caller-required/);
    await assert.rejects(
      request('reset', { id: first.id }, operator),
      /dispatch-reset-unavailable/,
    );
    created();
    await historicalResult('result', { id: first.id, result }, { threadId: 'issue-thread' });
    await assert.rejects(
      request('reset', { id: first.id }, { threadId: 'issue-thread' }),
      /dispatch-operator-caller-required/,
    );
    await assert.rejects(
      request('reset', { id: first.id }, operator),
      /dispatch-reset-chat-active/,
    );
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    const preview = await request('reset', { id: first.id }, operator);
    native!.turnId = 'later-turn';
    await assert.rejects(
      request('reset', { id: first.id, digest: preview.digest }, operator),
      /dispatch-reset-chat-active/,
    );
    native!.turnId = 'first-turn';
    await assert.rejects(
      request('reset', { id: first.id, digest: 'stale' }, operator),
      /dispatch-recovery-stale/,
    );
    native!.status = 'notLoaded';
    native!.turnStatus = 'interrupted';
    await assert.rejects(
      request('reset', { id: first.id }, operator),
      /dispatch-reset-chat-active/,
    );
    native = undefined;
    await assert.rejects(
      request('reset', { id: first.id }, operator),
      /dispatch-native-readback-diverged/,
    );
    const records = (await readDispatchState()).records as { reset?: unknown; result: unknown }[];
    assert.equal(records[0]!.reset, undefined);
    assert.deepEqual(records[0]!.result, result);
  });

  async function addPendingSecondIssue() {
    const current = await selectCodexIntake(pluginData, deps);
    const admission = structuredClone((await current.store.read())!.records[0]!);
    admission.issue = { ...admission.issue, number: 4, nodeId: 'I_second', databaseId: 21 };
    admission.id = automationHash([
      admission.scope,
      admission.repository.nodeId,
      admission.issue.nodeId,
      admission.assignment.nodeId,
    ]);
    await current.store.exclusive(async (state, save) => {
      state!.records.push(admission);
      await save(state!);
    });
    const connect = deps.connect!;
    deps.connect = async (...args) => {
      const client = await connect(...args);
      return {
        ...client,
        getItem: async (owner, name, number) =>
          number === 4
            ? { ...fixture.item, ...admission.issue }
            : client.getItem(owner, name, number),
      };
    };
  }

  it('should retain a denied preparation across occurrences and start an unrelated issue', async () => {
    const first = await next();
    await addPendingSecondIssue();
    Object.assign(deps.native!, {
      intakeDenial: async (record: { id: string }) =>
        record.id === first.id
          ? {
              sourceThreadId: 'intake-thread',
              turnId: 'denied-turn',
              callId: 'denied-prepare',
              operation: 'prepare',
              automatic: true,
              reason: 'Repository permission denied.',
            }
          : undefined,
    });
    // the host ended the occurrence before any post-denial tracking command could run.
    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    const second = await next();
    assert.equal(second.status, 'routing-required');
    assert.notEqual(second.id, first.id);
    const records = (await readDispatchState()).records as { id: string; denial?: unknown }[];
    assert.ok(records.find((record) => record.id === first.id)!.denial);
    const prepared = await request('prepare', {
      id: second.id,
      digest: second.digest,
      title: 'repair unrelated issue',
      assessment: { complexity: 'medium', reason: 'Contained.' },
    });
    assert.equal(prepared.status, 'prepared');
    created();
    await request('reconcile', { id: second.id, receipt: { threadId: native!.id } });
    assert.equal((await next()).status, 'idle');
    const response = String((await report()).response);
    assert.ok(response.includes('owner/repo#3'));
    assert.ok(response.includes('[owner/repo#4](codex://threads/issue-thread)'));
    assert.match(response, /Repository permission denied/);
    assert.match(response, /retry-denied/);
    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    assert.equal((await next()).status, 'idle');
    assert.ok(String((await report()).response).includes('DONT_NOTIFY'));
    await reassign();
    assert.equal((await next()).status, 'idle');
    const operator = { threadId: 'operator' };
    await assert.rejects(request('retry-denied', { id: first.id }, operator), /approval-required/);
    const preview = await request(
      'retry-denied',
      { id: first.id, approvedCallId: 'denied-prepare' },
      operator,
    );
    await assert.rejects(
      request(
        'retry-denied',
        { id: first.id, approvedCallId: 'denied-prepare', digest: 'stale' },
        operator,
      ),
      /recovery-stale/,
    );
    assert.equal(
      (
        await request(
          'retry-denied',
          { id: first.id, approvedCallId: 'denied-prepare', digest: preview.digest },
          operator,
        )
      ).status,
      'retry-ready',
    );
    Object.assign(deps.native!, { intakeDenial: async () => undefined });
    assert.equal((await next()).id, first.id);
  });

  it('should reconcile a current occurrence refusal without repeating preparation', async () => {
    const first = await next();
    await addPendingSecondIssue();
    deps.native!.intakeDenial = async (record) =>
      record.id === first.id
        ? {
            sourceThreadId: 'intake-thread',
            turnId: 'denied-turn',
            callId: 'refused',
            operation: 'prepare',
            automatic: false,
          }
        : undefined;
    const reconciled = await request('reconcile', { id: first.id });
    assert.equal(reconciled.nextAction, 'next');
    assert.equal(reconciled.status, 'blocked');
    const held = await request('prepare', {
      id: first.id,
      digest: first.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Contained.' },
    });
    assert.equal(held.status, 'blocked');
    assert.notEqual((await next()).id, first.id);
    const retained = (
      (await readDispatchState()).records as { request?: unknown; denial?: unknown }[]
    )[0]!;
    assert.equal(retained.request, undefined);
    assert.ok(retained.denial);
  });

  it('should release only a verified denied creation reservation and keep its request', async () => {
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        github: {
          ...manifest.github,
          'max-concurrent-items': 1,
        },
      }),
    );
    const first = await prepare();
    await addPendingSecondIssue();
    await next();
    assert.equal((await next()).status, 'at-capacity');
    deps.native!.intakeDenial = async (record) =>
      record.id === first.id
        ? {
            sourceThreadId: 'intake-thread',
            turnId: 'denied-turn',
            callId: 'denied-call',
            operation: 'create',
            automatic: false,
          }
        : undefined;
    const second = await next();
    assert.equal(second.status, 'routing-required');
    assert.notEqual(second.id, first.id);
    const retained = (
      (await readDispatchState()).records as { request: unknown; denial?: { operation: string } }[]
    )[0]!;
    assert.deepEqual(retained.request, first.request);
    assert.equal(retained.denial!.operation, 'create');
    const operator = { threadId: 'operator' };
    const preview = await request('retry-denied', { id: first.id }, operator);
    assert.equal(
      (await request('retry-denied', { id: first.id, digest: preview.digest }, operator)).status,
      'retry-ready',
    );
  });

  for (const code of ['dispatch-denial-scope-unresolved'])
    it('should stop unrelated intake on ' + code, async () => {
      const first = await next();
      await addPendingSecondIssue();
      deps.native!.intakeDenial = async () => {
        throw new Error(code);
      };
      const stopped = await next();
      assert.equal(stopped.nextAction, 'report');
      assert.equal(stopped.code, code);
      now += 300001;
      await runCodexIntake(pluginData, false, deps);
      assert.equal((await next()).nextAction, 'report');
      const records = (await readDispatchState()).records as { id: string; request?: unknown }[];
      assert.equal(records.length, 1);
      assert.equal(records[0]!.id, first.id);
      assert.equal(records[0]!.request, undefined);
    });

  for (const code of [
    'dispatch-denial-history-unavailable',
    'dispatch-denial-execution-unresolved',
  ])
    it('should hold only the task with ' + code + ' and keep its reservation', async () => {
      const first = await prepare();
      await addPendingSecondIssue();
      deps.native!.intakeDenial = async (record) => {
        if (record.id === first.id) throw new Error(code);
        return undefined;
      };
      assert.equal((await request('observe-denials')).status, 'ready');
      const second = await next();
      assert.equal(second.status, 'routing-required', JSON.stringify(second));
      assert.notEqual(second.id, first.id);
      const held = ((await readDispatchState()).records as DispatchRecord[]).find(
        (r) => r.id === first.id,
      )!;
      assert.equal(held.result?.outcome === 'operator-setup-blocker' && held.result.code, code);
      assert.deepEqual(held.request, first.request);
      assert.equal(held.denial, undefined);
    });

  it('should stop on shared authentication but continue past a repository permission failure', async () => {
    await addPendingSecondIssue();
    const connect = deps.connect!;
    for (const classification of ['permission', 'authentication'] as const) {
      deps.connect = async (...args) => {
        const client = await connect(...args);
        return {
          ...client,
          getItemContext: async () => {
            throw Object.assign(new Error('provider-unavailable'), {
              providerDiagnostic: providerDiagnostic('github', 'api-request', classification),
            });
          },
        };
      };
      const failed = await next();
      assert.equal(failed.nextAction, classification === 'permission' ? 'next' : 'report');
    }
  });

  it('should not guess missing native anchors for a legacy routing attempt', async () => {
    const first = await next();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.preparationObservation;
      await save();
    });
    const blocked = await next();
    assert.notEqual(blocked.nextAction, 'report');
    const held = ((await readDispatchState()).records as DispatchRecord[]).find(
      (r) => r.id === first.id,
    )!;
    assert.equal(
      held.result?.outcome === 'operator-setup-blocker' && held.result.code,
      'dispatch-denial-history-unavailable',
    );
    assert.equal(held.preparationObservation, undefined);
  });

  it('should keep a denied preparation through coordinator replacement and exact operator recovery', async () => {
    const first = await next();
    const denial = {
      sourceThreadId: 'intake-thread',
      turnId: 'denied-turn',
      callId: 'refused',
      operation: 'prepare' as const,
      automatic: true,
    };
    deps.native!.intakeDenial = async () => denial;
    deps.activation = async () => ({ sourceThreadId: 'replacement' });
    deps.threadId = 'replacement';
    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    assert.equal((await next()).status, 'idle');
    await assert.rejects(
      request('retry-denied', { id: first.id, approvedCallId: 'refused' }),
      /operator-caller-required/,
    );
    const operator = { threadId: 'operator' };
    const preview = await request(
      'retry-denied',
      { id: first.id, approvedCallId: 'refused' },
      operator,
    );
    deps.native!.intakeDenial = async () => undefined;
    await assert.rejects(
      request(
        'retry-denied',
        { id: first.id, approvedCallId: 'refused', digest: preview.digest },
        operator,
      ),
      /denial-unverified/,
    );
    deps.native!.intakeDenial = async () => denial;
    await request(
      'retry-denied',
      { id: first.id, approvedCallId: 'refused', digest: preview.digest },
      operator,
    );
    const current = await selectCodexIntake(pluginData, deps);
    const restored = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const record = (await restored.read()).records[0]!;
    assert.equal(record.denial, undefined);
    assert.equal(record.recoveredDenials![0]!.denial.sourceThreadId, 'intake-thread');
  });

  it('should retry a verified denial only through a fresh operator recovery preview', async () => {
    const first = await prepare();
    const operator = {
      threadId: 'operator',
      activation: async (_data: string, _deps: unknown, paused?: boolean) => {
        assert.equal(paused, true);
        return { sourceThreadId: 'intake-thread' };
      },
    };
    await assert.rejects(
      request('retry-denied', { id: first.id }),
      /dispatch-operator-caller-required/,
    );
    const preview = await request('retry-denied', { id: first.id }, operator);
    assert.equal(preview.status, 'retry-available');
    await assert.rejects(
      request('retry-denied', { id: first.id, digest: 'stale' }, operator),
      /dispatch-recovery-stale/,
    );
    assert.equal(
      (await request('retry-denied', { id: first.id, digest: preview.digest }, operator)).status,
      'retry-ready',
    );
    await assert.rejects(
      request('retry-denied', { id: first.id, digest: preview.digest }, operator),
      /dispatch-denial-unverified/,
    );
    const second = await prepare();
    assert.equal(second.id, first.id);
    assert.notEqual(
      (second.request as { prompt: string }).prompt,
      (first.request as { prompt: string }).prompt,
    );
    const state = await readDispatchState();
    assert.deepEqual((state.records as { deniedCreations: unknown[] }[])[0]!.deniedCreations[0], {
      request: first.request,
      createdAt: now,
      recoveredAt: now,
      turnId: 'denied-turn',
      callId: 'denied-call',
    });
    for (let attempt = 1; attempt < 10; attempt++) {
      now += 300000;
      await runCodexIntake(pluginData, false, deps);
      const retry = await request('retry-denied', { id: first.id }, operator);
      assert.equal(retry.status, 'retry-available');
      await request('retry-denied', { id: first.id, digest: retry.digest }, operator);
      await prepare();
    }
    const retained = (await readDispatchState()).records as { deniedCreations: unknown[] }[];
    assert.equal(retained[0]!.deniedCreations.length, 10);
  });

  it('should allow verified operator recovery from an unrelated managed task chat', async () => {
    const first = await prepare();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records.push({
        ...structuredClone(state.records[0]!),
        id: 'b'.repeat(64),
        issueKey: 'c'.repeat(64),
        sourceThreadId: 'operator',
        threadId: 'operator',
      });
      await save();
    });
    const unrelated = structuredClone((await store.read()).records[1]);
    const input = { id: first.id, apply: true, renewAuthorization: true };
    await assert.rejects(
      request('retry-denied', input, {
        threadId: 'operator',
        native: {
          ...deps.native!,
          operatorInput: async () => {
            throw new Error('reply-native-user-input-required');
          },
        },
      }),
      /reply-native-user-input-required/,
    );
    assert.equal(
      (await request('retry-denied', input, { threadId: 'operator' })).status,
      'retry-ready',
    );
    const state = await store.read();
    assert.equal(state.records[0]!.deniedCreations?.at(-1)?.approvedBy, 'operator');
    assert.deepEqual(state.records[1], unrelated);
  });

  it('should recover an explicitly approved denied request after reassignment without retaining its waiting continuation', async () => {
    const first = await prepare();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.continuation = {
        phase: 'waiting',
        policyDigest: 'a'.repeat(64),
        selection: record.assessment!,
      };
      await save();
    });
    await reassign();
    deps.native!.deniedCreation = async (
      _source,
      expected,
      prepared,
      approvedCallId,
      renewAuthorization,
    ) => {
      assert.deepEqual(expected, first.request);
      assert.ok(prepared.turnId);
      if (!renewAuthorization && approvedCallId !== 'denied-call')
        throw new Error('dispatch-denial-approval-required');
      return { turnId: 'denied-turn', callId: 'denied-call' };
    };
    const operator = { threadId: 'operator' };
    await assert.rejects(
      request('retry-denied', { id: first.id }, operator),
      /dispatch-denial-approval-required/,
    );
    const input = { id: first.id, approvedCallId: 'denied-call' };
    const preview = await request('retry-denied', input, operator);
    fixture.item.state = 'closed';
    await assert.rejects(
      request('retry-denied', { ...input, digest: preview.digest }, operator),
      /dispatch-issue-closed/,
    );
    fixture.item.state = 'open';
    assert.equal(
      (
        await request(
          'retry-denied',
          { id: first.id, apply: true, renewAuthorization: true },
          operator,
        )
      ).status,
      'retry-ready',
    );
    const retained = (await store.read()).records[0]!;
    assert.equal(retained.continuation, undefined);
    assert.equal(retained.preparationTurnId, undefined);
    assert.deepEqual(retained.deniedCreations?.[0]?.request, first.request);
    assert.equal(retained.deniedCreations?.[0]?.approvedBy, 'operator');
    assert.equal(retained.deniedCreations?.[0]?.continuation?.phase, 'waiting');
    const successor = await prepare();
    assert.equal(successor.id, first.id);
    assert.notDeepEqual(successor.request, first.request);
  });

  it('should preserve uncertain or already created requests during operator recovery', async () => {
    const first = await prepare();
    const operator = { threadId: 'operator' };
    await assert.rejects(
      request(
        'retry-denied',
        { id: first.id },
        {
          ...operator,
          native: {
            ...deps.native!,
            async deniedCreation() {
              throw new Error('dispatch-denial-unverified');
            },
          },
        },
      ),
      /dispatch-denial-unverified/,
    );
    created();
    await assert.rejects(
      request('retry-denied', { id: first.id }, operator),
      /dispatch-denial-unverified/,
    );
    native = undefined;
    await request('reconcile', {
      id: first.id,
      receipt: { clientThreadId: 'pending-native-creation' },
    });
    await assert.rejects(
      request('retry-denied', { id: first.id }, operator),
      /dispatch-denial-unverified/,
    );
    const state = await readDispatchState();
    assert.deepEqual((state.records as { request: unknown }[])[0]!.request, first.request);
  });

  it('should inspect without host access and require activation and the owning intake caller', async () => {
    const unavailable = {
      connect: async () => {
        throw new Error('unexpected provider read');
      },
      activation: async () => {
        throw new Error('dispatch-activation-required');
      },
    };
    assert.deepEqual((await request('inspect', {}, unavailable)).records, []);
    await assert.rejects(
      request('next', { projects }, unavailable),
      /dispatch-activation-required/,
    );
    await assert.rejects(
      request('next', { projects }, { threadId: 'other-chat' }),
      /(?:dispatch-intake|feedback-schedule)-caller-required/,
    );
    assert.equal(gitCalls.length, 0);
  });

  it('should reject malformed project inventories without retaining a task failure', async () => {
    deps.prepareRepository = async () => assert.fail('invalid input must not prepare a checkout');
    deps.connect = async () => assert.fail('invalid input must not read assignments or claim work');
    for (const projects of [undefined, {}, Array(1001).fill(null)]) {
      await assert.rejects(request('next', { projects }), /dispatch-project-inventory-invalid/);
      assert.deepEqual((await readDispatchState()).records, []);
      assert.equal(gitCalls.length, 0);
    }
  });

  it('should recover a retained inventory error with valid input and preserve its identity', async () => {
    const selected = await next();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      delete record.project;
      delete record.context;
      delete record.preparationObservation;
      record.phase = 'waiting';
      record.result = {
        version: 1,
        outcome: 'operator-setup-blocker',
        code: 'dispatch-project-inventory-invalid',
        summary: 'The issue assessment needs setup or recovery.',
        remediation: 'Register the project.',
        evidence: [],
        progress: { completed: [], remaining: [] },
      };
      await save();
    });
    const previous = (await store.read()).records;
    await assert.rejects(request('next'), /dispatch-project-inventory-invalid/);
    const afterInvalid = (await store.read()).records;
    assert.equal(afterInvalid.length, 1);
    assert.equal(afterInvalid[0]!.id, previous[0]!.id);
    assert.equal(afterInvalid[0]!.phase, previous[0]!.phase);
    assert.deepEqual(afterInvalid[0]!.result, previous[0]!.result);
    assert.equal(afterInvalid[0]!.request, undefined);
    const resumed = await next();
    assert.equal(resumed.status, 'routing-required');
    assert.equal(resumed.id, selected.id);
    const records = (await store.read()).records;
    assert.equal(records.length, 1);
    assert.equal(records[0]!.result, undefined);
    assert.equal(records[0]!.request, undefined);
  });

  it('should retain one quiet setup blocker and resume the same assignment after project setup', async () => {
    projects = [];
    const blocked = await next();
    assert.equal(blocked.code, 'dispatch-project-registration-unavailable');
    assert.equal(blocked.changed, true);
    assert.match(String(blocked.message), /^> ## ⚠️ Add the project to continue\n/u);
    assert.ok(String(blocked.message).includes('- **Project name:** `repo`\n'));
    assert.ok(
      String(blocked.message).includes(
        '- **Folder path:** ' + githubNotificationMarkdownCode(source) + '\n',
      ),
    );
    assert.match(String(blocked.message), /https:\/\/github.com\/owner\/repo\/issues\/3/u);
    assert.match(String(blocked.message), /primary folder/u);
    now += 300001;
    assert.equal((await next()).changed, false);
    projects = [
      {
        projectId: 'saved-project',
        path: source,
        projectKind: 'local',
        hostId: 'local',
        isGitRepository: true,
      },
    ];
    now += 300001;
    const resumed = await next();
    assert.equal(resumed.status, 'routing-required');
    assert.equal(resumed.id, blocked.id);
  });

  for (const managed of [true, false]) {
    for (const broken of [true, false]) {
      it(`should prepare only owned saved base checkouts when ${managed ? 'managed' : 'external'} and ${broken ? 'bare-configured' : 'healthy'}`, async () => {
        if (managed) {
          source = join(
            workspace,
            '.agent-system',
            'worktrees',
            gitWorktreeRepositoryDirectoryName('github-10').replace(/\.git$/u, ''),
            'codex-project',
          );
          await mkdir(source, { recursive: true });
          Object.assign(projects[0]!, { path: source });
        }
        let preparations = 0;
        const prepareRepository = deps.prepareRepository!;
        deps.prepareRepository = async (...args) => {
          preparations++;
          return prepareRepository(...args);
        };
        const git = deps.git!;
        deps.git = async (cwd, argv, signal) =>
          broken && preparations === 0 && argv.includes('--is-bare-repository')
            ? 'true'
            : git(cwd, argv, signal);
        const result = await next();
        assert.equal(preparations, managed ? 1 : 0);
        assert.equal(result.status, broken && !managed ? 'waiting' : 'routing-required');
        if (broken && !managed) assert.equal(result.code, 'dispatch-project-workspace-required');
      });
    }
  }

  it('should give the exact retained location and mapping key for configuration recovery', async () => {
    projects = [];
    deps.prepareRepository = async (input) => {
      throw new RepositoryPreparationError(
        'repository-preparation-changed',
        source,
        'github.com/' + input.repository,
      );
    };
    const blocked = await next();
    assert.equal(blocked.code, 'repository-preparation-changed');
    assert.ok(String(blocked.message).includes('git.worktrees.repositories.local.github-10'));
    assert.ok(String(blocked.message).includes(githubNotificationMarkdownCode(source)));
    assert.match(String(blocked.message), /Verify the retained checkout/u);
    assert.doesNotMatch(String(blocked.message), /Reconcile through Install/u);
    assert.match(String(blocked.message), /do not delete/u);
    assert.equal(gitCalls.length, 0);
  });

  it('should honor a configured directory instead of using another saved checkout', async () => {
    const path = join(root, 'checkouts', 'repo');
    await mkdir(path, { recursive: true });
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({
        ...manifest,
        git: { worktrees: { repositories: { 'working-directory': '../checkouts' } } },
      }),
    );
    let preparations = 0;
    deps.prepareRepository = async (input, dependencies) => {
      preparations++;
      assert.equal(input.configuration.repositories?.workingDirectory, '../checkouts');
      await dependencies.authorize();
      await dependencies.retain({
        path,
        source: 'https://github.com/owner/repo.git',
        identity: 'github.com/owner/repo',
        checkout: path,
      });
      return path;
    };
    const blocked = await next();
    assert.equal(blocked.code, 'dispatch-project-registration-unavailable');
    assert.ok(String(blocked.message).includes(githubNotificationMarkdownCode(path)));
    assert.equal(preparations, 1);
    assert.ok(!gitCalls.some((argv) => argv[0] === 'fetch'));
  });

  it('should emit one exact launch and recover uncertain creation instead of issuing another', async () => {
    const prepared = await prepare();
    const launch = prepared.request as {
      prompt: string;
      model: string;
      thinking: string;
      target: { projectId: string; environment: { startingState: { branchName: string } } };
    };
    assert.equal(launch.model, 'gpt-6.1-sol');
    assert.equal(launch.thinking, 'high');
    assert.equal(launch.target.projectId, 'saved-project');
    assert.equal(launch.target.environment.startingState.branchName, commit);
    assert.ok(!launch.prompt.includes('The acceptance criteria require a safe plan.'));
    const retry = await request('prepare', {
      id: prepared.id,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Same request.' },
    });
    assert.equal(retry.status, 'reconcile-required');
    const uncertain = await request('reconcile', {
      id: prepared.id,
      receipt: { clientThreadId: 'pending-client', hostId: 'local' },
    });
    assert.equal(uncertain.status, 'creating');
    assert.equal(uncertain.changed, false);
    assert.equal(uncertain.code, undefined);
    created();
    now += 300001;
    const recovered = await next();
    assert.equal(recovered.status, 'assessing');
    assert.equal(recovered.threadId, 'issue-thread');
    const retained = await request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    assert.deepEqual(retained.evidence, { source: 'https://github.com/owner/repo/issues/3' });
    const records = (await readDispatchState()).records as {
      clientThreadId: string;
      threadId: string;
      effective: { status: string };
    }[];
    assert.equal(records.length, 1);
    assert.equal(records[0]!.clientThreadId, 'pending-client');
    assert.equal(records[0]!.effective.status, 'verified');
  });

  it('should bound pending worktree setup without repeating native creation', async () => {
    const prepared = await prepare();
    const pending = await request('reconcile', {
      id: prepared.id,
      receipt: { clientThreadId: 'pending-client', hostId: 'local' },
    });
    assert.equal(pending.status, 'creating');
    assert.equal(pending.changed, false);
    assert.equal((await next()).changed, false);
    now += 300000;
    const expired = await next();
    assert.equal(expired.code, 'dispatch-creation-unresolved');
    assert.equal(expired.changed, true);
    now += 300001;
    assert.equal((await next()).changed, false);
    const state = await readDispatchState();
    assert.deepEqual((state.records as { request: unknown }[])[0]!.request, prepared.request);
  });

  it('should report unknown creation outcomes immediately without a pending receipt', async () => {
    const prepared = await prepare();
    const unknown = await request('reconcile', { id: prepared.id });
    assert.equal(unknown.code, 'dispatch-creation-unresolved');
    assert.equal(unknown.changed, true);
  });

  it('should rearm an unsubmitted creation only on a later verified occurrence', async () => {
    const preparedAt = now;
    const prepared = await prepare();
    assert.equal(prepared.recovery, undefined);
    await request('reconcile', { id: prepared.id });
    assert.equal((await next()).changed, false);
    now += 300001;
    deps.native!.unsubmittedCreation = async (threadId, pending, turnId) => {
      assert.equal(threadId, 'intake-thread');
      assert.deepEqual(pending, {
        createdAt: preparedAt,
        turnId: 'run-' + preparedAt,
        prompt: (prepared.request as { prompt: string }).prompt,
      });
      assert.equal(turnId, 'run-' + now);
      return { turnId: 'run-' + preparedAt };
    };
    const retry = await prepare();
    assert.equal(retry.id, prepared.id);
    const recovery = retry.recovery as {
      status: string;
      previousAttempt: { turnId: string; createdAt: number; recoveredAt: number };
    };
    assert.equal(recovery.status, 'verified-unsubmitted');
    assert.deepEqual(recovery.previousAttempt, {
      turnId: 'run-' + preparedAt,
      createdAt: preparedAt,
      recoveredAt: now,
    });
    const original = prepared.request as { prompt: string; model: string; thinking: string };
    const replacement = retry.request as typeof original;
    assert.notEqual(replacement.prompt, original.prompt);
    assert.equal(replacement.model, original.model);
    assert.equal(replacement.thinking, original.thinking);
    const record = ((await readDispatchState()).records as Record<string, unknown>[])[0]!;
    assert.deepEqual(record.unsubmittedCreations, [
      {
        request: prepared.request,
        createdAt: preparedAt,
        recoveredAt: now,
        turnId: 'run-' + preparedAt,
      },
    ]);
    assert.equal(record.result, undefined);
    assert.equal(
      (
        await request('prepare', {
          id: prepared.id,
          title: 'repair contained behavior',
          assessment: { complexity: 'medium', reason: 'Same request.' },
        })
      ).status,
      'reconcile-required',
    );
    created();
    assert.equal((await request('reconcile', { id: retry.id })).status, 'assessing');
  });

  it('should preserve an uncertain request when absence cannot be proved', async () => {
    const prepared = await prepare();
    await request('reconcile', { id: prepared.id });
    now += 300001;
    assert.equal((await next()).code, 'dispatch-creation-unresolved');
    const record = ((await readDispatchState()).records as Record<string, unknown>[])[0]!;
    assert.deepEqual(record.request, prepared.request);
    assert.equal(record.unsubmittedCreations, undefined);
  });

  it('should preserve native denials during automatic creation recovery', async () => {
    const prepared = await prepare();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records[0]!.phase = 'blocked';
      state.records[0]!.result = {
        version: 1,
        outcome: 'operator-setup-blocker',
        code: 'dispatch-creation-denied',
        summary: 'Denied.',
        remediation: 'Stop.',
        evidence: [],
        progress: { completed: [], remaining: [] },
      };
      await save();
    });
    await reassign();
    deps.native!.unsubmittedCreation = async () => {
      assert.fail('a denial requires operator recovery');
    };
    assert.equal((await next()).status, 'idle');
    assert.deepEqual((await store.read()).records[0]!.request, prepared.request);
  });
  it('should reconcile a retired current creation through native reads without changing its request', async () => {
    const prepared = await prepare();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records[0]!.retired = { at: now, by: 'old-operator' };
      await save();
    });
    deps.native!.unsubmittedCreation = async () => ({ turnId: 'original-preparation' });
    const observed = await request('reconcile', { id: prepared.id });
    assert.equal(observed.status, 'inactive');
    const record = (await store.read()).records[0]!;
    assert.deepEqual(record.request, prepared.request);
    assert.ok(record.retired);
    assert.equal(record.capacityObservation?.code, 'dispatch-capacity-never-submitted');
  });
  it('should reconcile a superseded unsubmitted request before preparing its successor', async () => {
    const prepared = await prepare();
    await reassign();
    deps.native!.unsubmittedCreation = async () => ({ turnId: 'completed-original-turn' });
    const successor = await prepare();
    assert.equal(successor.id, prepared.id);
    assert.notDeepEqual(successor.request, prepared.request);
    const retained = ((await readDispatchState()).records as Record<string, unknown>[])[0]!;
    assert.equal((retained.unsubmittedCreations as unknown[]).length, 1);
    assert.equal(retained.phase, 'creating');
  });
  it('should preserve a superseded request when its native outcome is unknown', async () => {
    const prepared = await prepare();
    await reassign();
    assert.equal((await next()).code, 'dispatch-assignment-superseded');
    const retained = ((await readDispatchState()).records as Record<string, unknown>[])[0]!;
    assert.deepEqual(retained.request, prepared.request);
    assert.equal(retained.unsubmittedCreations, undefined);
  });
  it('should continue the occurrence after an item-specific failure instead of ending the report loop', async () => {
    await prepare();
    await reassign();
    const failed = await next();
    assert.equal(failed.nextAction, 'next');
    const state = await readDispatchState();
    assert.equal((state.run as { stopped?: string }).stopped, undefined);
    assert.equal((await next()).status, 'idle');
  });
  it('should recover a superseded native creation without issuing another request', async () => {
    const prepared = await prepare();
    created();
    await reassign();
    assert.equal((await next()).status, 'blocked');
    const retained = ((await readDispatchState()).records as Record<string, unknown>[])[0]!;
    assert.deepEqual(retained.request, prepared.request);
    assert.equal(retained.threadId, 'issue-thread');
    assert.equal((retained.result as { code: string }).code, 'dispatch-assignment-superseded');
    assert.equal(retained.unsubmittedCreations, undefined);
  });

  it('should never rearm pending native worktree receipts', async () => {
    const prepared = await prepare();
    await request('reconcile', { id: prepared.id, receipt: { clientThreadId: 'pending' } });
    deps.native!.unsubmittedCreation = async () => {
      assert.fail('a native receipt must preclude automatic rearming');
    };
    now += 300001;
    assert.equal((await next()).code, 'dispatch-creation-unresolved');
  });

  it('should recover proven unsubmitted creations beyond the former lifetime limit', async () => {
    let prepared = await prepare();
    deps.native!.unsubmittedCreation = async () => ({ turnId: 'completed-turn' });
    for (let count = 0; count < 9; count++) {
      await request('reconcile', { id: prepared.id });
      now += 300001;
      prepared = await prepare();
      assert.equal(prepared.status, 'prepared');
    }
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    assert.equal((await store.read()).records[0]!.unsubmittedCreations?.length, 9);
  });

  for (const key of ['threadId', 'clientThreadId'] as const) {
    it(
      'should reject reused ' +
        key.toLowerCase() +
        ' from a retired assessment without retaining partial receipts',
      async () => {
        const first = await prepare();
        await request('reconcile', { id: first.id, receipt: { [key]: 'old-native-receipt' } });
        fixture.item.state = 'closed';
        const selected = await selectCodexIntake(pluginData, deps);
        const store = new CodexDispatchStore(
          selected.store.location.root,
          selected.store.location.scope,
        );
        await store.exclusive(async (state, save) => {
          state.records[0]!.retired = { at: now, by: 'intake-thread' };
          await save();
        });
        created();
        native!.id = 'old-native-receipt';
        native!.status = 'idle';
        native!.turnEnded = true;
        await request('reconcile', { id: first.id });
        native = undefined;
        const before = ((await readDispatchState()).records as Record<string, unknown>[])[0];
        fixture.item.state = 'open';
        await reassign();
        const second = await prepare();
        const blocked = await request('reconcile', {
          id: second.id,
          receipt: { threadId: 'fresh-native-receipt', clientThreadId: 'old-native-receipt' },
        });
        assert.equal(blocked.code, 'dispatch-native-receipt-reused');
        assert.equal(blocked.status, 'blocked');
        const records = (await readDispatchState()).records as Record<string, unknown>[];
        assert.deepEqual(records[0], before);
        assert.equal(records[1]!.receiptThreadId, undefined);
        assert.equal(records[1]!.clientThreadId, undefined);
        assert.deepEqual(records[1]!.request, second.request);
        created();
        assert.equal((await request('reconcile', { id: second.id })).status, 'assessing');
      },
    );
  }

  it('should format results only for the verified child without saving or freezing plans', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id });
    const child = { threadId: native!.id };
    await request('context', { id: prepared.id }, child);
    await assert.rejects(
      request('result', { id: prepared.id, result }, { threadId: 'other-chat' }),
      /dispatch-assessment-caller-mismatch/,
    );
    await assert.rejects(
      request('result', { id: prepared.id, result: 'invalid' }, child),
      /assessment-result-invalid/,
    );
    for (const plan of ['Initial plan.', 'Current revised plan.']) {
      const formatted = await request(
        'result',
        { id: prepared.id, result: { ...result, plan } },
        child,
      );
      assert.equal(formatted.status, 'formatted');
      assert.equal(formatted.retained, false);
      assert.equal('assessment' in formatted, false);
    }
    const saved = ((await readDispatchState()).records as DispatchRecord[])[0]!;
    assert.equal(saved.result, undefined);
    assert.equal(saved.stageReceipt, undefined);
    assert.equal(saved.resultTurnId, undefined);
  });

  it('should retain and present questions and setup obstacles without changing routing', async () => {
    const prepared = await prepare();
    created();
    delete native!.model;
    delete native!.effort;
    const child = { threadId: 'issue-thread' };
    const common = {
      version: 1,
      summary: 'Additional input is needed.',
      fullAssessment: 'Complete partial assessment and next action.',
      evidence: result.evidence,
      progress: result.progress,
    };
    for (const outcome of [
      {
        ...common,
        outcome: 'clarification-needed',
        assessment: 'Retention is unspecified.',
        questions: ['How long should evidence remain?'],
      },
      {
        ...common,
        outcome: 'operator-setup-blocker',
        code: 'source-unavailable',
        remediation: 'Restore access to the required source.',
      },
    ]) {
      native!.turnId = outcome.outcome;
      const prior = await request('context', { id: prepared.id }, child);
      const recorded = await request(
        'result',
        {
          id: prepared.id,
          previousResultDigest: prior.previousResultDigest,
          result: outcome,
        },
        child,
      );
      assert.equal(recorded.status, 'formatted');
      assert.ok(
        String(recorded.presentation).includes(
          'questions' in outcome ? outcome.questions[0]! : outcome.remediation,
        ),
      );
      const resumed = await request('context', { id: prepared.id }, child);
      assert.equal(resumed.previousResult, undefined);
    }
  });

  it('should retain completed results when later reconciliation fails', async () => {
    const prepared = await prepare();
    created();
    await historicalResult('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
    const completed = await readDispatchState();
    fixture.item.state = 'closed';
    await assert.rejects(request('reconcile', { id: prepared.id }), /dispatch-issue-closed/);
    assert.deepEqual({ ...(await readDispatchState()), run: completed.run }, completed);
    assert.deepEqual(await next(), { status: 'idle', changed: false });
  });

  for (const relocation of [
    'same repository',
    'foreign repository',
    'project root',
    'shared checkout',
  ] as const) {
    it(`should reconcile closed task checkout ownership before native cleanup: ${relocation}`, async () => {
      const prepared = await prepare();
      created();
      await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
      const moved = relocation === 'project root' ? source : join(root, 'moved-checkout');
      if (moved !== source) await mkdir(moved);
      native!.cwd = moved;
      native!.status = 'idle';
      native!.turnEnded = true;
      fixture.item.state = 'closed';
      await writeCleanup(0);
      now += 60_000;
      const git = deps.git!;
      deps.git = async (path, args) =>
        relocation === 'foreign repository' && path === moved && args[0] === 'remote'
          ? 'https://github.com/other/repo.git'
          : git(path, args);
      deps.retirementNative = {
        worktreeUsers: async (path) => {
          assert.equal(path, moved);
          return relocation === 'shared checkout'
            ? ['issue-thread', 'unrelated']
            : ['issue-thread'];
        },
        archiveOutcome: async () => 'unverified',
      };
      const threads = {
        schemaVersion: 4,
        pinnedThreads: [],
        unavailableHosts: [],
        unavailableSources: [],
      };
      const attempt = await request('next', { projects, threads });
      const record = async () => ((await readDispatchState()).records as DispatchRecord[])[0]!;
      if (relocation !== 'same repository') {
        assert.notEqual(attempt.status, 'retirement-prepared');
        assert.equal((await record()).retirement?.archiveAttempt, undefined);
        assert.equal((await record()).retired, undefined);
        return;
      }
      assert.equal(attempt.status, 'retirement-prepared');
      assert.deepEqual(attempt.request, {
        threadId: 'issue-thread',
        hostId: 'local',
        archived: true,
      });
      assert.equal((await record()).worktree, moved);
      assert.equal((await record()).result, undefined);
      native!.archived = true;
      native!.cwd = source;
      await next();
      assert.equal((await record()).retirement?.code, 'retirement-native-reclamation-pending');
      await rm(moved, { recursive: true });
      await next();
      assert.ok((await record()).retired);
      assert.ok(!gitCalls.some((args) => args.includes('remove')));
    });
  }

  for (const reason of ['closure', 'closure after removal', 'operator request'] as const) {
    it(`should prepare native archival during intake and retire only after observed reclamation: ${reason}`, async () => {
      worktree = join(codexHome, 'worktrees', 'retiring', 'repo');
      await mkdir(worktree, { recursive: true });
      const prepared = await prepare();
      created();
      await historicalResult('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
      native!.status = 'idle';
      native!.turnEnded = true;
      if (reason === 'closure') fixture.item.state = 'closed';
      else if (reason === 'closure after removal') {
        removeFixtureAssignment(fixture);
        now += 60_000;
        await next();
        const held = await request('inspect');
        assert.equal(
          (held.records as { workflowStatus: string }[])[0]!.workflowStatus,
          'awaiting-reassignment',
        );
        fixture.item.state = 'closed';
      }
      if (reason !== 'operator request') {
        now += 60_000;
        await next();
      }
      const current = await selectCodexIntake(pluginData, deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      if (reason !== 'operator request')
        now = (await store.read()).records[0]!.retirement!.eligibleAt;
      const git = deps.git!;
      deps.git = async (path, args) =>
        args[0] === 'for-each-ref' ? 'refs/heads/preserved' : git(path, args);
      deps.retirementNative = {
        worktreeUsers: async () => ['issue-thread'],
        archiveOutcome: async () => 'unverified',
      };
      const threads = {
        schemaVersion: 4,
        pinnedThreads: [],
        unavailableHosts: [],
        unavailableSources: [],
      };
      const operator = { threadId: 'operator' };
      const preview =
        reason === 'operator request'
          ? await request('retire', { id: prepared.id }, operator)
          : undefined;
      const archived = preview
        ? await request('retire', { id: prepared.id, digest: preview.digest, threads }, operator)
        : await request('next', { projects, threads });
      if (preview) {
        assert.equal(fixture.item.state, 'open');
        assert.equal((await store.read()).records[0]!.retirement!.eligibleAt, now);
        assert.equal(
          (await store.read()).records[0]!.retirement!.archiveAttempt!.sourceThreadId,
          'operator',
        );
      }
      assert.equal(archived.status, 'retirement-prepared');
      assert.deepEqual(archived.request, {
        threadId: 'issue-thread',
        hostId: 'local',
        archived: true,
      });
      assert.equal((await store.read()).records[0]!.retired, undefined);
      native!.archived = true;
      await next();
      assert.equal(
        (await store.read()).records[0]!.retirement?.code,
        'retirement-native-reclamation-pending',
      );
      assert.equal((await store.read()).records[0]!.retired, undefined);
      await rm(worktree, { recursive: true });
      await next();
      const retired = (await store.read()).records[0]!;
      assert.equal(retired.retired?.at, now);
      assert.equal(retired.retainedHistory?.outcome?.assessment, result.outcome);
      assert.equal(retired.result, undefined);
      if (reason === 'operator request') {
        assert.equal((await request('retire', { id: prepared.id }, operator)).status, 'retired');
        await assert.rejects(
          store.exclusive(async (state, save) => {
            delete state.records[0]!.retirement!.archivedAt;
            await save();
          }),
          /dispatch-state-invalid/,
        );
      }
    });
  }

  it('should retain unassigned codex work without requesting native cleanup', async () => {
    const prepared = await prepare();
    created();
    await historicalResult('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
    native!.status = 'idle';
    native!.turnEnded = true;
    await writeFile(join(worktree, 'retained-local.txt'), 'unfinished work');
    removeFixtureAssignment(fixture);
    now += 60_000;
    await next();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const pending = (await store.read()).records[0]!;
    assert.equal(pending.retirement?.reason, 'assignment-removed');
    assert.equal(codexItemOccupied(pending), false);
    now = pending.retirement!.eligibleAt;
    await next();
    const saved = (await store.read()).records[0]!;
    assert.equal(saved.retirement?.code, undefined);
    assert.equal(workflowStatus(saved), 'awaiting-reassignment');
    assert.equal(saved.retired, undefined);
    assert.deepEqual(saved.result, pending.result);
    assert.equal(saved.threadId, pending.threadId);
    assert.equal(await readFile(join(worktree, 'retained-local.txt'), 'utf8'), 'unfinished work');
    assert.equal((await store.read()).records.length, 1);
    assert.equal(
      gitCalls.some((args) => args.includes('remove')),
      false,
    );
  });

  it('should revalidate assignment and metadata without giving issue prose model authority', async () => {
    const selected = await next();
    const prepared = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'high', reason: 'Issue prose sounds architectural.' },
    });
    assert.equal(prepared.status, 'prepared');
    const launch = prepared.request as { model: string; thinking: string };
    assert.equal(launch.model, 'gpt-6.1-sol');
    assert.equal(launch.thinking, 'high');
    const routed = ((await readDispatchState()).records as Array<{ routing: string }>)[0]!;
    const decision = JSON.parse(routed.routing);
    assert.equal(decision.complexity, 'medium');
    assert.equal(decision.source, 'native');
    assert.match(decision.reason, /Verified native Complexity: medium/u);
    now += 300001;
    fixture.item.state = 'closed';
    const revoked = await next();
    assert.equal(revoked.status, 'idle');
    const retired = (
      (await readDispatchState()).records as Array<{ retirement?: { reason: string } }>
    )[0]!;
    assert.equal(retired.retirement?.reason, 'issue-closed');
    assert.equal(gitCalls.filter((argv) => argv[0] === 'fetch').length, 1);
  });

  it('should refuse stale preparation and preserve a native model mismatch', async () => {
    const selected = await next();
    await assert.rejects(
      request('prepare', {
        id: selected.id,
        digest: 'stale',
        title: 'repair contained behavior',
        assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
      }),
      /dispatch-preparation-stale/,
    );
    const prepared = await prepare();
    created();
    native!.model = 'another-model';
    const blocked = await request('reconcile', {
      id: prepared.id,
      receipt: { threadId: 'issue-thread' },
    });
    assert.equal(blocked.code, 'dispatch-native-model-diverged');
    assert.equal(blocked.threadId, 'issue-thread');
    assert.match(String(blocked.message), /model access/);
    assert.doesNotMatch(String(blocked.message), /Set issue-assignment mode/);
  });

  it('should still reject effort drift before codex creation is verified', async () => {
    const prepared = await prepare();
    created();
    native!.effort = 'low';
    const blocked = await request('reconcile', { id: prepared.id });
    assert.equal(blocked.code, 'dispatch-native-model-diverged');
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    assert.equal((await store.read()).records[0]!.effective, undefined);
    native!.effort = 'high';
    assert.equal((await request('reconcile', { id: prepared.id })).status, 'assessing');
  });

  it('should suppress an overlapping poll while the first owns the dispatch journal', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = deps.connect!;
    deps.connect = async (workspace, signal) => {
      entered();
      await waiting;
      return connect(workspace, signal);
    };
    const first = next();
    await started;
    assert.equal((await next()).status, 'busy');
    release();
    assert.equal((await first).status, 'routing-required');
  });

  it('should wait for a concurrent writer and report the newly saved journal state', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    await next();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = store.exclusive(async (state, save) => {
      entered.resolve();
      await release.promise;
      state.records[0]!.intakeReportedAt = now;
      await save();
    });
    await entered.promise;
    try {
      const reporting = report();
      release.resolve();
      await writer;
      const recheck = await reporting;
      assert.equal(recheck.status, 'report');
      const completed = await report();
      assert.equal(completed.status, 'report');
      assert.doesNotMatch(String(completed.response), /1 issue started/);
      assert.equal((await store.read()).records[0]!.intakeReportedAt, now);
    } finally {
      release.resolve();
      await writer;
    }
  });

  it('should leave reporting unconsumed when the bounded journal wait is exhausted', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    await next();
    const before = await readDispatchState();
    const lock = properLockfile.lock;
    properLockfile.lock = async (path, options) => {
      if (String(path).includes('codex-dispatch-'))
        throw Object.assign(new Error('The journal remains busy.'), {
          code: 'private-state-file-lock-busy',
        });
      return lock(path, options);
    };
    try {
      assert.deepEqual(await report(), { status: 'busy', changed: false });
      assert.deepEqual(await readDispatchState(), before);
    } finally {
      properLockfile.lock = lock;
    }
    const recovered = await report();
    assert.equal(recovered.status, 'report');
    assert.match(String(recovered.response), /1 issue started/);
    assert.deepEqual(await report(), recovered);
  });

  it('should let child context and result wait for the intake journal lease', async () => {
    const prepared = await prepare();
    created();
    const lock = properLockfile.lock;
    let refuse = true;
    properLockfile.lock = async (path, options) => {
      if (String(path).includes('codex-dispatch-')) {
        if (refuse) {
          refuse = false;
          throw Object.assign(new Error('The intake journal lease is held.'), { code: 'ELOCKED' });
        }
      }
      return lock(path, options);
    };
    try {
      assert.equal(
        (await request('context', { id: prepared.id }, { threadId: 'issue-thread' })).status,
        'verified',
      );
      refuse = true;
      assert.equal(
        (
          await historicalResult(
            'result',
            { id: prepared.id, result },
            { threadId: 'issue-thread' },
          )
        ).status,
        'recorded',
      );
      assert.equal(refuse, false);
    } finally {
      properLockfile.lock = lock;
    }
  });

  it('should preserve a native title edit without blocking assessment or reconciliation', async () => {
    const prepared = await prepare();
    created();
    native!.name = 'a normalized native title';
    assert.equal(
      (await request('context', { id: prepared.id }, { threadId: 'issue-thread' })).status,
      'verified',
    );
    assert.equal(native!.name, 'a normalized native title');
    assert.equal((await request('reconcile', { id: prepared.id })).status, 'assessing');
    native!.turnStatus = 'failed';
    native!.status = 'idle';
    now += 300001;
    assert.equal((await next()).status, 'idle');
    assert.equal(
      (await request('context', { id: prepared.id }, { threadId: 'issue-thread' })).status,
      'verified',
    );
    assert.equal(
      (await historicalResult('result', { id: prepared.id, result }, { threadId: 'issue-thread' }))
        .status,
      'recorded',
    );
    assert.equal(((await readDispatchState()).records as unknown[]).length, 1);
  });

  it('should omit an oversized historical plan without changing implementation permission', async () => {
    const large = 'Retained engineering plan and evidence.\n'.repeat(750);
    const assessment = { ...result, plan: large, fullAssessment: large };
    const guidance = 'Current implementation guidance.\n'.repeat(400);
    const work = await workIssue(assessment, guidance);
    assert.equal((await work.run('next')).status, 'reconciled');
    work.receive();
    const first = await work.run('context', {}, true);
    assert.equal(first.status, 'verified');
    assert.ok('contextMaterials' in first && first.contextMaterials);
    const configured = JSON.parse(await readFile(join(workspace, 'agent.yaml'), 'utf8'));
    configured.github['issue-assignment'].mode = 'plan';
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const before = (await store.read()).records[0]!;
    const restored = await hydrateImplementation(first, async (read) =>
      work.run('context', { material: read.material }, true),
    );
    assert.equal(restored.assessment, undefined);
    assert.equal(restored.plan, undefined);
    assert.equal(restored.publicationAuthorized, true);
    assert.equal(
      (restored.implementation as { guidance: { content: string } }).guidance.content,
      guidance,
    );
    const after = (await store.read()).records[0]!;
    assert.deepEqual(after.result, before.result);
    assert.deepEqual(after.stageReceipt, before.stageReceipt);
    assert.deepEqual(after.progression, before.progression);
    assert.deepEqual(after.continuation, before.continuation);
    assert.equal(after.worktree, before.worktree);
    await assert.rejects(work.run('context', {}, 'foreign-thread'), /caller-required/);
  });

  it('should defer pre-transaction continuation contention without consuming work or action counters', async () => {
    const work = await workIssue();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const before = await store.read();
    const lock = properLockfile.lock;
    properLockfile.lock = async (path, options) => {
      if (String(path) === store.path)
        throw Object.assign(new Error('acquisition exhausted'), {
          code: 'private-state-file-lock-busy',
        });
      return lock(path, options);
    };
    try {
      const response = await work.run('next');
      assert.equal(response.status, 'busy');
      assert.ok('changed' in response && response.changed === false);
      assert.deepEqual(await store.read(), before);
    } finally {
      properLockfile.lock = lock;
    }
    assert.equal((await work.run('next')).status, 'reconciled');
  });

  for (const mode of ['work', 'auto'] as const)
    it(`should enter ${mode} while unrelated scheduler counters advance`, async () => {
      const work = await workIssue(null, 'Continue the task.', 'company:implement', mode);
      const store = await workStore();
      native!.status = 'active';
      native!.turnStatus = 'inProgress';
      const observe = work.continuation.continuationNative!;
      let advanced = false;
      work.continuation.continuationNative = async (...args) => {
        if (!advanced) {
          advanced = true;
          await store.exclusive(async (state, save) => {
            state.run = {
              id: 'concurrent-intake',
              automationId: 'native-intake',
              currentTimeIso: new Date(now).toISOString(),
              actions: 2,
            };
            state.continuationRun = { id: 'concurrent-continuation', actions: 1 };
            await save();
          });
        }
        return observe(...args);
      };
      const decision =
        mode === 'auto' ? { mode: 'work', reasons: ['Requirements are clear.'] } : undefined;
      const response = await work.run('context', decision ? { decision } : {}, true);
      assert.equal(advanced, true);
      assert.equal(response.status, 'verified');
      const saved = await store.read();
      assert.equal(saved.run?.id, 'concurrent-intake');
      assert.equal(saved.run?.actions, 2);
      assert.deepEqual(saved.continuationRun, { id: 'concurrent-continuation', actions: 1 });
      const record = saved.records.find((entry) => entry.id === work.id)!;
      assert.equal(record.progression?.via, mode);
      assert.deepEqual(record.implementationDecision, decision);
      assert.equal(record.continuation?.binding?.turnId, native!.turnId);
    });

  it('should retain occurrence accounting across competing native observations', async () => {
    const work = await workIssue();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const occurrence = work.continuation.native!.occurrence;
    let observations = 0;
    work.continuation.native = {
      ...work.continuation.native!,
      occurrence: async (...args) => {
        if (++observations === 2) entered.resolve();
        await release.promise;
        return occurrence(...args);
      },
    };
    const attempts = [work.run('next'), work.run('next')];
    const completed = Promise.allSettled(attempts);
    await entered.promise;
    release.resolve();
    const outcomes = await completed;
    assert.equal(
      outcomes.filter((r) => r.status === 'fulfilled' && r.value.status === 'reconciled').length,
      1,
    );
    const rejected = outcomes.filter((r) => r.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]!.reason), /private-state-snapshot-conflict/);
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    assert.equal((await store.read()).continuationRun?.actions, 1);
  });

  it('should commit unrelated progress while continuation native readback is delayed', async () => {
    const work = await workIssue();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const occurrence = work.continuation.native!.occurrence;
    work.continuation.native = {
      ...work.continuation.native!,
      occurrence: async (...args) => {
        entered.resolve();
        await release.promise;
        return occurrence(...args);
      },
    };
    const pending = work.run('next');
    await entered.promise;
    try {
      const current = await selectCodexIntake(pluginData, deps);
      const other = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      await other.exclusive(async (state, save) => {
        state.discoveryCheckedAt = baseline;
        await save();
      });
      assert.equal((await other.read()).discoveryCheckedAt, baseline);
    } finally {
      release.resolve();
      await pending;
    }
  });

  for (const setting of ['model', 'effort'] as const)
    it(`should preserve assessment after operator ${setting} tuning in a verified codex chat`, async () => {
      const prepared = await prepare();
      created();
      const child = { threadId: native!.id };
      await request('context', { id: prepared.id }, child);
      const current = await selectCodexIntake(pluginData, deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      const before = (await store.read()).records[0]!;
      native![setting] = setting === 'model' ? 'gpt-6-luna' : 'low';
      const context = await request('context', { id: prepared.id }, child);
      assert.equal(context.status, 'verified');
      assert.deepEqual(context.effective, {
        status: 'verified',
        model: native!.model,
        effort: native!.effort,
      });
      assert.equal(
        (await historicalResult('result', { id: prepared.id, result }, child)).status,
        'recorded',
      );
      assert.equal((await request('reconcile', { id: prepared.id })).status, 'complete');
      const after = (await store.read()).records[0]!;
      assert.deepEqual(after.request, before.request);
      assert.equal(after.routing, before.routing);
      assert.equal(after.threadId, before.threadId);
      assert.equal(after.worktree, before.worktree);
      assert.deepEqual(after.effective, context.effective);
    });

  it('should not declare missing results from unloaded history or an active native chat', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    for (const status of ['notLoaded', 'active']) {
      for (const turnStatus of ['completed', 'failed', 'interrupted']) {
        native!.status = status;
        native!.turnStatus = turnStatus;
        now += 300001;
        assert.equal((await next()).status, 'idle');
        const records = (await readDispatchState()).records as {
          phase: string;
          result?: unknown;
        }[];
        assert.equal(records.length, 1);
        assert.equal(records[0]!.phase, 'assessing');
        assert.equal(records[0]!.result, undefined);
      }
    }
    await historicalResult('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
  });

  it('should not require a cosmetic rename to continue a verified issue chat', async () => {
    const prepared = await prepare();
    created();
    native!.name = 'Operator title';
    deps.native!.rename = async () => {
      throw new Error('rename-unavailable');
    };
    assert.equal(
      (await request('context', { id: prepared.id }, { threadId: 'issue-thread' })).status,
      'verified',
    );
    assert.equal(native!.name, 'Operator title');
    assert.equal((await request('reconcile', { id: prepared.id })).status, 'assessing');
  });

  it('should not rename a chat whose worktree or model verification fails', async () => {
    const prepared = await prepare();
    created();
    native!.name = 'shortened title';
    deps.native!.rename = async () => {
      assert.fail('unverified chat must not be renamed');
    };
    native!.model = 'another-model';
    await assert.rejects(
      request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-native-model-diverged/,
    );
    native!.model = 'gpt-6.1-sol';
    native!.cwd = source;
    await assert.rejects(
      request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-worktree-required/,
    );
  });

  it('should preserve native and fallback disagreements with their provenance', async () => {
    const connect = deps.connect!;
    deps.connect = async (workspace, signal) => {
      const client = await connect(workspace, signal);
      const getContext = client.getItemContext;
      return {
        ...client,
        async getItemContext(...args) {
          const context = await getContext(...args);
          return {
            ...context,
            nativeRoutingMetadata: context.routingMetadata,
            body: '```yaml\nschema: tanaab/task-metadata/v2\nmode: fallback\nfallback:\n  complexity: low\n```',
          };
        },
      };
    };
    const selected = await next();
    const context = selected.context as {
      conflicts: string[];
      nativeMetadata: unknown;
      fallbackMetadata: unknown;
    };
    assert.deepEqual(context.conflicts, ['complexity']);
    assert.ok(context.nativeMetadata);
    assert.ok(context.fallbackMetadata);
  });

  it('should count reassignment once before launch and never queue an already started issue', async () => {
    const reassign = async () => {
      now += 60000;
      fixture.events.push({
        ...fixture.events[0]!,
        nodeId: 'assignment-' + now,
        databaseId: now,
        createdAt: new Date(now).toISOString(),
      });
      await runCodexIntake(pluginData, false, deps);
    };
    await reassign();
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    await next();
    assert.match(String((await report()).response), /\*\*Pending:\*\* 0/);
    await reassign();
    assert.equal((await next()).status, 'idle');
    const response = String((await report()).response);
    assert.match(response, /\*\*Active:\*\* 1 issues · \*\*Pending:\*\* 0/);
    assert.doesNotMatch(response, /issues? pending/);
    assert.equal(((await readDispatchState()).records as unknown[]).length, 1);
  });

  it('should keep revised plans and questions inside the issue while releasing its slot', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    await next();
    await report();
    const child = { threadId: 'issue-thread' };
    const saved = await historicalResult('result', { id: prepared.id, result }, child);
    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    await historicalResult(
      'result',
      {
        id: prepared.id,
        previousResultDigest: saved.previousResultDigest,
        result: {
          version: 1,
          outcome: 'clarification-needed',
          summary: 'Decide retention.',
          assessment: 'A choice is needed.',
          fullAssessment: 'Complete source for the unresolved choice.',
          questions: ['How long?'],
          evidence: result.evidence,
          progress: result.progress,
        },
      },
      child,
    );
    native!.status = 'idle';
    native!.turnEnded = true;
    await next();
    const output = await report();
    assert.match(String(output.response), /DONT_NOTIFY/);
    assert.match(String(output.response), /Slots:\*\* 0\/2/);
    assert.doesNotMatch(
      String(output.response),
      /How long|Plan ready|Decide retention|clarification/i,
    );
  });
  async function workIssue(
    assessment: Record<string, unknown> | null = result,
    guidance: string | { file: string } = 'Follow the plan.',
    skill: string | undefined = 'company:implement',
    mode: 'plan' | 'work' | 'auto' = 'work',
    assessmentGuidance?: string | { file: string },
  ) {
    const configured = structuredClone(manifest);
    Object.assign(configured.github['issue-assignment'], {
      mode,
      ...(assessmentGuidance ? { assessment: { guidance: assessmentGuidance } } : {}),
      implementation: { ...(skill ? { skill } : {}), guidance },
    });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
    await runCodexIntake(pluginData, true, {
      codexHome,
      now: () => now,
      connect: async () => fixture.client,
    });
    const current = await selectCodexIntake(pluginData, deps);
    // retain the admission mode as historical evidence; live policy governs progression.
    await current.store.exclusive(async (state, save) => {
      for (const record of state!.records) record.evidence.mode = mode;
      await save(state!);
    });
    const authority = {
      workflow: 'issue-assignment' as const,
      automationId: 'native-intake',
      sourceThreadId: 'intake-thread',
      policyDigest: automationHash(current.manifest.github?.notifications),
      definitionDigest: 'f'.repeat(64),
    };
    deps.activation = async () => ({
      sourceThreadId: authority.sourceThreadId,
      schedule: {
        current: authority,
        saved: {
          ...authority,
          version: 1,
          capabilities: ['assessment', 'implementation', 'publication'],
        },
      },
    });
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    if (assessment)
      await historicalResult(
        'result',
        { id: prepared.id, result: assessment },
        { threadId: native!.id },
      );
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    let received = false;
    const continuation: CodexContinuationDependencies = {
      ...deps,
      continuationNative: async (_source, attempt) =>
        received || attempt.origin === 'assessment'
          ? {
              status: 'verified',
              turnId: attempt.origin === 'assessment' ? attempt.turnId! : native!.turnId!,
              ended:
                native!.turnEnded ??
                ['completed', 'failed', 'interrupted'].includes(native!.turnStatus!),
            }
          : { status: 'uncertain' },
    };
    const run = (action: string, input: object = {}, child: boolean | string = false) =>
      runCodexContinuation(
        pluginData,
        { action, ...(action === 'next' ? {} : { id: prepared.id }), ...input },
        {
          ...continuation,
          threadId: typeof child === 'string' ? child : child ? native!.id : 'intake-thread',
        },
      );
    return {
      id: prepared.id,
      run,
      continuation,
      receive() {
        received = true;
        native!.turnId = 'implementation-turn';
        delete native!.turnEnded;
        native!.status = 'active';
        native!.turnStatus = 'inProgress';
      },
    };
  }

  it('should enter issue work from a verified native answer to the original clarification', async () => {
    const question = {
      version: 1,
      outcome: 'clarification-needed',
      summary: 'Choose approach.',
      assessment: 'A decision is needed.',
      fullAssessment: 'Choose the smaller approach before implementation.',
      questions: ['Which approach?'],
      evidence: [],
      progress: { completed: [], remaining: ['Answer.'] },
    };
    const work = await workIssue(question, 'Follow the answer.', 'company:implement', 'plan');
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    assert.equal((await work.run('next')).status, 'reconciled');
    const source = {
      nodeId: 'C_answer',
      databaseId: 42,
      author: fixture.client.identity,
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
      turnId: native!.turnId!,
      request: { threadId: native!.id, prompt: 'Verified feedback input.' },
    };
    const provider = await deps.feedbackConnect!(workspace, AbortSignal.timeout(10000));
    provider.comments.getIssueComment = async () => source;
    work.continuation.feedbackConnect = async () => provider;
    await store.exclusive(async (state, save) => {
      state.records[0]!.feedback = {
        baseline: {},
        events: [
          {
            id: 'e'.repeat(64),
            sourceId: source.nodeId,
            nodeId: fixture.item.nodeId,
            number: 3,
            itemType: 'issue',
            source: JSON.stringify(source),
            revision: feedbackRevision(source),
            createdAt: now,
            policyDigest: 'c'.repeat(64),
            phase: 'running',
            native: true,
            attempt,
          },
        ],
      };
      await save();
    });
    const context = await work.run('context', {}, true);
    assert.equal(context.status, 'verified', JSON.stringify(context));
    const retained = (await store.read()).records[0]!;
    assert.equal(retained.progression?.workOwner, 'issue');
    assert.equal(retained.progression?.via, 'operator');
    assert.equal(retained.result, undefined);
    assert.equal(retained.feedback!.events[0]!.work, undefined);
    assert.equal(retained.feedback!.events[0]!.result, undefined);
    assert.equal(retained.continuation!.attempt, undefined);
    assert.equal(retained.continuation!.binding!.turnId, attempt.turnId);
  });

  it('should inspect operational facts without replaying retained plans or prompts', async () => {
    const work = await workIssue(result, 'Historical implementation guidance.');
    work.receive();
    await work.run('context', {}, true);
    const store = await workStore();
    const before = await store.read();
    const inspection = await request('inspect');
    const record = (inspection.records as Array<Record<string, unknown>>)[0]!;
    assert.equal(record.id, work.id);
    assert.equal(record.threadId, native!.id);
    assert.equal(record.worktree, before.records[0]!.worktree);
    assert.equal(record.workflowStatus, workflowStatus(before.records[0]!));
    assert.deepEqual(record.progression, before.records[0]!.progression);
    for (const text of [
      result.fullAssessment,
      result.plan,
      'Historical implementation guidance.',
      before.records[0]!.request!.prompt,
    ])
      assert.equal(JSON.stringify(inspection).includes(text), false, text);
    assert.equal('result' in record, false);
    assert.equal('continuation' in record, false);
    assert.equal('context' in record, false);
    assert.deepEqual(await store.read(), before);
    const history = await request('present', { id: work.id }, { threadId: native!.id });
    assert.equal(JSON.stringify(history).includes(result.fullAssessment), true);
  });

  async function workStore() {
    const current = await selectCodexIntake(pluginData, deps);
    return new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  }

  for (const mode of ['plan', 'work', 'auto'] as const)
    for (const assessment of [null, result])
      it(`should leave ${mode} conversation to its host with ${assessment ? 'saved' : 'missing'} assessment history`, async () => {
        const saved =
          assessment && mode === 'auto'
            ? { ...assessment, decision: { mode: 'work', reasons: ['Bounded change.'] } }
            : assessment;
        const work = await workIssue(saved, 'Follow the conversation.', 'company:implement', mode);
        const store = await workStore();
        const before = (await store.read()).records[0]!;
        for (const turnStatus of ['completed', 'failed', 'interrupted']) {
          native!.turnStatus = turnStatus;
          native!.turnEnded = true;
          const response = await work.run('next');
          assert.equal(response.status, 'reconciled');
          assert.equal('request' in response, false);
        }
        const after = (await store.read()).records[0]!;
        assert.deepEqual(after.result, before.result);
        assert.deepEqual(after.request, before.request);
        assert.equal(after.continuation?.attempt, undefined);
        assert.equal(after.autoDecision, undefined);
        assert.equal(after.summaryRecovery, undefined);
        assert.equal(after.progression, undefined);
      });

  it('should reject incomplete continuation requests before accessing workflow state', async () => {
    for (const action of [
      'context',
      'reconcile',
      'result',
      'delivery',
      'cancel',
      'retry',
      'retry-denied',
    ])
      await assert.rejects(
        runCodexContinuation('/unused-plugin-data', { action }),
        /continuation-request-invalid/,
      );
    for (const input of [
      { action: 'context', id: 'task', decision: { mode: 'work' } },
      { action: 'context', id: 'task', unknown: true },
      { action: 'result', id: 'task', material: { path: [], digest: 'a'.repeat(64), offset: 0 } },
    ])
      await assert.rejects(
        runCodexContinuation('/unused-plugin-data', input),
        /continuation-request-invalid/,
      );
  });

  for (const mode of ['work', 'auto'] as const)
    it(`should enter ${mode} in the initial native turn without recording an assessment`, async () => {
      const work = await workIssue(
        null,
        'Use the current conversation.',
        'company:implement',
        mode,
      );
      native!.status = 'active';
      native!.turnStatus = 'inProgress';
      const decision =
        mode === 'auto' ? { mode: 'work', reasons: ['Requirements are clear.'] } : undefined;
      const assessmentContext = await request('context', { id: work.id }, { threadId: native!.id });
      assert.deepEqual(assessmentContext.continuationRequest, {
        action: 'context',
        id: work.id,
      });
      const context = await runCodexContinuation(
        pluginData,
        {
          ...(assessmentContext.continuationRequest as object),
          ...(decision ? { decision } : {}),
        },
        { ...work.continuation, threadId: native!.id },
      );
      assert.equal(context.status, 'verified', JSON.stringify(context));
      assert.ok('continuationRequest' in context);
      assert.ok('deliveryPrepareRequest' in context);
      assert.deepEqual(context.deliveryPrepareRequest, { action: 'prepare', id: work.id });
      const delivery = await runCodexDelivery(
        pluginData,
        { ...context.deliveryPrepareRequest, title: 'One poem', body: 'The completed poem.' },
        {
          codexHome,
          threadId: native!.id,
          native: deps.native,
          git: (cwd, argv, signal) =>
            argv[0] === 'rev-list' ? Promise.resolve('1') : deps.git!(cwd, argv, signal),
          connect: async () => ({
            client: await deps.connect!(workspace, new AbortController().signal),
            account: {
              identity: fixture.client.identity,
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
      assert.ok(!gitCalls.some((argv) => argv.includes('push')));
      const resumed = await runCodexContinuation(pluginData, context.continuationRequest, {
        ...work.continuation,
        threadId: native!.id,
      });
      assert.equal(resumed.status, 'verified', JSON.stringify(resumed));
      const record = (await (await workStore()).read()).records[0]!;
      assert.equal(record.progression?.via, mode);
      assert.equal(record.continuation?.attempt, undefined);
      assert.equal(record.continuation?.binding?.turnId, native!.turnId);
      assert.equal(record.result, undefined);
      assert.equal(record.stageReceipt, undefined);
      assert.equal(record.continuation?.result, undefined);
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
      const work = await workIssue(
        null,
        'Continue the authorized task.',
        'company:implement',
        mode,
      );
      const store = await workStore();
      const original = (await store.read()).records[0]!;
      const assessmentContext = await request('context', { id: work.id }, { threadId: native!.id });
      // Startup ended before implementation; compaction is followed by a native resume send.
      work.receive();
      native!.turnId = 'post-compaction-turn';
      native!.followUpUserTurn = true;
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
        if (method === 'thread/read') return { thread: { id: native!.id } };
        if (method === 'thread/turns/list')
          return { data: [{ id: native!.turnId, status: 'inProgress' }] };
        if (method === 'thread/items/list')
          return { data: items.map((item) => ({ turnId: native!.turnId, item })) };
        throw new Error('unexpected native method: ' + method);
      };
      work.continuation.native!.operatorInput = (threadId) =>
        codexDirectInput(readNative, threadId);
      work.continuation.continuationNative = codexContinuationNative(readNative);
      const enter = (scope?: 'local' | 'pull-request') =>
        request(
          'implementation',
          {
            operation: 'context',
            target: 'https://github.com/owner/repo/issues/3',
            path: (assessmentContext.project as { path: string }).path,
            scope,
          },
          { ...work.continuation, threadId: native!.id },
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
          pluginData,
          {
            ...(initial.continuationRequest as object),
            decision: { mode: 'work', reasons: ['Bounded requested change.'] },
          },
          { ...work.continuation, threadId: native!.id },
        );
        assert.equal(decided.status, 'verified', JSON.stringify(decided));
      }
      const entered = (await store.read()).records[0]!;
      const config = JSON.parse(await readFile(join(workspace, 'agent.yaml'), 'utf8'));
      config.github['issue-assignment'].mode = 'plan';
      await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(config));
      native!.turnId = 'second-resume';
      assert.equal((await enter('pull-request')).status, 'verified');
      const resumed = (await store.read()).records[0]!;
      assert.deepEqual(resumed.progression, entered.progression);
      assert.deepEqual(resumed.request, original.request);
      assert.deepEqual(resumed.issueBranch, entered.issueBranch);
      assert.equal(resumed.threadId, original.threadId);
      assert.equal(resumed.worktree, original.worktree);
      assert.equal(resumed.result, undefined);
      await store.exclusive(async (state, save) => {
        state.records[0]!.continuation!.scope = 'local';
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
        state.records[0]!.continuation!.phase = 'cancelled';
        await save();
      });
      assert.equal((await enter()).reason, 'implementation-cancelled');
    });

  it('should wait for an auto decision in the same conversation without creating another turn', async () => {
    const work = await workIssue(null, 'Assess the request.', 'company:implement', 'auto');
    native!.status = 'active';
    native!.turnStatus = 'inProgress';
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
    assert.equal((await (await workStore()).read()).records[0]!.autoDecision, undefined);
  });

  for (const setting of ['model', 'effort'] as const)
    it(`should preserve the native ${setting} selection and original creation receipt`, async () => {
      const work = await workIssue();
      const store = await workStore();
      const before = (await store.read()).records[0]!;
      work.receive();
      native![setting] = setting === 'model' ? 'gpt-6-luna' : 'low';
      assert.equal((await work.run('context', {}, true)).status, 'verified');
      const after = (await store.read()).records[0]!;
      assert.deepEqual(after.request, before.request);
      assert.deepEqual(after.stageReceipt, before.stageReceipt);
      assert.equal(after.routing, before.routing);
      assert.deepEqual(after.effective, {
        status: 'verified',
        model: native!.model,
        effort: native!.effort,
      });
      assert.equal(after.continuation?.attempt, undefined);
    });

  it('should preserve implementation permission through policy edits without nudging the chat', async () => {
    const work = await workIssue(null);
    work.receive();
    await work.run('context', {}, true);
    const store = await workStore();
    const before = (await store.read()).records[0]!;
    const changed = JSON.parse(await readFile(join(workspace, 'agent.yaml'), 'utf8'));
    Object.assign(changed.github['issue-assignment'], { paused: true, allowed: [], mode: 'plan' });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(changed));
    work.continuation.activation = async () => {
      throw new Error('native work must not require a schedule');
    };
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    const after = (await store.read()).records[0]!;
    assert.deepEqual(after.progression, before.progression);
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.worktree, before.worktree);
    assert.equal(after.result, undefined);
  });

  it('should make a live mode change effective on native input without creating a handoff', async () => {
    const work = await workIssue(null, 'Current instructions.', 'company:implement', 'plan');
    const changed = JSON.parse(await readFile(join(workspace, 'agent.yaml'), 'utf8'));
    changed.github['issue-assignment'].mode = 'work';
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(changed));
    assert.equal((await work.run('next')).status, 'reconciled');
    assert.equal((await (await workStore()).read()).records[0]!.progression, undefined);
    work.receive();
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    assert.equal((await (await workStore()).read()).records[0]!.continuation?.attempt, undefined);
  });

  for (const outcome of ['done', 'clarification-needed', 'blocked'] as const)
    it(`should accept a later native answer after ${outcome} without saving questions`, async () => {
      const work = await workIssue();
      work.receive();
      await work.run('context', {}, true);
      const prior = {
        outcome,
        summary: 'Previous work.',
        fullResult: 'Original evidence.',
        ...(outcome === 'clarification-needed' ? { questions: ['Which value?'] } : {}),
      };
      assert.equal(
        (await work.run('result', { result: prior }, true)).status,
        outcome === 'clarification-needed' ? 'native' : 'recorded',
      );
      const retained = outcome === 'clarification-needed' ? undefined : prior;
      const store = await workStore();
      const before = (await store.read()).records[0]!;
      native!.turnId = 'answer-turn';
      native!.followUpUserTurn = true;
      work.continuation.native!.operatorInput = async () => ({
        turnId: 'answer-turn',
        inputId: 'answer',
      });
      const context = await work.run('context', {}, true);
      assert.equal(context.status, 'verified');
      assert.equal('previousResult' in context, false);
      assert.equal('deliveryOnly' in context && context.deliveryOnly, false);
      assert.deepEqual((await store.read()).records[0]!.continuation!.result, retained);
      const revised = { outcome: 'done', summary: 'Revised.', fullResult: 'New evidence.' };
      assert.equal((await work.run('result', { result: revised }, true)).status, 'recorded');
      const after = (await store.read()).records[0]!;
      assert.deepEqual(after.continuation!.resultHistory?.[0]?.result, retained);
      assert.deepEqual(after.continuation!.resultSource, {
        turnId: 'answer-turn',
        inputId: 'answer',
      });
      assert.deepEqual(after.result, before.result);
      assert.equal(after.continuation!.attempt, undefined);
    });

  it('should retain an old uncertain request without allowing it to block current native input', async () => {
    const work = await workIssue();
    work.receive();
    await work.run('context', {}, true);
    const store = await workStore();
    const attempt = {
      id: 'f'.repeat(64),
      sourceThreadId: 'intake-thread',
      sourceTurnId: 'old-scan',
      beforeTurnId: 'first-turn',
      request: { threadId: native!.id, prompt: 'Historical continuation.' },
    };
    await store.exclusive(async (state, save) => {
      state.records[0]!.continuation!.attempt = attempt;
      await save();
    });
    work.continuation.continuationNative = async (_source, current) =>
      current.id === attempt.id
        ? { status: 'uncertain' }
        : { status: 'verified', turnId: current.turnId!, ended: false };
    const observed = await work.run('next');
    assert.equal(observed.status, 'reconciled');
    assert.ok(
      'outcomes' in observed &&
        observed.outcomes.some((entry) => 'status' in entry && entry.status === 'uncertain'),
    );
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    assert.deepEqual((await store.read()).records[0]!.continuation!.attempt, attempt);
    assert.equal((await store.read()).records[0]!.continuation!.retries, undefined);
  });

  it('should preserve a current native denial without manufacturing a retry or clearing history', async () => {
    const work = await workIssue();
    work.receive();
    await work.run('context', {}, true);
    const store = await workStore();
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
    assert.deepEqual(after.result, before.result);
    assert.deepEqual(after.progression, before.progression);
    assert.equal(after.continuation!.attempt, undefined);
  });

  it('should resolve the current implementation skill and surface an unavailable selection', async () => {
    const work = await workIssue();
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

  for (const mode of ['work', 'auto', 'plan', 'auto-plan'] as const)
    for (const broader of mode === 'plan' || mode === 'auto-plan' ? [false] : [false, true])
      it(`should ${broader ? 'stop broader refusal despite' : mode === 'plan' || mode === 'auto-plan' ? 'retain ' + mode + ' hold despite' : 'continue same-turn ' + mode + ' after'} a held summary denial in codex`, async () => {
        const assessment = {
          ...result,
          fullAssessment: 'Complete retained assessment.',
          ...(mode === 'auto' || mode === 'auto-plan'
            ? { decision: { mode: mode === 'auto-plan' ? 'plan' : 'work', reasons: ['Assessed.'] } }
            : {}),
        };
        const work = await workIssue(
          assessment,
          'Follow the plan.',
          'company:implement',
          mode === 'auto-plan' ? 'auto' : mode,
        );
        native!.status = 'active';
        native!.turnStatus = 'inProgress';
        const activation = deps.activation!;
        deps.activation = async (...args) => {
          const value = await activation(...args);
          value.schedule!.saved.capabilities.push('assessment-summary');
          return value;
        };
        deps.summaryAuthority = async () => {};
        const summary = (input: object) =>
          request('summary', { id: work.id, ...input }, { threadId: native!.id });
        await summary({ operation: 'compose' });
        const preview = await summary({
          operation: 'candidate',
          publicText: 'The proposed change restores your result.',
        });
        assert.match(String(preview.command), /"action":"summary","operation":"publish"/);
        assert.doesNotMatch(String(preview.command), /"id"|"digest"/);
        const items = [
          {
            id: 'summary-denial',
            type: 'commandExecution',
            status: 'declined',
            command: preview.command,
          },
          ...(broader
            ? [{ id: 'implementation-denial', type: 'fileChange', status: 'declined' }]
            : []),
        ];
        // native refusal happens before the publish command executes; do not call publish again.
        const held = await summary({
          operation: 'hold',
          diagnostic: 'Native review refused summary publication.',
        });
        assert.equal(held.status, 'blocked');
        await assert.rejects(
          work.run('context', {}, 'unrelated-thread'),
          /caller|binding|owner|managed-issue-required/,
        );
        const host = async (method: string) => ({
          data:
            method === 'thread/turns/list'
              ? [{ id: 'first-turn', status: 'inProgress', completedAt: null }]
              : items.map((item) => ({ turnId: 'first-turn', item })),
        });
        work.continuation.continuationNative = codexContinuationNative(host);
        if (mode === 'plan') {
          await assert.rejects(
            work.run('context', {}, true),
            /continuation-managed-issue-required/,
          );
        }
        const entered =
          mode === 'plan'
            ? undefined
            : await work.run(
                'context',
                assessment.decision ? { decision: assessment.decision } : {},
                true,
              );
        const permitted = mode !== 'plan' && mode !== 'auto-plan';
        if (entered)
          assert.equal(
            entered.status,
            !permitted ? 'policy-held' : broader ? 'unresolved' : 'verified',
            JSON.stringify(entered),
          );
        if (entered && permitted && !broader) {
          assert.equal('pendingPublicResponse' in entered, false);
          await work.run(
            'result',
            {
              result: {
                outcome: 'done',
                summary: 'Implemented.',
                fullResult: 'Controlled implementation result.',
              },
            },
            true,
          );
        }
        const current = await selectCodexIntake(pluginData, deps);
        const restarted = await new CodexDispatchStore(
          current.store.location.root,
          current.store.location.scope,
        ).read();
        const retained = restarted.records[0]!;
        assert.deepEqual(retained.result, assessment);
        assert.equal(
          retained.assessmentSummaries?.[0]?.code,
          'assessment-summary-native-approval-denied',
        );
        assert.equal(
          retained.assessmentSummaries?.[0]?.diagnostic,
          'Native review refused summary publication.',
        );
        if (permitted && !broader)
          assert.equal(retained.assessmentSummaries?.[0]?.nativeDenial?.callId, 'summary-denial');
        assert.equal((await summary({ operation: 'publish' })).status, 'blocked');
        assert.equal(retained.assessmentSummaries?.[0]?.attempt, undefined);
      });

  for (const scope of ['local', 'pull-request'] as const)
    it(`should route ${scope} input to its issue instead of a historical feedback owner`, async () => {
      await workIssue();
      const current = await selectCodexIntake(pluginData, deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      await store.exclusive(async (state, save) => {
        state.records[0]!.progression = {
          stage: 'implementation',
          via: 'work',
          workOwner: 'e'.repeat(64),
        };
        await save();
      });
      const routed = await codexImplementationEntry(
        pluginData,
        { action: 'implementation', operation: 'context', scope },
        {
          ...deps,
          threadId: native!.id,
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

  it('should compose a retained assessment summary during implementation without requiring the initial checkout', async () => {
    const assessment = { ...result, fullAssessment: 'Complete saved assessment.' };
    const work = await workIssue(assessment);
    work.receive();
    await work.run('context', {}, true);
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    const activation = deps.activation!;
    const summaryDeps = {
      ...deps,
      summaryAuthority: async () => {},
      activation: async (...args: Parameters<typeof activation>) => {
        const selected = await activation(...args);
        return {
          ...selected,
          schedule: {
            ...selected.schedule!,
            saved: {
              ...selected.schedule!.saved,
              capabilities: [
                ...selected.schedule!.saved.capabilities,
                'assessment-summary' as const,
              ],
            },
          },
        };
      },
      git: async (cwd: string, argv: string[]) =>
        argv.includes('HEAD') ? 'f'.repeat(40) : deps.git!(cwd, argv),
    };
    const composed = await request(
      'summary',
      { id: work.id, operation: 'compose' },
      { ...summaryDeps, threadId: native!.id },
    );
    assert.equal(composed.status, 'composition-ready', JSON.stringify(composed));
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const retained = (await store.read()).records[0]!;
    assert.equal(retained.progression?.stage, 'implementation');
    assert.deepEqual(retained.result, assessment);
    assert.equal(retained.resultTurnId, 'first-turn');
  });

  for (const [mode, isolatedReader] of [
    ['work', false],
    ['work', true],
    ['auto', false],
    ['auto', true],
  ] as const)
    it(`should hand ${mode} directly from assessment to implementation without a coordinator send with isolated reader ${isolatedReader}`, async () => {
      const assessment = {
        ...result,
        fullAssessment:
          'Internal rationale and alternatives. Preserve exact source and receipt ordering.',
        reviewSummary:
          'You would see the result immediately. Docs clarify it; tests cover the missing return.',
        ...(mode === 'auto' ? { decision: { mode: 'work' as const, reasons: ['Ready.'] } } : {}),
      };
      const work = await workIssue(assessment, 'Follow the plan.', 'company:implement', mode);
      native!.status = 'active';
      native!.turnStatus = 'inProgress';
      const turnId = native!.turnId;
      const recorded = await request(
        'result',
        { id: work.id, result: assessment },
        { threadId: native!.id },
      );
      assert.equal(recorded.status, 'formatted');
      assert.ok(String(recorded.presentation).includes(assessment.reviewSummary));
      assert.ok(!String(recorded.presentation).includes(assessment.fullAssessment));
      const detailed = await request(
        'present',
        { id: work.id, includeDetails: true },
        { threadId: native!.id },
      );
      assert.ok(String(detailed.presentation).includes(assessment.fullAssessment));
      if (isolatedReader) {
        native!.status = 'notLoaded';
        native!.turnStatus = 'interrupted';
        native!.turnEnded = false;
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
                        arguments: { threadId: native!.id, turnLimit: 1, includeOutputs: false },
                        result: {
                          content: [
                            {
                              type: 'text',
                              text: JSON.stringify({
                                schemaVersion: 1,
                                thread: {
                                  id: native!.id,
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
          arguments: { threadId: native!.id, turnLimit: 1, includeOutputs: false },
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
        const current = await selectCodexIntake(pluginData, deps);
        const state = await new CodexDispatchStore(
          current.store.location.root,
          current.store.location.scope,
        ).read();
        assert.equal(state.records[0]!.continuation!.attempt, undefined);
        assert.notEqual(state.records[0]!.progression?.stage, 'implementation');
        readReceived = true;
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
      const current = await selectCodexIntake(pluginData, deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      const started = (await store.read()).records[0]!;
      assert.equal(started.continuation!.attempt, undefined);
      assert.equal(started.continuation!.binding!.turnId, turnId);
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
      assert.deepEqual(
        (await store.read()).records[0]!.continuation!.attempt,
        started.continuation!.attempt,
      );
      assert.equal((await work.run('next')).status, 'reconciled');
      const saved = await work.run(
        'result',
        { result: { outcome: 'done', summary: 'Done.', fullResult: 'Validated.' } },
        true,
      );
      assert.equal(saved.status, 'recorded');
      const handoff = 'handoff' in saved && saved.handoff;
      assert.ok(handoff && 'request' in handoff && handoff.request);
      const deliveryRequest = handoff.request;
      let delivered = false;
      work.continuation.deliver = async (_data, _input, deliveryDeps) => {
        await deliveryDeps?.authorizeSchedule?.();
        delivered = true;
        throw new Error('direct-delivery-boundary');
      };
      await assert.rejects(
        work.run(deliveryRequest.action, deliveryRequest, true),
        /direct-delivery-boundary/,
      );
      assert.equal(delivered, true);
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
      assert.equal(native!.turnId, turnId);
      native!.status = 'idle';
      native!.turnStatus = 'completed';
      native!.turnEnded = true;
      const recovery = await work.run('next');
      assert.equal(recovery.status, 'reconciled');
      assert.equal('request' in recovery, false);
      assert.deepEqual((await store.read()).records[0]!.result, assessment);
    });

  for (const resumed of [false, true])
    it(`should publish an assigned ${resumed ? 'resumed question' : 'initial plan'} update without treating delegation as human input`, async () => {
      await writeFile(join(root, 'SKILL.md'), '# status composer');
      const prepared = await prepare();
      created();
      await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
      const current = await selectCodexIntake(pluginData, deps);
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
        ...fixture.client,
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
        ...deps,
        threadId: native!.id,
        replyProvider: async () => provider,
        replyConnection: async () => ({
          close: async () => {},
          request: async (method: string, params: Record<string, unknown>) => {
            if (method === 'thread/read') return { thread: { id: native!.id } };
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
                    cwd: workspace,
                    errors: [],
                    skills: [
                      {
                        name: 'agent-system:agent-system-github-reply',
                        path: join(root, 'SKILL.md'),
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
        runCodexFeedback(pluginData, { action: 'reply', operation, ...extra }, nativeDeps);
      const target = 'https://github.com/owner/repo/issues/3';
      const context = { purpose: 'status-update', target };
      await assert.rejects(
        call('compose', { target, privateText: 'Unscoped reply.' }),
        /reply-native-user-input-required/,
      );
      items = [];
      await assert.rejects(call('context', context), /reply-native-user-input-required/);
      items = [inputItem];
      const find = deps.native!.find;
      deps.native!.find = async () => undefined;
      await assert.rejects(call('context', context), /reply-managed-context-invalid/);
      deps.native!.find = find;
      items.push({
        type: 'mcpToolCall',
        status: 'failed',
        error: { message: 'user rejected MCP tool call' },
      });
      await assert.rejects(call('context', context), /reply-native-approval-denied/);
      items = [inputItem];
      native!.cwd = root;
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
    await writeFile(join(root, 'SKILL.md'), '# status composer');
    await workIssue(result, 'Follow the plan.', 'company:implement', 'plan');
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.assessmentRevision ??= 1;
      record.assessmentSummaries = [
        {
          revision: record.assessmentRevision,
          resultDigest: automationHash(record.result),
          binding: record.stageReceipt!.binding,
          turnId: record.resultTurnId!,
          authorityDigest: 'a'.repeat(64),
          selection: record.assessment!,
          publicText: 'Delivered assessment.',
          receipt: { nodeId: 'SUMMARY', databaseId: 7 },
        },
      ];
      await save();
    });
    const before = await store.read();
    const provider = {
      ...(await deps.connect!(workspace, AbortSignal.timeout(1000))),
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
      ...deps,
      threadId: native!.id,
      replyProvider: async () => provider,
      replyConnection: async () => ({
        request: async (method: string) => {
          if (method === 'thread/read') return { thread: { id: native!.id } };
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
                  cwd: workspace,
                  errors: [],
                  skills: [
                    {
                      name: 'agent-system:agent-system-github-reply',
                      path: join(root, 'SKILL.md'),
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
      pluginData,
      { action: 'reply', operation: 'context', purpose: 'status-update', target },
      nativeDeps,
    );
    assert.ok('observation' in read && typeof read.observation === 'string');
    assert.ok('entry' in read && read.entry === 'managed');
    const composed = await runCodexFeedback(
      pluginData,
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
    native!.cwd = root;
    const moved = await runCodexFeedback(
      pluginData,
      { action: 'reply', operation: 'context', purpose: 'status-update', target },
      nativeDeps,
    );
    assert.ok('entry' in moved && moved.entry === 'managed');
    assert.ok('observation' in moved && moved.observation === read.observation);
    assert.deepEqual(await store.read(), before);
  });

  it('should include a github plan revision in direct planning context without entering work', async () => {
    const work = await workIssue(result, 'Follow the plan.', 'company:implement', 'plan');
    const current = await selectCodexIntake(pluginData, deps);
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
            policyDigest: 'c'.repeat(64),
            phase: 'published',
            result: { privateText: 'Keep the smaller approach.' },
          },
        ],
      };
      await save();
    });
    const response = await request('context', { id: work.id }, { threadId: native!.id });
    assert.equal(response.status, 'verified');
    assert.equal(response.feedbackWork, undefined);
    assert.equal((await store.read()).records[0]!.progression, undefined);
  });

  it('should supply retained plan revisions and partial feedback work to direct input', async () => {
    const work = await workIssue();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const decision = {
      mode: 'work' as const,
      reasons: ['Approved revised plan.'],
      plan: 'Use the smaller parser change.',
    };
    const partial = {
      outcome: 'clarification-needed' as const,
      summary: 'Need a value.',
      fullResult: 'Partial work is retained.',
      questions: ['Which value?'],
    };
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      const event = {
        id: 'a'.repeat(64),
        sourceId: 'comment',
        nodeId: 'issue',
        number: 3,
        itemType: 'issue' as const,
        source: '{}',
        revision: 'b'.repeat(64),
        createdAt: 1,
        policyDigest: 'c'.repeat(64),
        phase: 'published' as const,
      };
      record.feedback = {
        baseline: {},
        events: [
          { ...event, result: { privateText: 'Keep the smaller approach.' } },
          {
            ...event,
            id: 'd'.repeat(64),
            work: { selection: record.assessment!, decision, result: partial },
            result: { privateText: 'Which value?' },
          },
        ],
      };
      await save();
    });
    native!.status = 'active';
    native!.turnStatus = 'inProgress';
    const response = await work.run('context', {}, true);
    assert.equal(response.status, 'verified', JSON.stringify(response));
    assert.equal('feedbackWork' in response, false);
    assert.deepEqual((await store.read()).records[0]!.result, result);
  });

  it('should not replay the initial plan after feedback has begun implementation', async () => {
    const work = await workIssue();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.feedback = {
        baseline: {},
        events: [
          {
            id: 'a'.repeat(64),
            sourceId: 'comment',
            number: 3,
            nodeId: 'I_issue',
            itemType: 'issue',
            source: '{}',
            revision: 'b'.repeat(64),
            createdAt: now,
            policyDigest: 'c'.repeat(64),
            phase: 'published',
            work: {
              selection: record.assessment!,
              result: {
                outcome: 'done',
                summary: 'Completed from feedback.',
                fullResult: 'Work retained on feedback.',
              },
            },
          },
        ],
      };
      record.progression = {
        stage: 'implementation',
        via: 'work',
        enteredAt: now,
        workOwner: 'a'.repeat(64),
      };
      await save();
    });
    assert.equal((await work.run('next')).status, 'reconciled');
    assert.equal((await store.read()).records[0]!.continuation?.attempt, undefined);
  });

  for (const scenario of ['approved', 'unapproved', 'unavailable', 'reassignment'] as const) {
    it(`should retain the codex owner and stage unless removal is approved: ${scenario}`, async () => {
      const work = await workIssue();
      await work.run('next');
      work.receive();
      const before = await work.run('context', {}, true);
      assert.ok('issueStage' in before);
      const current = await selectCodexIntake(pluginData, deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      const original = (await store.read()).records[0]!;
      const event = removeFixtureAssignment(fixture);
      if (scenario === 'unapproved' || scenario === 'reassignment')
        event.actor = { ...event.actor, nodeId: 'U_outsider', login: 'outsider' };
      if (scenario === 'unavailable')
        fixture.client.listAssignmentEvents = async () => {
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
          fixture.item.assignees = [fixture.client.identity];
          fixture.events.push({
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
      now += 60_000;
      await reconcileCodexLifecycle(pluginData, deps);
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
      assert.equal(saved.retired, undefined);
      assert.equal(
        gitCalls.some((argv) => argv.includes('remove')),
        false,
      );
    });
  }

  it('should preserve implementation through intake-only policy changes', async () => {
    const work = await workIssue();
    work.receive();
    await work.run('context', {}, true);
    const changed = JSON.parse(await readFile(join(workspace, 'agent.yaml'), 'utf8'));
    Object.assign(changed.github['issue-assignment'], {
      paused: true,
      allowed: [],
      mode: 'plan',
    });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(changed));
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    fixture.item.assignees = [];
    const unresolved = await work.run('context', {}, true);
    assert.equal(unresolved.status, 'verified');
    assert.ok('assignmentObservation' in unresolved);
    assert.equal(unresolved.assignmentObservation?.code, 'assignment-removal-evidence-conflicting');
  });

  for (const mode of ['plan', 'auto'] as const) {
    it(`should enter managed ${mode} through exact direct operator input without a new send or assessment`, async () => {
      const assessment = {
        ...result,
        ...(mode === 'auto'
          ? { decision: { mode: 'plan', reasons: ['Wait for direction.'] } }
          : {}),
      };
      const work = await workIssue(assessment, 'Follow the plan.', 'company:implement', mode);
      native!.turnId = 'operator-implementation';
      native!.turnStatus = 'inProgress';
      native!.status = 'active';
      work.continuation.directOperator = true;
      work.continuation.directScope = 'local';
      work.continuation.native!.operatorInput = async () => ({
        turnId: native!.turnId!,
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
      const current = await selectCodexIntake(pluginData, deps);
      const record = (
        await new CodexDispatchStore(
          current.store.location.root,
          current.store.location.scope,
        ).read()
      ).records[0]!;
      assert.equal(record.progression?.via, 'operator');
      assert.equal(record.continuation?.attempt, undefined);
      assert.equal(record.continuation?.binding?.turnId, 'operator-implementation');
      assert.deepEqual(record.result, assessment);
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
    const work = await workIssue();
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
    const work = await workIssue();
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
      assert.equal(deliveryDeps?.threadId, native!.id);
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
      if (kind === 'pull-request') fixturePullRequest(fixture);
      const selected = await selectCodexIntake(pluginData, deps);
      await rm(selected.store.location.path);
      await writeFile(
        join(workspace, 'agent.yaml'),
        JSON.stringify({ ...manifest, github: { username: 'receiver' } }),
      );
      fixture.item.assignees = [];
      fixture.client.listAssignmentEvents = async () => {
        throw new Error('unexpected assignment history');
      };
      deps.threadId = 'operator';
      deps.activation = async () => {
        throw new Error('manual work must not require a schedule');
      };
      deps.replyConnection = async () => ({
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
      const first = await request('launch', { target, operation: 'context', mode: 'work' });
      assert.equal(first.status, 'routing-required');
      const project = await request('launch', {
        target,
        operation: 'prepare',
        projects,
      });
      assert.equal(project.status, 'routing-required', JSON.stringify(project));
      const store = new CodexDispatchStore(pluginData, selected.store.location.scope);
      assert.equal((await store.read()).run, undefined);
      const scheduled = {
        threadId: 'intake-thread',
        activation: async () => ({ sourceThreadId: 'intake-thread' }),
      };
      const observe = () => request('observe-denials', {}, scheduled);
      await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(manifest));
      await runCodexIntake(pluginData, true, deps);
      assert.equal((await observe()).status, 'ready');
      await store.exclusive(async (state, save) => {
        const record = state.records[0]!;
        record.phase = 'waiting';
        record.retryAfter = now + 60000;
        record.result = {
          version: 1,
          outcome: 'operator-setup-blocker',
          code: 'dispatch-denial-history-unavailable',
          summary: 'Manual preparation was mistaken for missing scheduled history.',
          remediation: 'Recover the original launch through its owner.',
          evidence: [],
          progress: { completed: [], remaining: ['Recover the original launch.'] },
        };
        await save();
      });
      assert.equal((await observe()).status, 'ready');
      const repaired = (await store.read()).records[0]!;
      assert.equal(repaired.id, first.id);
      assert.equal(repaired.phase, 'routing');
      assert.equal(repaired.result, undefined);
      assert.equal(repaired.retryAfter, undefined);
      assert.equal(repaired.preparationObservation, undefined);
      assert.equal(repaired.request, undefined);
      assert.equal((await request('next', { projects }, scheduled)).status, 'idle');
      assert.equal(
        (
          await request(
            'report',
            {
              automationId: 'native-intake',
              currentTimeIso: new Date(now).toISOString(),
            },
            scheduled,
          )
        ).status,
        'report',
      );
      await writeFile(
        join(workspace, 'agent.yaml'),
        JSON.stringify({ ...manifest, github: { username: 'receiver' } }),
      );
      const resumed = await request('launch', { target, operation: 'context' });
      assert.equal(resumed.id, first.id);
      assert.equal(resumed.digest, project.digest);
      const prepared = await request('launch', {
        target,
        operation: 'prepare',
        projects,
        assessment: { complexity: 'medium', reason: 'Reuse existing issue work.' },
        title: 'MANUAL ISSUE',
      });
      assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
      assert.ok(prepared.request);
      if (kind === 'pull-request')
        assert.ok(
          gitCalls.some((argv) =>
            argv.includes('refs/heads/existing-work:refs/remotes/origin/existing-work'),
          ),
        );
      created();
      const recovered = await request('launch', { target, operation: 'reconcile' });
      assert.equal(recovered.status, 'existing', JSON.stringify(recovered));
      const state = await new CodexDispatchStore(pluginData, selected.store.location.scope).read();
      assert.equal(state.records.length, 1);
      assert.equal(state.records[0]!.intakeId, undefined);
      assert.equal(state.records[0]!.issueMode, 'work');
      assert.equal(state.run?.automationId, 'native-intake');
      const nativeContext = await request('context', { id: first.id }, { threadId: native!.id });
      assert.equal(nativeContext.status, 'verified', JSON.stringify(nativeContext));
      const submitted = await historicalResult(
        'result',
        { id: first.id, result },
        { threadId: native!.id },
      );
      assert.equal(submitted.status, 'recorded', JSON.stringify(submitted));
      const continuation = await runCodexContinuation(
        pluginData,
        { action: 'context', id: String(first.id) },
        {
          ...deps,
          threadId: native!.id,
          continuationNative: async (_source, attempt) => ({
            status: 'verified',
            turnId: attempt.turnId!,
            ended: false,
          }),
        },
      );
      assert.equal(continuation.status, 'verified', JSON.stringify(continuation));
      assert.ok('issueStage' in continuation && continuation.issueStage === 'implementation');
      const retirement = await request('retire', { id: first.id }, { threadId: 'operator' });
      assert.equal(retirement.status, 'retire-available', JSON.stringify(retirement));
    });
});
