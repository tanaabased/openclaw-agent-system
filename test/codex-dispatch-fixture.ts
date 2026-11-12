import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationHash } from '../agent/automation-hash.ts';
import cleanupConfiguration from '../agent/cleanup-configuration.ts';
import { runCodexIntake } from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/identity/codex-workspace-binding.ts';
import { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import type { ClaimClient } from '../agent/tasks/dispatch/assignment-claim.ts';
import CodexAssignmentClaims, {
  codexInstanceStore,
} from '../agent/tasks/dispatch/codex-assignment-claims.ts';
import type { DispatchNativeThread } from '../agent/tasks/dispatch/codex-dispatch-native.ts';
import CodexDispatchStore from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import {
  runCodexDispatch,
  type CodexDispatchDependencies,
} from '../agent/tasks/dispatch/codex-dispatch.ts';
import runCodexContinuation, {
  type CodexContinuationDependencies,
} from '../agent/tasks/implementation/codex-continuation.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

export default function codexDispatchFixture() {
  const fixtureState = {} as {
    root: string;
    workspace: string;
    pluginData: string;
    codexHome: string;
    source: string;
    worktree: string;
    commonDir: string;
    now: number;
    fixture: ReturnType<typeof intakeFixture>;
    deps: CodexDispatchDependencies;
    native: DispatchNativeThread | undefined;
    projects: unknown[];
    gitCalls: string[][];
  };
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
    outcome: 'plan-ready',
    summary: 'Repair the contained behavior.',
    reviewSummary: 'Repair the contained behavior.',
  };
  const commit = '1'.repeat(40);
  const request = async (
    action: string,
    input: unknown = {},
    overrides: CodexDispatchDependencies = {},
  ) =>
    (await runCodexDispatch(fixtureState.pluginData, action, input, {
      ...fixtureState.deps,
      ...overrides,
    })) as Record<string, unknown>;
  const readDispatchState = async (): Promise<Record<string, unknown>> => {
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    return new CodexDispatchStore(current.store.location.root, current.store.location.scope).read();
  };
  const renderAssessment = async (result: unknown, overrides: CodexDispatchDependencies = {}) =>
    request(
      'assessment',
      {
        action: 'assessment',
        operation: 'render',
        target: 'https://github.com/owner/repo/issues/3',
        result,
      },
      overrides,
    );
  const next = () => request('next', { projects: fixtureState.projects });
  const writeCleanup = (graceMinutes: number) =>
    writeFile(
      join(fixtureState.root, 'openclaw.json'),
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
      currentTimeIso: new Date(fixtureState.now).toISOString(),
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
    fixtureState.native = {
      id: 'issue-thread',
      cwd: fixtureState.worktree,
      name: '#3: REPAIR CONTAINED BEHAVIOR',
      model: 'gpt-6.1-sol',
      effort: 'high',
      status: 'active',
      turnStatus: 'inProgress',
      turnId: 'first-turn',
    };
  }
  function operatorLaunch() {
    fixtureState.deps.threadId = 'operator';
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
    fixtureState.deps.deliveryConnect = async () => ({
      client: await fixtureState.deps.connect!(
        fixtureState.workspace,
        new AbortController().signal,
      ),
      account: {
        identity: fixtureState.fixture.client.identity,
        execute: async (argv) => {
          const value = argv.includes('repos/owner/repo/pulls/7')
            ? observed
            : {
                databaseId: fixtureState.fixture.item.databaseId,
                nodeId: fixtureState.fixture.item.nodeId,
                number: fixtureState.fixture.item.number,
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
    fixtureState.root = await realpath(await mkdtemp(join(tmpdir(), 'codex_dispatch-')));
    [
      fixtureState.workspace,
      fixtureState.pluginData,
      fixtureState.codexHome,
      fixtureState.source,
      fixtureState.worktree,
      fixtureState.commonDir,
    ] = (['workspace', 'plugin', 'codex', 'source', 'worktree', 'common'] as const).map((name) =>
      join(fixtureState.root, name),
    ) as [string, string, string, string, string, string];
    for (const path of [
      fixtureState.workspace,
      fixtureState.codexHome,
      fixtureState.source,
      fixtureState.worktree,
      fixtureState.commonDir,
    ])
      await mkdir(path);
    await writeFile(join(fixtureState.root, 'openclaw.json'), '{}');
    await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(manifest));
    await bindCodexWorkspace(fixtureState.pluginData, fixtureState.workspace);
    fixtureState.fixture = intakeFixture();
    fixtureState.now = baseline;
    await runCodexIntake(fixtureState.pluginData, true, {
      codexHome: fixtureState.codexHome,
      now: () => fixtureState.now,
      connect: async () => fixtureState.fixture.client,
    });
    fixtureState.now += 60000;
    await runCodexIntake(fixtureState.pluginData, false, {
      codexHome: fixtureState.codexHome,
      assertActive: async () => {},
      now: () => fixtureState.now,
      connect: async () => fixtureState.fixture.client,
    });
    fixtureState.native = undefined;
    fixtureState.projects = [
      {
        projectId: 'saved-project',
        path: fixtureState.source,
        projectKind: 'local',
        hostId: 'local',
        isGitRepository: true,
      },
    ];
    fixtureState.gitCalls = [];
    const branches = new Map<string, string>();
    fixtureState.deps = {
      readCleanupConfiguration: () =>
        cleanupConfiguration({
          env: { OPENCLAW_CONFIG_PATH: join(fixtureState.root, 'openclaw.json') },
        }),
      codexHome: fixtureState.codexHome,
      assertActive: async () => {},
      now: () => fixtureState.now,
      feedbackConnect: async () =>
        ({
          client: fixtureState.fixture.client,
          comments: {
            identity: fixtureState.fixture.client.identity,
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
          path: fixtureState.source,
          source: 'https://github.com/owner/repo.git',
          identity: 'github.com/owner/repo',
          checkout: fixtureState.source,
        });
        return fixtureState.source;
      },
      connect: async () =>
        Object.assign({}, fixtureState.fixture.client, {
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
        fixtureState.gitCalls.push(argv);
        if (argv[0] === 'branch') return branches.get(_cwd) ?? '';
        if (argv[0] === 'switch') {
          branches.set(_cwd, argv[1] === '-c' ? argv[2]! : argv[1]!);
          return '';
        }
        if (argv.length === 1 && argv[0] === 'remote') return 'origin';
        if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
        if (argv.includes('--git-common-dir')) return fixtureState.commonDir;
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
            turnId:
              threadId === fixtureState.native?.id
                ? fixtureState.native.turnId!
                : 'operator-' + fixtureState.now,
            inputId: 'operator-input',
          };
        },
        async occurrence(threadId) {
          assert.ok(
            !['operator', 'issue-thread'].includes(threadId),
            'manual callers must not require a heartbeat',
          );
          return {
            id: 'run-' + fixtureState.now,
            automationId: 'native-intake',
            currentTimeIso: new Date(fixtureState.now).toISOString(),
          };
        },
        async assessmentSkill(_cwd, id) {
          return {
            name: id,
            path: join(fixtureState.root, 'SKILL.md'),
            scope: 'user',
            digest: 'a'.repeat(64),
          };
        },
        async rename(threadId, title) {
          assert.equal(threadId, fixtureState.native?.id);
          fixtureState.native!.name = title;
        },
        async deniedCreation() {
          return { turnId: 'denied-turn', callId: 'denied-call' };
        },
        async find(input) {
          if (input.threadId && input.threadId !== fixtureState.native?.id)
            throw new Error('dispatch-native-readback-diverged');
          return fixtureState.native;
        },
      },
    };
  });
  afterEach(async () => {
    await rm(fixtureState.root, { recursive: true, force: true });
  });
  async function claiming(mode: 'local' | 'swarm' = 'swarm') {
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
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
          createdAt: new Date(fixtureState.now).toISOString(),
          updatedAt: new Date(fixtureState.now).toISOString(),
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
    const store = codexInstanceStore(fixtureState.pluginData);
    fixtureState.deps.claims = new CodexAssignmentClaims(store, () => client);
    return { store, client, comments };
  }
  async function configureAssessment(assessment: unknown) {
    const configured = structuredClone(manifest);
    Object.assign(configured.github['issue-assignment'], { assessment });
    await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(configured));
    await runCodexIntake(fixtureState.pluginData, true, {
      codexHome: fixtureState.codexHome,
      now: () => fixtureState.now,
      connect: async () => fixtureState.fixture.client,
    });
  }
  async function workflow(enabled: boolean) {
    const configured = structuredClone(manifest);
    configured.github['issue-assignment'].allowed = enabled
      ? manifest.github['issue-assignment'].allowed
      : [];
    await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(configured));
  }
  async function reassign() {
    fixtureState.now += 2000;
    fixtureState.fixture.events.push({
      ...fixtureState.fixture.events[0]!,
      nodeId: 'E_assignment_' + fixtureState.now,
      databaseId: fixtureState.now,
      createdAt: new Date(fixtureState.now).toISOString(),
    });
    await runCodexIntake(fixtureState.pluginData, false, {
      codexHome: fixtureState.codexHome,
      assertActive: async () => {},
      now: () => fixtureState.now,
      connect: async () => fixtureState.fixture.client,
    });
  }
  async function addPendingSecondIssue() {
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
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
    const connect = fixtureState.deps.connect!;
    fixtureState.deps.connect = async (...args) => {
      const client = await connect(...args);
      return {
        ...client,
        getItem: async (owner, name, number) =>
          number === 4
            ? { ...fixtureState.fixture.item, ...admission.issue }
            : client.getItem(owner, name, number),
      };
    };
  }
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
    await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(configured));
    await runCodexIntake(fixtureState.pluginData, true, {
      codexHome: fixtureState.codexHome,
      now: () => fixtureState.now,
      connect: async () => fixtureState.fixture.client,
    });
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
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
    fixtureState.deps.activation = async () => ({
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
    await request('reconcile', { id: prepared.id, receipt: { threadId: fixtureState.native!.id } });
    if (assessment) await renderAssessment(assessment, { threadId: fixtureState.native!.id });
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnStatus = 'completed';
    fixtureState.native!.turnEnded = true;
    let received = false;
    const continuation: CodexContinuationDependencies = {
      ...fixtureState.deps,
      continuationNative: async (_source, attempt) =>
        received || attempt.origin === 'assessment'
          ? {
              status: 'verified',
              turnId:
                attempt.origin === 'assessment' ? attempt.turnId! : fixtureState.native!.turnId!,
              ended:
                fixtureState.native!.turnEnded ??
                ['completed', 'failed', 'interrupted'].includes(fixtureState.native!.turnStatus!),
            }
          : { status: 'uncertain' },
    };
    const run = (action: string, input: object = {}, child: boolean | string = false) =>
      runCodexContinuation(
        fixtureState.pluginData,
        { action, ...(action === 'next' ? {} : { id: prepared.id }), ...input },
        {
          ...continuation,
          threadId:
            typeof child === 'string' ? child : child ? fixtureState.native!.id : 'intake-thread',
        },
      );
    return {
      id: prepared.id,
      run,
      continuation,
      receive() {
        received = true;
        fixtureState.native!.turnId = 'implementation-turn';
        delete fixtureState.native!.turnEnded;
        fixtureState.native!.status = 'active';
        fixtureState.native!.turnStatus = 'inProgress';
        fixtureState.native!.turnEnded = false;
      },
    };
  }
  async function workStore() {
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    return new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  }
  return Object.assign(fixtureState, {
    models,
    manifest,
    result,
    commit,
    request,
    readDispatchState,
    renderAssessment,
    next,
    writeCleanup,
    report,
    prepare,
    created,
    operatorLaunch,
    selectedPullRequest,
    claiming,
    configureAssessment,
    workflow,
    reassign,
    addPendingSecondIssue,
    workIssue,
    workStore,
  });
}
