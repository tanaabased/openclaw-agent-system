import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import runCodexContinuation, {
  type CodexContinuationDependencies,
} from '../agent/codex-continuation.ts';
import { automationHash } from '../agent/automation-hash.ts';
import { codexItemOccupied } from '../agent/codex-capacity.ts';
import assert from 'node:assert/strict';
import { attemptedAnnouncement } from './delivery-announcement-fixture.ts';
import { readFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import properLockfile from 'proper-lockfile';

import { runCodexDispatch, type CodexDispatchDependencies } from '../agent/codex-dispatch.ts';
import type { DispatchNativeThread } from '../agent/codex-dispatch-native.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import { runCodexIntake, selectCodexIntake } from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { githubNotificationMarkdownText } from '../channels/github/presentation/card.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';
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
    notifications: {
      'schema-version': 2,
      'max-concurrent-items': 2,
      runtimes: ['codex'],
      'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
      'issue-assignment': {
        mode: 'plan',
        allowed: [{ login: 'receiver', 'node-id': 'U_receiver' }],
      },
    },
  },
};
const result = {
  version: 1,
  outcome: 'plan-ready',
  summary: 'Repair the contained behavior.',
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
  const next = () => request('next', { projects });
  const report = () =>
    request('report', {
      automationId: 'native-intake',
      currentTimeIso: new Date(now).toISOString(),
    });
  async function prepare() {
    const selected = await next();
    assert.equal(selected.status, 'routing-required', JSON.stringify(selected));
    const prepared = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
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
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex_dispatch-')));
    [workspace, pluginData, codexHome, source, worktree, commonDir] = (
      ['workspace', 'plugin', 'codex', 'source', 'worktree', 'common'] as const
    ).map((name) => join(root, name)) as [string, string, string, string, string, string];
    for (const path of [workspace, codexHome, source, worktree, commonDir]) await mkdir(path);
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
    deps = {
      codexHome,
      assertActive: async () => {},
      now: () => now,
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
        if (argv.length === 1 && argv[0] === 'remote') return 'origin';
        if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
        if (argv.includes('--git-common-dir')) return commonDir;
        if (argv.includes('--is-bare-repository')) return 'false';
        if (argv.includes('--show-toplevel')) return _cwd;
        if (argv[0] === 'rev-parse') return commit;
        return '';
      },
      native: {
        async unsubmittedCreation() {
          return undefined;
        },
        async occurrence() {
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

  for (const loseResponse of [false, true]) {
    it(`should retain one assessment summary in codex after ${loseResponse ? 'a lost response' : 'successful publication'}`, async () => {
      const prepared = await prepare();
      created();
      const child = { threadId: 'issue-thread' };
      await request('context', { id: prepared.id }, child);
      const privateResult = {
        ...result,
        fullAssessment: 'The complete private technical plan and its limits.',
      };
      const recorded = await request('result', { id: prepared.id, result: privateResult }, child);
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
      assert.equal(
        (
          await summary({
            operation: 'candidate',
            digest: composed.digest,
            publicText:
              'The proposed change would show your result immediately, so you can keep going.',
          })
        ).status,
        'candidate-recorded',
      );
      const preview = await summary({ operation: 'publish' });
      assert.equal(preview.destination, 'https://github.com/owner/repo/issues/3');
      assert.equal(
        (await summary({ operation: 'publish', digest: preview.digest })).status,
        loseResponse ? 'blocked' : 'published',
      );
      if (loseResponse) {
        assert.equal(
          (await summary({ operation: 'publish', digest: preview.digest })).status,
          'reconcile-required',
        );
        assert.equal((await summary({ operation: 'reconcile' })).status, 'published');
      }
      assert.equal((await summary({ operation: 'compose' })).status, 'published');
      assert.equal(writes, 1);
      assert.deepEqual(
        (await request('context', { id: prepared.id }, child)).previousResult,
        privateResult,
      );
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
    assert.equal(((await request('inspect')).records as unknown[]).length, 2);
    const started = await report();
    assert.match(String(started.response), /2 issues started/);
    assert.ok(String(started.response).includes('[owner/repo#3](codex://threads/issue-thread-3)'));
    assert.ok(String(started.response).includes('[owner/repo#4](codex://threads/issue-thread-4)'));

    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    checked.length = 0;
    assert.deepEqual(await next(), { status: 'at-capacity', changed: false });
    assert.deepEqual(checked, []);
    assert.equal((await report()).status, 'report');

    await request('result', { id: first.id, result }, { threadId: 'issue-thread-3' });
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
    assert.equal(((await request('inspect')).records as unknown[]).length, 3);
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
    const before = (await request('inspect')).records as Record<string, unknown>[];
    native!.turnId = 'authorized-follow-up';
    native!.followUpUserTurn = true;
    const ordinaryGit = deps.git!;
    deps.git = async (cwd, argv) =>
      argv.includes('HEAD')
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
    const after = (await request('inspect')).records as Record<string, unknown>[];
    assert.deepEqual(after[0]!.result, before[0]!.result);
    assert.equal(after[0]!.worktree, worktree);
    assert.equal((await request('handoff', { id: prepared.id }, operator)).changed, false);
    deps.native!.find = async () => {
      throw new Error('must not poll handed-off chat');
    };
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    await assert.rejects(
      request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-handed-off/,
    );
    fixture.item.state = 'closed';
    const retire = await request('retire', { id: prepared.id }, { threadId: 'operator' });
    assert.equal(retire.status, 'retire-available');
  });

  it('should preserve issue state when native access needs host approval', async () => {
    const prepared = await prepare();
    const before = await request('inspect');
    for (const code of ['EPERM', 'EACCES', 'automation-thread-host-access-required']) {
      deps.native!.find = async () => {
        throw Object.assign(new Error('denied'), { code });
      };
      await assert.rejects(request('reconcile', { id: prepared.id }), { code });
      assert.deepEqual({ ...(await request('inspect')), run: before.run }, before);
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
    assert.equal(stale.nextAction, 'report');
    assert.deepEqual(stale.request, {
      action: 'report',
      automationId: 'native-intake',
      currentTimeIso: new Date(now).toISOString(),
    });
    const fresh = await report();
    assert.equal(fresh.status, 'continue');
    assert.equal(fresh.remainingActions, 12);
    assert.equal((await next()).status, 'routing-required');
    assert.equal(((await request('inspect')).records as unknown[]).length, 1);
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
    assert.equal(((await request('inspect')).records as unknown[]).length, 1);
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
    await assert.rejects(
      request('handoff', { id: prepared.id }, child),
      /dispatch-handoff-user-turn-required/,
    );
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

  it('should preserve a handoff preview across feedback scans and intake presentation updates', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    await request('result', { id: prepared.id, result }, child);
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
      record.notice = 'f'.repeat(64);
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
    await request('result', { id: prepared.id, result }, child);
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
    assert.equal((refreshed.previousResult as typeof result).summary, 'Revised scope.');
    assert.equal(
      (await request('handoff', { id: prepared.id, digest: refreshed.digest }, child)).status,
      'handed-off',
    );
  });

  async function configureAssessment(assessment: unknown) {
    const configured = structuredClone(manifest);
    Object.assign(configured.github.notifications['issue-assignment'], { assessment });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
    await runCodexIntake(pluginData, true, {
      codexHome,
      now: () => now,
      connect: async () => fixture.client,
    });
  }

  async function workflow(enabled: boolean) {
    const configured = structuredClone(manifest);
    Object.assign(configured.github.notifications['issue-assignment'], { enabled });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
  }

  it('should stop queued dispatch before credentials and resume the retained assignment', async () => {
    const selected = await next();
    await workflow(false);
    const blocked = {
      connect: async () => {
        throw new Error('must not authenticate');
      },
    };
    await assert.rejects(request('next', { projects }, blocked), /dispatch-policy-disabled/);
    await assert.rejects(
      request(
        'prepare',
        {
          id: selected.id,
          digest: selected.digest,
          title: 'repair contained behavior',
          assessment: { complexity: 'medium', reason: 'Retained selection.' },
        },
        blocked,
      ),
      /dispatch-policy-disabled/,
    );
    const stopped = await request('inspect');
    assert.equal((stopped.records as { id: string }[])[0]!.id, selected.id);
    await workflow(true);
    await assert.rejects(next(), /dispatch-policy-reconciliation-required/);
    await runCodexIntake(pluginData, true, {
      codexHome,
      now: () => now,
      connect: async () => fixture.client,
    });
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

  it('should finish disabled intake reports without polling assessments or duplicating resumed work', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    await next();
    assert.match(String((await report()).response), /1 issue started/);
    deps.native!.find = async () => {
      throw new Error('intake must not poll the retained assessment');
    };
    await workflow(false);
    const disabled = {
      ...deps,
      connect: async () => {
        throw new Error('disabled intake must not authenticate');
      },
    };
    for (const repeated of [false, true]) {
      now += 60000;
      const scan = await runCodexIntake(pluginData, false, disabled);
      assert.equal('code' in scan && scan.code, 'intake-policy-disabled');
      await assert.rejects(next(), /dispatch-policy-disabled/);
      const reported = await report();
      assert.equal(reported.status, 'report');
      assert.match(String(reported.response), /intake-policy-disabled/);
      assert.doesNotMatch(String(reported.response), /1 issue started|plan-ready/);
      assert.equal(String(reported.response).includes('DONT_NOTIFY'), repeated);
    }
    await workflow(true);
    now += 60000;
    await runCodexIntake(pluginData, true, deps);
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    assert.doesNotMatch(String((await report()).response), /1 issue started|plan-ready/);
    const records = (await request('inspect')).records as { id: string; phase: string }[];
    assert.equal(records.length, 1);
    assert.equal(records[0]!.id, prepared.id);
    assert.equal(records[0]!.phase, 'assessing');
  });

  it('should discard a creation request when policy changes during preparation', async () => {
    const selected = await next();
    const connect = deps.connect!;
    await assert.rejects(
      request(
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
      ),
      /dispatch-policy-changed/,
    );
    const retained = (await request('inspect')).records as { phase: string; request?: unknown }[];
    assert.equal(retained[0]!.phase, 'routing');
    assert.equal(retained[0]!.request, undefined);
  });

  it('should still enforce current authority when a disabled workflow retains a child', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    await request('context', { id: prepared.id }, child);
    const configured = structuredClone(manifest);
    Object.assign(configured.github.notifications['issue-assignment'], {
      enabled: false,
      allowed: [{ login: 'other', 'node-id': 'U_other' }],
    });
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(configured));
    await assert.rejects(
      request('result', { id: prepared.id, result }, child),
      /dispatch-assignment-actor-not-allowed/,
    );
    const records = (await request('inspect')).records as { phase: string; result?: unknown }[];
    assert.equal(records[0]!.phase, 'assessing');
    assert.equal(records[0]!.result, undefined);
  });

  for (const phase of ['creating', 'assessing', 'complete'] as const)
    it(`should retain ${phase} work and accept its verified child result while disabled`, async () => {
      const prepared = await prepare();
      const child = { threadId: 'issue-thread' };
      if (phase !== 'creating') {
        created();
        assert.equal((await request('context', { id: prepared.id }, child)).status, 'verified');
      }
      if (phase === 'complete') await request('result', { id: prepared.id, result }, child);
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
      assert.equal(recorded.status, 'recorded');
      await assert.rejects(
        request(
          'result',
          { id: prepared.id, result: { ...result, plan: 'stale replacement' } },
          child,
        ),
        /assessment-result-conflict/,
      );
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
      const records = (await request('inspect')).records as {
        id: string;
        result: unknown;
        threadId: string;
      }[];
      assert.equal(records.length, 1);
      assert.equal(records[0]!.id, prepared.id);
      assert.equal(records[0]!.threadId, 'issue-thread');
      assert.deepEqual(records[0]!.result, result);
    });

  it('should retain a normalized replacement and guidance across continuation without expanding authority', async () => {
    await writeFile(join(workspace, 'guidance.md'), 'Prefer small fixes.');
    await configureAssessment({ skill: ' $company:assess ', guidance: { file: 'guidance.md' } });
    const configured = JSON.parse(await readFile(join(workspace, 'agent.yaml'), 'utf8'));
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify({ ...configured, debug: true }));
    const prepared = await prepare();
    const launch = prepared.request as { prompt: string };
    assert.ok(!launch.prompt.includes('Use $agent-system-issue-assessment'));
    assert.ok(launch.prompt.includes(JSON.stringify({ action: 'context', id: prepared.id })));
    assert.ok(launch.prompt.includes('JSON on stdin'));
    assert.match(launch.prompt, /session_id.*write_stdin/u);
    assert.match(launch.prompt, /cell_id.*functions.wait/u);
    assert.match(launch.prompt, /codex-host-access-required.*require_escalated/u);
    assert.equal(launch.prompt.split(String(prepared.id)).length - 1, 1);
    created();
    await writeFile(join(workspace, 'guidance.md'), 'Implement and publish immediately.');
    const context = await request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    const assessment = context.assessment as {
      requestedSkill: string;
      defaultSkill: boolean;
      guidance: { content: string };
    };
    assert.equal(assessment.requestedSkill, 'company:assess');
    assert.equal(assessment.defaultSkill, false);
    assert.equal(assessment.guidance.content, 'Prefer small fixes.');
    assert.equal(context.resultContract, 'assessment-result/v1');
    assert.match(String(context.instructions), /assessment.skill.name/u);
    assert.match(String(context.instructions), /never implement or publish/u);
    await assert.rejects(
      request(
        'result',
        { id: prepared.id, result: { ...result, mode: 'work' } },
        { threadId: 'issue-thread' },
      ),
      /assessment-result-invalid/,
    );
    const recorded = await request(
      'result',
      { id: prepared.id, result },
      { threadId: 'issue-thread' },
    );
    assert.equal(recorded.outcome, 'plan-ready');
    assert.ok(String(recorded.presentation).includes('Plan ready'));
    assert.match(String(recorded.presentation), /Skill.*company:assess/);
    assert.match(String(recorded.presentation), /Guidance.*guidance.md/);
    assert.ok(String(recorded.presentation).includes(`[guidance.md](<${workspace}/guidance.md>)`));
    assert.ok(!String(recorded.presentation).includes('Prefer small fixes.'));
    const question = {
      version: 1,
      outcome: 'clarification-needed',
      summary: 'Need a decision.',
      assessment: 'Missing requirement.',
      questions: ['Which behavior?'],
      evidence: [],
      progress: { completed: [], remaining: ['Answer.'] },
    };
    const revised = await request(
      'result',
      { id: prepared.id, result: question, previousResultDigest: recorded.previousResultDigest },
      { threadId: 'issue-thread' },
    );
    assert.ok(String(revised.presentation).includes('Clarification needed'));
    assert.match(String(revised.presentation), /Skill.*company:assess/);
    assert.match(String(revised.presentation), /Guidance.*guidance.md/);
  });

  it('should retain ordinary skill output through clarification and a same-chat revision', async () => {
    await configureAssessment({ skill: 'company:assess' });
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    const context = await request('context', { id: prepared.id }, child);
    assert.equal(context.currentTurnId, 'first-turn');
    assert.equal(context.previousResultTurnId, undefined);
    assert.match(String(context.instructions), /ordinary assessment skill/);
    assert.match(String(context.instructions), /fullAssessment/);
    assert.match(String(context.instructions), /consistency check in this turn/);
    assert.match(String(context.instructions), /without another adaptation or submission/);
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
    const saved = await request('result', { id: prepared.id, result: question }, child);
    assert.ok(String(saved.presentation).includes(original));
    const current = await request('context', { id: prepared.id }, child);
    assert.deepEqual(current.previousResult, question);
    assert.equal(current.previousResultTurnId, current.currentTurnId);
    assert.equal(current.previousPresentation, saved.presentation);
    assert.deepEqual(await request('result', { id: prepared.id, result: question }, child), saved);

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
    await assert.rejects(
      request('result', { id: prepared.id, result: revised }, child),
      /assessment-result-conflict/,
    );
    const recorded = await request(
      'result',
      { id: prepared.id, previousResultDigest: followUp.previousResultDigest, result: revised },
      child,
    );
    assert.ok(String(recorded.presentation).includes(revised.fullAssessment));
    const retained = await request('context', { id: prepared.id }, child);
    assert.deepEqual(retained.previousResult, revised);
    assert.equal(retained.previousResultTurnId, 'later-answer');
    assert.equal(retained.previousPresentation, recorded.presentation);
    assert.deepEqual(retained.effective, current.effective);
    native!.followUpUserTurn = true;
    const handoff = await request('handoff', { id: prepared.id }, child);
    assert.deepEqual(handoff.previousResult, revised);
    const transitioned = await request(
      'handoff',
      { id: prepared.id, digest: handoff.digest },
      child,
    );
    assert.deepEqual(transitioned.previousResult, revised);
    assert.deepEqual(
      (await request('handoff', { id: prepared.id }, child)).previousResult,
      revised,
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
    const records = (await request('inspect')).records as Array<{ request?: unknown }>;
    assert.equal(records[0]!.request, undefined);
    deps.native!.assessmentSkill = available;
    now += 300001;
    assert.equal((await prepare()).id, selected.id);
  });

  it('should reject skill changes in the child without replacing the native request', async () => {
    const prepared = await prepare();
    created();
    const selected = deps.native!.assessmentSkill;
    deps.native!.assessmentSkill = async (cwd, id) => ({
      ...(await selected(cwd, id)),
      digest: 'b'.repeat(64),
    });
    await assert.rejects(
      request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-skill-changed/,
    );
    const records = (await request('inspect')).records as Array<{ request: unknown }>;
    assert.deepEqual(records[0]!.request, prepared.request);
  });

  it('should retain an inferred qualified skill when a later catalog makes the bare id ambiguous', async () => {
    await configureAssessment({ skill: '$assess' });
    const resolve = deps.native!.assessmentSkill;
    const calls: string[] = [];
    deps.native!.assessmentSkill = async (cwd, id) => {
      calls.push(id);
      if (native && id === 'assess') throw new Error('dispatch-assessment-skill-ambiguous');
      return resolve(cwd, 'company:assess');
    };
    const prepared = await prepare();
    created();
    const context = await request('context', { id: prepared.id }, { threadId: 'issue-thread' });
    const assessment = context.assessment as { requestedSkill: string; skill: { name: string } };
    assert.equal(assessment.requestedSkill, 'assess');
    assert.equal(assessment.skill.name, 'company:assess');
    assert.deepEqual(calls, ['assess', 'company:assess']);
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
    const records = (await request('inspect')).records as Array<{ request?: unknown }>;
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

  it('should preserve the default for legacy receipts after replacement configuration changes', async () => {
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
    assert.equal(assessment.defaultSkill, true);
    assert.equal(assessment.skill.name, 'agent-system:agent-system-issue-assessment');
    assert.equal(assessment.guidance, undefined);
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

  it('should retire a closed issue with a pending launch while preserving its evidence', async () => {
    const first = await prepare();
    const operator = {
      threadId: 'operator',
      activation: async (_data: unknown, _options: unknown, paused?: boolean) => {
        assert.equal(paused, true);
        return { sourceThreadId: 'intake-thread' };
      },
    };
    await assert.rejects(request('retire', { id: first.id }), /dispatch-operator-caller-required/);
    await assert.rejects(
      request('retire', { id: first.id }, operator),
      /dispatch-retire-closed-issue-required/,
    );
    fixture.item.state = 'closed';
    const before = (await request('inspect')).records as Record<string, unknown>[];
    const preview = await request('retire', { id: first.id }, operator);
    assert.equal(preview.status, 'retire-available');
    assert.deepEqual((await request('inspect')).records, before);
    await assert.rejects(
      request('retire', { id: first.id, digest: 'stale' }, operator),
      /dispatch-recovery-stale/,
    );
    assert.equal(
      (await request('retire', { id: first.id, digest: preview.digest }, operator)).status,
      'retired',
    );
    const after = (await request('inspect')).records as Record<string, unknown>[];
    assert.deepEqual(after[0], {
      ...before[0],
      retired: { at: now, by: 'operator' },
      workflowStatus: 'obsolete',
    });
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    await assert.rejects(
      request('context', { id: first.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-retired/,
    );
    fixture.item.state = 'open';
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    deps.native!.unsubmittedCreation = async () => ({ turnId: 'retired-preparation' });
    await request('reconcile', { id: first.id });
    await reassign();
    const second = await prepare();
    assert.notEqual(second.id, first.id);
  });

  it('should allow retirement from a handed-off operator chat but not an active issue chat', async () => {
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
    await assert.rejects(
      request('retire', { id: first.id }, operator),
      /dispatch-operator-caller-required/,
    );
    await store.exclusive(async (state, save) => {
      state.records.at(-1)!.handoff = { at: now, by: 'operator', turnId: 'operator-turn' };
      await save();
    });
    const preview = await request('retire', { id: first.id }, operator);
    assert.equal(preview.status, 'retire-available');
    assert.equal(
      (await request('retire', { id: first.id, digest: preview.digest }, operator)).status,
      'retired',
    );
  });

  it('should preserve a completed assessment and dispatch once after an explicit reset and new assignment', async () => {
    const first = await prepare();
    created();
    await request('result', { id: first.id, result }, { threadId: 'issue-thread' });
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    await next();
    await reassign();
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    const operator = { threadId: 'operator' };
    const before = await request('inspect');
    const preview = await request('reset', { id: first.id }, operator);
    assert.equal(preview.status, 'reset-available');
    assert.deepEqual(await request('inspect'), before);
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
      request('result', { id: first.id, result }, { threadId: 'issue-thread' }),
      /dispatch-assessment-reset/,
    );
    await reassign();
    const second = await prepare();
    assert.notEqual(second.id, first.id);
    const records = (await request('inspect')).records as {
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
    assert.equal(((await request('inspect')).records as unknown[]).length, 2);
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
    await request('result', { id: first.id, result }, { threadId: 'issue-thread' });
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
    const records = (await request('inspect')).records as { reset?: unknown; result: unknown }[];
    assert.equal(records[0]!.reset, undefined);
    assert.deepEqual(records[0]!.result, result);
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
    const state = await request('inspect');
    assert.deepEqual((state.records as { deniedCreations: unknown[] }[])[0]!.deniedCreations[0], {
      request: first.request,
      createdAt: now,
      recoveredAt: now,
      turnId: 'denied-turn',
      callId: 'denied-call',
    });
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
    const state = await request('inspect');
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
      /dispatch-intake-caller-required/,
    );
    assert.equal(gitCalls.length, 0);
  });

  it('should retain one quiet setup blocker and resume the same assignment after project setup', async () => {
    projects = [];
    const blocked = await next();
    assert.equal(blocked.code, 'dispatch-project-registration-unavailable');
    assert.equal(blocked.changed, true);
    assert.match(String(blocked.message), /^> ## ⚠️ Add the project to continue\n/u);
    assert.ok(String(blocked.message).includes('- **Project name:** repo\n'));
    assert.ok(
      String(blocked.message).includes(
        '- **Folder path:** ' + githubNotificationMarkdownText(source) + '\n',
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
    assert.ok(String(blocked.message).includes(githubNotificationMarkdownText(source)));
    assert.match(String(blocked.message), /Reconcile through Install/u);
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
    assert.ok(String(blocked.message).includes(githubNotificationMarkdownText(path)));
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
    assert.equal(
      (retained.evidence as { body: string }).body,
      'The acceptance criteria require a safe plan.',
    );
    const records = (await request('inspect')).records as {
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
    const state = await request('inspect');
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
    await request('reconcile', { id: prepared.id });
    assert.equal((await next()).changed, false);
    now += 300001;
    deps.native!.unsubmittedCreation = async (threadId, pending, turnId) => {
      assert.equal(threadId, 'intake-thread');
      assert.deepEqual(pending, { createdAt: preparedAt, turnId: 'run-' + preparedAt });
      assert.equal(turnId, 'run-' + now);
      return { turnId: 'run-' + preparedAt };
    };
    const retry = await prepare();
    assert.equal(retry.id, prepared.id);
    const original = prepared.request as { prompt: string; model: string; thinking: string };
    const replacement = retry.request as typeof original;
    assert.notEqual(replacement.prompt, original.prompt);
    assert.equal(replacement.model, original.model);
    assert.equal(replacement.thinking, original.thinking);
    const record = ((await request('inspect')).records as Record<string, unknown>[])[0]!;
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
    const record = ((await request('inspect')).records as Record<string, unknown>[])[0]!;
    assert.deepEqual(record.request, prepared.request);
    assert.equal(record.unsubmittedCreations, undefined);
  });

  for (const proof of [false, true])
    it(`should reclassify legacy revoked creation with ${proof ? 'verified' : 'unknown'} non-submission`, async () => {
      const prepared = await prepare();
      const current = await selectCodexIntake(pluginData, deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      await store.exclusive(async (state, save) => {
        const record = state.records[0]!;
        delete record.reservationVersion;
        record.phase = 'blocked';
        record.continuation = {
          phase: 'waiting',
          policyDigest: 'a'.repeat(64),
          selection: record.assessment!,
        };
        record.result = {
          version: 1,
          outcome: 'operator-setup-blocker',
          code: 'dispatch-assignment-authority-revoked',
          summary: 'Legacy failure.',
          remediation: 'Retained.',
          evidence: [],
          progress: { completed: [], remaining: [] },
        };
        await save();
      });
      await reassign();
      deps.native!.unsubmittedCreation = async () =>
        proof ? { turnId: 'original-preparation' } : undefined;
      const recovered = await next();
      const retained = (await store.read()).records[0]!;
      if (proof) {
        assert.equal(recovered.status, 'routing-required');
        assert.equal(retained.request, undefined);
        assert.deepEqual(retained.unsubmittedCreations?.[0]?.request, prepared.request);
        assert.equal(retained.continuation, undefined);
        assert.equal(retained.unsubmittedCreations?.[0]?.continuation?.phase, 'waiting');
      } else {
        assert.equal(recovered.code, 'dispatch-assignment-superseded');
        assert.deepEqual(retained.request, prepared.request);
        assert.equal(retained.threadId, undefined);
        assert.equal(retained.unsubmittedCreations, undefined);
        assert.equal(codexItemOccupied(retained), true);
        assert.equal((await next()).status, 'idle');
      }
    });
  it('should leave native denials outside legacy automatic reclassification', async () => {
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
  it('should reconcile a retired legacy creation through native reads without changing its request', async () => {
    const prepared = await prepare();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.reservationVersion;
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
    const retained = ((await request('inspect')).records as Record<string, unknown>[])[0]!;
    assert.equal((retained.unsubmittedCreations as unknown[]).length, 1);
    assert.equal(retained.phase, 'creating');
  });
  it('should preserve a superseded request when its native outcome is unknown', async () => {
    const prepared = await prepare();
    await reassign();
    assert.equal((await next()).code, 'dispatch-assignment-superseded');
    const retained = ((await request('inspect')).records as Record<string, unknown>[])[0]!;
    assert.deepEqual(retained.request, prepared.request);
    assert.equal(retained.unsubmittedCreations, undefined);
  });
  it('should continue the occurrence after an item-specific failure instead of ending the report loop', async () => {
    await prepare();
    await reassign();
    const failed = await next();
    assert.equal(failed.nextAction, 'next');
    const state = await request('inspect');
    assert.equal((state.run as { stopped?: string }).stopped, undefined);
    assert.equal((await next()).status, 'idle');
  });
  it('should recover a superseded native creation without issuing another request', async () => {
    const prepared = await prepare();
    created();
    await reassign();
    assert.equal((await next()).status, 'blocked');
    const retained = ((await request('inspect')).records as Record<string, unknown>[])[0]!;
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

  it('should bound automatic recovery of repeatedly unsubmitted creations', async () => {
    let prepared = await prepare();
    deps.native!.unsubmittedCreation = async () => ({ turnId: 'completed-turn' });
    for (let count = 0; count < 8; count++) {
      await request('reconcile', { id: prepared.id });
      now += 300001;
      prepared = await prepare();
    }
    await request('reconcile', { id: prepared.id });
    now += 300001;
    deps.native!.unsubmittedCreation = async () => {
      assert.fail('the recovery limit must stop further automatic attempts');
    };
    assert.equal((await next()).code, 'dispatch-creation-unresolved');
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
        const operator = { threadId: 'operator' };
        const preview = await request('retire', { id: first.id }, operator);
        await request('retire', { id: first.id, digest: preview.digest }, operator);
        created();
        native!.id = 'old-native-receipt';
        native!.status = 'idle';
        native!.turnEnded = true;
        await request('reconcile', { id: first.id });
        native = undefined;
        const before = ((await request('inspect')).records as Record<string, unknown>[])[0];
        fixture.item.state = 'open';
        await reassign();
        const second = await prepare();
        const blocked = await request('reconcile', {
          id: second.id,
          receipt: { threadId: 'fresh-native-receipt', clientThreadId: 'old-native-receipt' },
        });
        assert.equal(blocked.code, 'dispatch-native-receipt-reused');
        assert.equal(blocked.status, 'blocked');
        const records = (await request('inspect')).records as Record<string, unknown>[];
        assert.deepEqual(records[0], before);
        assert.equal(records[1]!.receiptThreadId, undefined);
        assert.equal(records[1]!.clientThreadId, undefined);
        assert.deepEqual(records[1]!.request, second.request);
        created();
        assert.equal((await request('reconcile', { id: second.id })).status, 'assessing');
      },
    );
  }

  it('should bind results to the verified child and retain one complete outcome without replay', async () => {
    const prepared = await prepare();
    created();
    const child = { threadId: 'issue-thread' };
    const context = await request('context', { id: prepared.id }, child);
    assert.equal(context.status, 'verified');
    await assert.rejects(
      request('result', { id: prepared.id, result }, { threadId: 'other-chat' }),
      /dispatch-assessment-caller-mismatch/,
    );
    await assert.rejects(
      request('result', { id: prepared.id, result: '## Plan ready' }, child),
      /assessment-result-invalid/,
    );
    const recorded = await request('result', { id: prepared.id, result }, child);
    assert.equal(recorded.status, 'recorded');
    const savedRecord = (
      (await request('inspect')).records as Array<{
        stageReceipt: {
          binding: { threadId: string; turnId: string; workflow: string; evidenceDigest: string };
          resultDigest: string;
        };
      }>
    )[0]!;
    assert.equal(savedRecord.stageReceipt.binding.threadId, 'issue-thread');
    assert.equal(savedRecord.stageReceipt.binding.workflow, 'issue-assignment');
    assert.equal(savedRecord.stageReceipt.resultDigest, recorded.previousResultDigest);
    assert.match(savedRecord.stageReceipt.binding.evidenceDigest, /^[a-f0-9]{64}$/);
    await request('context', { id: prepared.id }, child);
    assert.deepEqual(
      ((await request('inspect')).records as Array<{ stageReceipt: unknown }>)[0]!.stageReceipt,
      savedRecord.stageReceipt,
    );
    assert.ok(String(recorded.presentation).includes(result.assessment));
    assert.ok(String(recorded.presentation).includes(result.planSummary));
    assert.ok(String(recorded.presentation).includes(result.plan));
    assert.match(String(recorded.presentation), /Selected.*gpt-6\.1-sol \/ high/);
    assert.match(
      String(recorded.presentation),
      /Effective settings.*Verified: gpt-6\.1-sol \/ high/,
    );
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    assert.deepEqual(await request('result', { id: prepared.id, result }, child), recorded);
    await assert.rejects(
      request('result', { id: prepared.id, result: { ...result, plan: 'Changed.' } }, child),
      /assessment-result-conflict/,
    );
    const sameTurn = await request(
      'result',
      {
        id: prepared.id,
        previousResultDigest: recorded.previousResultDigest,
        result: { ...result, plan: 'Refined from an answer in this turn.' },
      },
      child,
    );
    assert.equal(sameTurn.status, 'recorded');
    await assert.rejects(
      request(
        'result',
        {
          id: prepared.id,
          previousResultDigest: recorded.previousResultDigest,
          result: { ...result, plan: 'Stale revision.' },
        },
        child,
      ),
      /assessment-result-conflict/,
    );
    const current = await request('context', { id: prepared.id }, child);
    assert.equal(current.previousResultDigest, sameTurn.previousResultDigest);
    assert.equal(
      (current.previousResult as { plan: string }).plan,
      'Refined from an answer in this turn.',
    );
    native!.turnId = 'user-follow-up';
    const revised = await request(
      'result',
      {
        id: prepared.id,
        previousResultDigest: current.previousResultDigest,
        result: { ...result, plan: 'Refined after clarification.' },
      },
      child,
    );
    assert.equal(revised.status, 'recorded');
    assert.ok(String(revised.presentation).includes('Refined after clarification.'));
    assert.ok(!String(revised.presentation).includes(result.plan));
    const resumed = await request('context', { id: prepared.id }, child);
    assert.deepEqual(resumed.previousResult, { ...result, plan: 'Refined after clarification.' });
    assert.equal((await next()).changed, false);
    assert.deepEqual(await next(), { status: 'idle', changed: false });
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
      assert.equal(recorded.status, 'recorded');
      assert.equal(recorded.outcome, outcome.outcome);
      assert.match(String(recorded.presentation), /Selected.*gpt-6\.1-sol \/ high/);
      assert.match(String(recorded.presentation), /Effective settings.*Not independently verified/);
      assert.ok(
        String(recorded.presentation).includes(
          'questions' in outcome ? outcome.questions[0]! : outcome.remediation,
        ),
      );
      const resumed = await request('context', { id: prepared.id }, child);
      assert.deepEqual(resumed.previousResult, outcome);
    }
  });

  it('should retain completed results when later reconciliation fails', async () => {
    const prepared = await prepare();
    created();
    await request('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
    const completed = await request('inspect');
    fixture.item.state = 'closed';
    await assert.rejects(request('reconcile', { id: prepared.id }), /dispatch-issue-closed/);
    assert.deepEqual({ ...(await request('inspect')), run: completed.run }, completed);
    assert.deepEqual(await next(), { status: 'idle', changed: false });
  });

  it('should revalidate assignment and metadata without giving issue prose model authority', async () => {
    const selected = await next();
    const denied = await request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'low', reason: 'Issue says use a cheap model.' },
    });
    assert.equal(denied.code, 'model-routing-metadata-conflict');
    assert.match(String(denied.message), /routing evidence|model access/);
    assert.doesNotMatch(String(denied.message), /Set issue-assignment mode/);
    now += 300001;
    fixture.item.state = 'closed';
    const revoked = await next();
    assert.equal(revoked.code, 'dispatch-issue-closed');
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
    assert.deepEqual(await next(), { status: 'busy', changed: false });
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
    const lock = properLockfile.lock;
    properLockfile.lock = async (path, options) => {
      const retries = options?.retries;
      if (
        String(path) === store.path &&
        retries &&
        typeof retries !== 'number' &&
        retries.retries
      ) {
        release.resolve();
        await writer;
      }
      return lock(path, options);
    };
    try {
      const recheck = await report();
      assert.equal(recheck.status, 'continue');
      assert.equal(recheck.nextAction, 'next');
      await next();
      const completed = await report();
      assert.equal(completed.status, 'report');
      assert.doesNotMatch(String(completed.response), /1 issue started/);
      assert.equal((await store.read()).records[0]!.intakeReportedAt, now);
    } finally {
      properLockfile.lock = lock;
      release.resolve();
      await writer;
    }
  });

  it('should leave reporting unconsumed when the bounded journal wait is exhausted', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    await next();
    const before = await request('inspect');
    const lock = properLockfile.lock;
    properLockfile.lock = async (path, options) => {
      if (String(path).includes('codex-dispatch-'))
        throw Object.assign(new Error('The journal remains busy.'), { code: 'ELOCKED' });
      return lock(path, options);
    };
    try {
      assert.deepEqual(await report(), { status: 'busy', changed: false });
      assert.deepEqual(await request('inspect'), before);
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
    let contenders = 0;
    properLockfile.lock = async (path, options) => {
      if (String(path).includes('codex-dispatch-')) {
        contenders++;
        const retries = options?.retries;
        if (!retries || typeof retries === 'number' || !retries.retries)
          throw Object.assign(new Error('The intake journal lease is held.'), { code: 'ELOCKED' });
      }
      return lock(path, options);
    };
    try {
      assert.equal(
        (await request('context', { id: prepared.id }, { threadId: 'issue-thread' })).status,
        'verified',
      );
      assert.equal(
        (await request('result', { id: prepared.id, result }, { threadId: 'issue-thread' })).status,
        'recorded',
      );
      assert.equal(contenders, 2);
    } finally {
      properLockfile.lock = lock;
    }
  });

  it('should normalize a title before the first child assessment without an intake repair race', async () => {
    const prepared = await prepare();
    created();
    native!.name = 'a normalized native title';
    assert.equal(
      (await request('context', { id: prepared.id }, { threadId: 'issue-thread' })).status,
      'verified',
    );
    assert.equal(native!.name, '#3: REPAIR CONTAINED BEHAVIOR');
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
      (await request('result', { id: prepared.id, result }, { threadId: 'issue-thread' })).status,
      'recorded',
    );
    assert.equal(((await request('inspect')).records as unknown[]).length, 1);
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
        const records = (await request('inspect')).records as { phase: string; result?: unknown }[];
        assert.equal(records.length, 1);
        assert.equal(records[0]!.phase, 'assessing');
        assert.equal(records[0]!.result, undefined);
      }
    }
    await request('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
  });

  it('should retain verified child identity on rename failure and recover without another creation', async () => {
    const prepared = await prepare();
    created();
    native!.name = 'shortened title';
    const rename = deps.native!.rename;
    deps.native!.rename = async () => {
      throw new Error('rename-unavailable');
    };
    await assert.rejects(
      request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /rename-unavailable/,
    );
    const record = ((await request('inspect')).records as { threadId: string }[])[0]!;
    assert.equal(record.threadId, 'issue-thread');
    deps.native!.rename = rename;
    assert.equal((await request('reconcile', { id: prepared.id })).status, 'assessing');
    assert.equal(native!.name, '#3: REPAIR CONTAINED BEHAVIOR');
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
    assert.match(response, /\*\*Managing:\*\* 1 issues · \*\*Pending:\*\* 0/);
    assert.doesNotMatch(response, /issues? pending/);
    assert.equal(((await request('inspect')).records as unknown[]).length, 1);
  });

  it('should discard legacy report backlogs without losing records or blocking admission', async () => {
    const { default: Store } = await import('../agent/codex-dispatch-state.ts');
    const current = await selectCodexIntake(pluginData, deps);
    const store = new Store(current.store.location.root, current.store.location.scope);
    const cards = Array.from({ length: 100 }, (_, i) => ({
      id: i.toString(16).padStart(64, '0'),
      message: 'old card with a malformed link',
      notify: true,
    }));
    await current.store.exclusive(async (state, save) => {
      state!.notices = cards;
      await save(state!);
    });
    await store.exclusive(async (state, save) => {
      state.notices = cards;
      state.reports = [{ response: 'wrong url', createdAt: now, notices: cards.map((c) => c.id) }];
      await save();
    });
    assert.equal((await runCodexIntake(pluginData, false, deps)).status, 'ready');
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    await next();
    const first = await report();
    assert.match(String(first.response), /1 issue started/);
    assert.equal((await store.read()).reports, undefined);
    assert.equal((await current.store.read())!.notices, undefined);
    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    deps.native!.find = async () => {
      throw new Error('intake must not inspect already started work');
    };
    await next();
    const repeat = await report();
    assert.match(String(repeat.response), /DONT_NOTIFY/);
    assert.doesNotMatch(String(repeat.response), /issues? started|wrong url|old card/);
    assert.equal((await store.read()).records.length, 1);
  });

  it('should keep revised plans and questions inside the issue while releasing its slot', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    await next();
    await report();
    const child = { threadId: 'issue-thread' };
    const saved = await request('result', { id: prepared.id, result }, child);
    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    await request(
      'result',
      {
        id: prepared.id,
        previousResultDigest: saved.previousResultDigest,
        result: {
          version: 1,
          outcome: 'clarification-needed',
          summary: 'Decide retention.',
          assessment: 'A choice is needed.',
          questions: ['How long?'],
          evidence: result.evidence,
          progress: result.progress,
        },
      },
      child,
    );
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
    mode: 'work' | 'auto' = 'work',
    assessmentGuidance?: string | { file: string },
  ) {
    const configured = structuredClone(manifest);
    Object.assign(configured.github.notifications['issue-assignment'], {
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
      await request('result', { id: prepared.id, result: assessment }, { threadId: native!.id });
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    let received = false;
    const continuation: CodexContinuationDependencies = {
      ...deps,
      continuationNative: async () =>
        received
          ? {
              status: 'verified',
              turnId: native!.turnId!,
              ended: ['completed', 'failed', 'interrupted'].includes(native!.turnStatus!),
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
        native!.status = 'active';
        native!.turnStatus = 'inProgress';
      },
    };
  }

  it('should preserve a prepared continuation through host failure and retry its receipt without another send', async () => {
    const work = await workIssue();
    assert.equal((await work.run('next')).status, 'prepared');
    const original = work.continuation.continuationNative;
    work.continuation.continuationNative = async () => {
      throw new Error('continuation-host-unavailable');
    };
    assert.equal((await work.run('next')).status, 'retrying');
    assert.equal((await work.run('next')).status, 'idle');
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const retained = (await store.read()).records[0]!.continuation!;
    assert.equal(retained.phase, 'prepared');
    assert.equal(retained.retry?.attempts, 1);
    now = retained.retryAfter!;
    work.continuation.continuationNative = original;
    assert.equal((await work.run('next')).status, 'pending');
    assert.deepEqual((await store.read()).records[0]!.continuation!.attempt, retained.attempt);
  });

  const autoResult = {
    ...result,
    fullAssessment: 'The complete assessment, including its evidence and conditions.',
    decision: {
      action: 'proceed',
      reasons: ['The change is bounded and requirements are complete.'],
    },
  };
  const autoIssue = (
    assessment: Record<string, unknown> | null = autoResult,
    guidance?: string | { file: string },
  ) => workIssue(assessment, 'Follow the plan.', 'company:implement', 'auto', guidance);

  for (const [invalid, error] of [
    [{ ...autoResult, plan: undefined }, 'assessment-result-invalid'],
    [{ ...autoResult, decision: undefined }, 'assessment-decision-required'],
    [
      {
        version: 1,
        outcome: 'clarification-needed',
        summary: 'Requirements are unclear.',
        assessment: 'A choice is needed.',
        questions: ['Which behavior is intended?'],
        evidence: result.evidence,
        progress: result.progress,
        decision: autoResult.decision,
      },
      'assessment-decision-conflict',
    ],
  ] as const) {
    it(`should continue once after correcting an initial ${error}`, async () => {
      const work = await autoIssue(null);
      const child = { threadId: native!.id };
      await assert.rejects(
        request('result', { id: work.id, result: invalid }, child),
        new RegExp(error),
      );
      assert.equal((await work.run('next')).status, 'idle');
      await request('result', { id: work.id, result: autoResult }, child);
      assert.equal((await work.run('next')).status, 'prepared');
      assert.equal((await work.run('next')).status, 'pending');
      work.receive();
      const context = await work.run('context', {}, true);
      assert.equal(context.status, 'verified');
      assert.deepEqual('assessment' in context && context.assessment, autoResult);
    });
  }

  for (const stop of ['wait', 'cancel', 'changed-selection', 'denial'] as const) {
    it(`should preserve auto ${stop} through invalid and corrected assessments`, async () => {
      const work = await autoIssue();
      const child = { threadId: native!.id };
      let previousResultDigest = automationHash(autoResult);
      if (stop === 'wait') {
        const waiting = {
          ...autoResult,
          decision: { action: 'wait', reasons: ['Operator direction is needed.'] },
        };
        await request('result', { id: work.id, result: waiting, previousResultDigest }, child);
        previousResultDigest = automationHash(waiting);
      } else if (stop === 'cancel') {
        await work.run('cancel', {}, true);
      } else if (stop === 'changed-selection') {
        const original = work.continuation.native!.assessmentSkill;
        work.continuation.native!.assessmentSkill = async (cwd, id) => ({
          ...(await original(cwd, id)),
          digest: id.includes('assessment') ? 'b'.repeat(64) : 'a'.repeat(64),
        });
        await work.run('next');
      } else {
        await work.run('next');
        work.continuation.continuationNative = async () => ({
          status: 'blocked',
          code: 'continuation-native-send-failed',
        });
        await work.run('reconcile');
      }
      const stopped = await work.run('context', {}, true);
      assert.equal(stopped.status, stop === 'cancel' ? 'cancelled' : 'blocked');
      await assert.rejects(
        request('result', { id: work.id, result: { ...autoResult, plan: undefined } }, child),
        /assessment-result-invalid/,
      );
      await request('result', { id: work.id, result: autoResult, previousResultDigest }, child);
      assert.equal((await work.run('next')).status, 'idle');
      assert.deepEqual(await work.run('context', {}, true), stopped);
    });
  }

  it('should adopt auto proceed once and retain its complete source, selection, and routing across restart', async () => {
    const work = await autoIssue();
    const assessment = await request('context', { id: work.id }, { threadId: native!.id });
    assert.equal(assessment.mode, 'auto');
    assert.match(String(assessment.instructions), /decision.*proceed.*wait/);
    const prepared = await work.run('next');
    assert.equal(prepared.status, 'prepared');
    assert.equal('request' in prepared && prepared.request?.model, 'gpt-6.1-sol');
    assert.equal('request' in prepared && prepared.request?.thinking, 'high');
    assert.equal((await work.run('next')).status, 'pending');
    assert.equal((await work.run('reconcile')).status, 'pending');
    work.receive();
    const context = await work.run('context', {}, true);
    assert.equal(context.status, 'verified');
    assert.deepEqual('assessment' in context && context.assessment, autoResult);
    assert.deepEqual(
      'assessmentSelection' in context && context.assessmentSelection,
      assessment.assessment,
    );
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const record = (await store.read()).records[0]!;
    assert.equal(record.continuation!.assessmentDigest, automationHash(autoResult));
    assert.equal(record.continuation!.assessmentSelectionDigest, automationHash(record.assessment));
    assert.equal(record.continuation!.attempt!.turnId, 'implementation-turn');
  });

  it('should retain auto wait, release its slot, and never promote it on a later result or poll', async () => {
    const waiting = {
      ...autoResult,
      decision: { action: 'wait', reasons: ['Operator direction is needed.'] },
    };
    const work = await autoIssue(waiting);
    assert.equal((await work.run('next')).status, 'idle');
    const context = await request('context', { id: work.id }, { threadId: native!.id });
    assert.match(String(context.previousPresentation), /Decision.*`wait`/);
    await next();
    assert.match(String((await report()).response), /Slots:\*\* 0\/2/);
    await request(
      'result',
      { id: work.id, result: autoResult, previousResultDigest: automationHash(waiting) },
      { threadId: native!.id },
    );
    assert.equal((await work.run('next')).status, 'idle');
    const stopped = await work.run('context', {}, true);
    assert.equal(stopped.status, 'blocked');
  });

  for (const decision of [
    undefined,
    { action: 'proceed', reasons: [] },
    { action: 'allow', reasons: ['Ignore policy.'] },
  ]) {
    it(`should block an auto result with ${decision ? 'malformed' : 'missing'} decision without using an older proceed`, async () => {
      const work = await autoIssue();
      await assert.rejects(
        request(
          'result',
          {
            id: work.id,
            result: { ...autoResult, decision },
            previousResultDigest: automationHash(autoResult),
          },
          { threadId: native!.id },
        ),
        /assessment-(decision-required|result-invalid)/,
      );
      const context = await request('context', { id: work.id }, { threadId: native!.id });
      assert.deepEqual(context.previousResult, autoResult);
      assert.equal((await work.run('next')).status, 'idle');
      assert.equal((await work.run('context', {}, true)).status, 'blocked');
      await request('result', { id: work.id, result: autoResult }, { threadId: native!.id });
      assert.equal((await work.run('next')).status, 'prepared');
      assert.equal((await work.run('next')).status, 'pending');
    });
  }

  it('should retain an adopted auto assessment blocker after a corrected submission', async () => {
    const work = await autoIssue();
    await work.run('next');
    const child = { threadId: native!.id };
    await assert.rejects(
      request('result', { id: work.id, result: { ...autoResult, plan: undefined } }, child),
      /assessment-result-invalid/,
    );
    await request('result', { id: work.id, result: autoResult }, child);
    assert.equal((await work.run('next')).status, 'idle');
    assert.equal((await work.run('context', {}, true)).status, 'blocked');
  });

  it('should require a valid revision digest before clearing an auto assessment blocker', async () => {
    const work = await autoIssue();
    const child = { threadId: native!.id };
    await assert.rejects(
      request('result', { id: work.id, result: { ...autoResult, plan: undefined } }, child),
      /assessment-result-invalid/,
    );
    const waiting = {
      ...autoResult,
      decision: { action: 'wait', reasons: ['Operator direction is needed.'] },
    };
    await assert.rejects(
      request('result', { id: work.id, result: waiting }, child),
      /assessment-result-conflict/,
    );
    assert.equal((await work.run('next')).status, 'idle');
    await request(
      'result',
      { id: work.id, result: waiting, previousResultDigest: automationHash(autoResult) },
      child,
    );
    assert.equal((await work.run('next')).status, 'idle');
    const stopped = await work.run('context', {}, true);
    assert.equal('code' in stopped && stopped.code, 'continuation-auto-wait');
  });

  it('should reject changes to an adopted auto assessment without another native send', async () => {
    const work = await autoIssue();
    await work.run('next');
    await assert.rejects(
      request(
        'result',
        {
          id: work.id,
          result: { ...autoResult, plan: 'A new plan.' },
          previousResultDigest: automationHash(autoResult),
        },
        { threadId: native!.id },
      ),
      /continuation-assessment-changed/,
    );
    assert.equal((await work.run('next')).status, 'idle');
  });

  it('should reject stale auto assessment evidence before adopting a decision', async () => {
    const work = await autoIssue();
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records[0]!.stageReceipt!.resultDigest = 'b'.repeat(64);
      await save();
    });
    const stopped = await work.run('next');
    assert.equal('code' in stopped && stopped.code, 'continuation-assessment-changed');
  });

  it('should stop auto when assessment guidance changes without silently readopting it', async () => {
    await writeFile(join(workspace, 'assessment.md'), 'Bounded original guidance.');
    const work = await autoIssue(autoResult, { file: 'assessment.md' });
    await writeFile(join(workspace, 'assessment.md'), 'Different decision guidance.');
    const stopped = await work.run('next');
    assert.equal('code' in stopped && stopped.code, 'continuation-selection-changed');
    assert.equal((await work.run('next')).status, 'idle');
  });

  it('should stop auto when the assessment skill changes', async () => {
    const work = await autoIssue();
    const original = work.continuation.native!.assessmentSkill;
    work.continuation.native!.assessmentSkill = async (cwd, id) => ({
      ...(await original(cwd, id)),
      digest: id.includes('assessment') ? 'b'.repeat(64) : 'a'.repeat(64),
    });
    const stopped = await work.run('next');
    assert.equal('code' in stopped && stopped.code, 'continuation-selection-changed');
  });

  it('should stop auto when issue evidence changes before implementation', async () => {
    const work = await autoIssue();
    const connect = work.continuation.connect!;
    work.continuation.connect = async (workspace, signal) => {
      const client = await connect(workspace, signal);
      return {
        ...client,
        getItemContext: async (...args) => ({
          ...(await client.getItemContext(...args)),
          body: 'Requirements have changed.',
        }),
      };
    };
    const stopped = await work.run('next');
    assert.equal('code' in stopped && stopped.code, 'continuation-assessment-evidence-changed');
    assert.equal((await work.run('next')).status, 'idle');
  });

  it('should retain auto cancellation and refuse native model substitution', async () => {
    const work = await autoIssue();
    await work.run('next');
    work.receive();
    native!.model = 'gpt-6-luna';
    await assert.rejects(work.run('context', {}, true), /continuation-native-binding-mismatch/);
    native!.model = 'gpt-6.1-sol';
    assert.equal((await work.run('cancel', {}, true)).status, 'cancelled');
    assert.equal((await work.run('next')).status, 'idle');
    assert.equal((await work.run('context', {}, true)).status, 'cancelled');
  });

  it('should not reinterpret an auto assignment under changed work authority', async () => {
    const work = await autoIssue();
    const changed = JSON.parse(await readFile(join(workspace, 'agent.yaml'), 'utf8'));
    changed.github.notifications['issue-assignment'].mode = 'work';
    await writeFile(join(workspace, 'agent.yaml'), JSON.stringify(changed));
    const stopped = await work.run('next');
    assert.equal('code' in stopped && stopped.code, 'continuation-authority-changed');
  });

  it('should preserve auto native denial without another continuation', async () => {
    const work = await autoIssue();
    await work.run('next');
    work.continuation.continuationNative = async () => ({
      status: 'blocked',
      code: 'continuation-native-send-failed',
    });
    const stopped = await work.run('reconcile');
    assert.equal(stopped.status, 'blocked');
    assert.equal((await work.run('next')).status, 'idle');
  });

  it('should continue actionable work once with the complete assessment and retained selection', async () => {
    const work = await workIssue();
    work.continuation.deliver = async () => {
      throw new Error('preparation must not publish');
    };
    const prepared = await work.run('next');
    assert.equal(prepared.status, 'prepared');
    assert.equal('request' in prepared && prepared.request?.threadId, native!.id);
    assert.equal(native!.turnStatus, 'completed');
    assert.equal((await work.run('next')).status, 'pending');
    work.receive();
    const context = await work.run('context', {}, true);
    assert.equal(context.status, 'verified');
    assert.deepEqual('assessment' in context && context.assessment, result);
    assert.equal(
      'implementation' in context && context.implementation?.skill.name,
      'company:implement',
    );
    const saved = await work.run(
      'result',
      {
        result: {
          outcome: 'done',
          summary: 'Implemented and checked.',
          fullResult: 'Complete implementation and validation evidence.',
        },
      },
      true,
    );
    assert.equal(saved.status, 'recorded');
    const records = (await request('inspect')).records as Array<{
      continuation: { phase: string; result: unknown };
      result: unknown;
    }>;
    assert.equal(records[0]!.continuation.phase, 'delivery');
    assert.deepEqual(records[0]!.result, result);
    assert.equal((await work.run('context', {}, true)).status, 'verified');
  });

  it('should start work with bundled implementation and guidance when no replacement is configured', async () => {
    const work = await workIssue(result, 'Keep this change bounded.', '');
    assert.equal((await work.run('next')).status, 'prepared');
    work.receive();
    const context = await work.run('context', {}, true);
    assert.equal(
      'implementation' in context && context.implementation?.skill.name,
      'agent-system:agent-system-issue-implementation',
    );
    assert.equal('implementation' in context && context.implementation?.defaultSkill, true);
    assert.equal(
      'implementation' in context && context.implementation?.guidance?.content,
      'Keep this change bounded.',
    );
  });

  it('should preserve provider evidence and the existing send through continuation recovery', async () => {
    const work = await workIssue();
    await work.run('next');
    const original = fixture.client.getItem;
    fixture.client.getItem = async () => {
      throw Object.assign(new Error('provider request failed with details'), {
        code: 'github-notification-request-failed',
        providerDiagnostic: providerDiagnostic('github', 'api-request', 'rate-limit', {
          resetAt: now + 900000,
        }),
      });
    };
    const recovered = await work.run('reconcile');
    assert.equal(recovered.status, 'retrying');
    assert.equal('code' in recovered && recovered.code, 'github-notification-request-failed');
    assert.deepEqual(
      'providerDiagnostic' in recovered && recovered.providerDiagnostic,
      providerDiagnostic('github', 'api-request', 'rate-limit', { resetAt: now + 900000 }),
    );
    const records = (await request('inspect')).records as {
      continuation: { attempt?: unknown; retryAfter?: number };
    }[];
    assert.ok(records[0]!.continuation.attempt);
    assert.equal(records[0]!.continuation.retryAfter, now + 900000);
    fixture.client.getItem = original;
  });

  it('should retain a starting continuation when an isolated reader reports interrupted without an end timestamp', async () => {
    const work = await workIssue();
    await work.run('next');
    work.receive();
    native!.status = 'notLoaded';
    native!.turnStatus = 'interrupted';
    work.continuation.continuationNative = async () => ({
      status: 'verified',
      turnId: native!.turnId!,
      ended: false,
    });
    await work.run('reconcile');
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    assert.equal((await work.run('next')).status, 'idle');
    assert.equal(
      (
        await work.run(
          'result',
          { result: { outcome: 'done', summary: 'Done.', fullResult: 'Checked.' } },
          true,
        )
      ).status,
      'recorded',
    );
    assert.equal((await work.run('next')).status, 'idle');
  });

  it('should require an ended and inactive turn before blocking work', async () => {
    const work = await workIssue();
    await work.run('next');
    work.receive();
    native!.turnStatus = 'completed';
    await work.run('reconcile');
    assert.equal((await work.run('context', {}, true)).status, 'verified');
    native!.status = 'idle';
    await work.run('reconcile');
    const blocked = await work.run('context', {}, true);
    assert.equal(blocked.status, 'blocked');
    assert.equal('code' in blocked && blocked.code, 'continuation-turn-ended');
  });

  for (const endedStatus of ['completed', 'failed', 'interrupted'])
    it(`should queue one operator-approved retry after a ${endedStatus} turn and retain the earlier attempt`, async () => {
      const work = await workIssue();
      await work.run('next');
      work.receive();
      native!.status = 'idle';
      native!.turnStatus = endedStatus;
      await work.run('reconcile');
      const before = (await request('inspect')).records;
      const preview = await work.run('retry', {}, 'operator');
      assert.equal(preview.status, 'retry-available');
      assert.deepEqual((await request('inspect')).records, before);
      await assert.rejects(work.run('retry', {}, true), /operator-caller-required/);
      await assert.rejects(work.run('retry'), /operator-caller-required/);
      await assert.rejects(work.run('retry', { digest: 'stale' }, 'operator'), /retry-stale/);
      const digest = 'digest' in preview && preview.digest;
      native!.status = 'active';
      await assert.rejects(work.run('retry', { digest }, 'operator'), /retry-chat-active/);
      native!.status = 'idle';
      assert.equal((await work.run('retry', { digest }, 'operator')).status, 'retry-ready');
      await assert.rejects(work.run('retry', { digest }, 'operator'), /retry-unavailable/);
      const records = (await request('inspect')).records as Array<{
        result: unknown;
        continuation: { retries: Array<{ attempt: { turnId: string }; by: string }> };
      }>;
      assert.deepEqual(records[0]!.result, result);
      assert.equal(records[0]!.continuation.retries[0]!.attempt.turnId, 'implementation-turn');
      assert.equal(records[0]!.continuation.retries[0]!.by, 'operator');
      const next = await work.run('next');
      assert.equal(next.status, 'prepared');
      assert.equal('request' in next && next.request?.threadId, native!.id);
      work.continuation.continuationNative = async () => ({ status: 'uncertain' });
      assert.equal((await work.run('next')).status, 'pending');
      work.receive();
      native!.turnId = 'retry-turn';
      work.continuation.continuationNative = async () => ({
        status: 'verified',
        turnId: native!.turnId!,
        ended: false,
      });
      assert.equal((await work.run('context', {}, true)).status, 'verified');
    });

  it('should recover an altered prompt only through a fresh operator preview and unchanged assessment checkout', async () => {
    const work = await autoIssue();
    await work.run('next');
    native!.turnId = 'diagnostic-followup';
    const mismatch = {
      status: 'mismatch' as const,
      code: 'continuation-send-mismatch',
      callId: 'bad-send',
      requestDigest: 'd'.repeat(64),
      turnId: 'failed-handoff',
      latestTurnId: native!.turnId,
      ended: true,
    };
    work.continuation.continuationNative = async () => mismatch;
    assert.equal((await work.run('context', {}, true)).status, 'blocked');
    assert.equal((await work.run('next')).status, 'idle');
    const preview = await work.run('retry', {}, 'operator');
    assert.equal(preview.status, 'retry-available');
    const digest = 'digest' in preview && preview.digest;
    const originalGit = work.continuation.git!;
    work.continuation.git = async (cwd, args, signal) =>
      args[0] === 'status' ? ' M changed' : originalGit(cwd, args, signal);
    await assert.rejects(work.run('retry', { digest }, 'operator'), /worktree-changed/);
    work.continuation.git = originalGit;
    mismatch.requestDigest = 'e'.repeat(64);
    await assert.rejects(work.run('retry', { digest }, 'operator'), /retry-stale/);
    mismatch.requestDigest = 'd'.repeat(64);
    assert.equal((await work.run('retry', { digest }, 'operator')).status, 'retry-ready');
    const records = (await request('inspect')).records as Array<{
      continuation: { retries: Array<{ resumeAfterTurnId: string; mismatch: { callId: string } }> };
    }>;
    assert.equal(records[0]!.continuation.retries[0]!.resumeAfterTurnId, 'diagnostic-followup');
    assert.equal(records[0]!.continuation.retries[0]!.mismatch.callId, 'bad-send');
    assert.equal((await work.run('next')).status, 'prepared');
    work.continuation.continuationNative = async () => ({ status: 'uncertain' });
    assert.equal((await work.run('next')).status, 'pending');
  });

  it('should not retry a denied continuation', async () => {
    const work = await workIssue();
    await work.run('next');
    work.continuation.continuationNative = async () => ({
      status: 'blocked',
      code: 'continuation-native-send-failed',
    });
    await work.run('reconcile');
    await assert.rejects(work.run('retry', {}, 'operator'), /retry-unavailable/);
    await assert.rejects(work.run('retry-denied', {}, 'operator'), /denial-unverified/);
  });

  it('should retain a rejected auto send and require exact operator reapproval before one fresh handoff', async () => {
    const work = await autoIssue();
    const first = await work.run('next');
    const rejection = {
      callId: 'denied-send',
      requestDigest: 'd'.repeat(64),
      reason: 'user rejected MCP tool call',
    };
    work.continuation.continuationNative = async () => ({
      status: 'blocked',
      code: 'continuation-native-send-failed',
      rejection,
    });
    await work.run('reconcile');
    assert.equal((await work.run('next')).status, 'idle');
    const before = (await request('inspect')).records;
    const preview = await work.run('retry-denied', {}, 'operator');
    assert.equal(preview.status, 'retry-available');
    assert.deepEqual((await request('inspect')).records, before);
    await assert.rejects(work.run('retry-denied'), /operator-caller-required/);
    await assert.rejects(work.run('retry-denied', {}, true), /operator-caller-required/);
    const digest = 'digest' in preview && preview.digest;
    await assert.rejects(
      work.run('retry-denied', { digest }, 'operator'),
      /denial-approval-required/,
    );
    const input = { digest, approvedCallId: rejection.callId };
    rejection.reason = 'changed';
    await assert.rejects(work.run('retry-denied', input, 'operator'), /retry-stale/);
    rejection.reason = 'user rejected MCP tool call';
    const turnId = native!.turnId;
    native!.turnId = 'intervening-turn';
    await assert.rejects(work.run('retry-denied', input, 'operator'), /user-intervened/);
    native!.turnId = turnId;
    native!.status = 'active';
    await assert.rejects(work.run('retry-denied', input, 'operator'), /retry-chat-active/);
    native!.status = 'idle';
    const git = work.continuation.git!;
    work.continuation.git = async (cwd, args, signal) =>
      args[0] === 'status' ? ' M changed' : git(cwd, args, signal);
    await assert.rejects(work.run('retry-denied', input, 'operator'), /worktree-changed/);
    work.continuation.git = git;
    assert.equal((await work.run('retry-denied', input, 'operator')).status, 'retry-ready');
    await assert.rejects(work.run('retry-denied', input, 'operator'), /retry-unavailable/);
    const records = (await request('inspect')).records as Array<{
      result: unknown;
      continuation: {
        retries: Array<{ attempt: { request: unknown }; rejection: unknown; by: string }>;
      };
    }>;
    assert.deepEqual(records[0]!.result, autoResult);
    const retained = records[0]!.continuation.retries[0]!;
    assert.deepEqual(retained.rejection, rejection);
    assert.deepEqual(retained.attempt.request, 'request' in first && first.request);
    assert.equal(retained.by, 'operator');
    const next = await work.run('next');
    assert.equal(next.status, 'prepared');
    assert.equal('request' in next && next.request?.threadId, native!.id);
    assert.notDeepEqual('request' in next && next.request, retained.attempt.request);
    work.continuation.continuationNative = async () => ({ status: 'uncertain' });
    assert.equal((await work.run('next')).status, 'pending');
    work.receive();
    work.continuation.continuationNative = async () => ({
      status: 'verified',
      turnId: native!.turnId!,
      ended: false,
    });
    assert.equal((await work.run('context', {}, true)).status, 'verified');
  });

  it('should permit operator recovery from an explicitly handed-off development chat', async () => {
    const work = await workIssue();
    await work.run('next');
    work.receive();
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    await work.run('reconcile');
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records.push({
        ...structuredClone(state.records[0]!),
        id: 'f'.repeat(64),
        issueKey: 'e'.repeat(64),
        threadId: 'operator',
      });
      await save();
    });
    await assert.rejects(work.run('retry', {}, 'operator'), /operator-caller-required/);
    await store.exclusive(async (state, save) => {
      state.records.at(-1)!.handoff = { at: now, by: 'operator', turnId: 'operator-turn' };
      await save();
    });
    assert.equal((await work.run('retry', {}, 'operator')).status, 'retry-available');
  });

  for (const outcome of ['done', 'blocked'])
    it(`should not retry a continuation with a recorded ${outcome} result`, async () => {
      const work = await workIssue();
      await work.run('next');
      work.receive();
      await work.run(
        'result',
        { result: { outcome, summary: 'Retained outcome.', fullResult: 'Retained evidence.' } },
        true,
      );
      await assert.rejects(work.run('retry', {}, 'operator'), /retry-unavailable/);
    });

  it('should retain uncertain native continuation across restart without another prepared request', async () => {
    const work = await workIssue();
    assert.equal((await work.run('next')).status, 'prepared');
    assert.equal((await work.run('reconcile')).status, 'pending');
    assert.equal((await work.run('next')).status, 'pending');
    await assert.rejects(work.run('context', {}, true), /send-unverified/);
  });

  it('should preserve plan-mode results without scheduling implementation', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    await request('result', { id: prepared.id, result }, { threadId: native!.id });
    const records = (await request('inspect')).records as Array<Record<string, unknown>>;
    assert.equal(records[0]!.continuation, undefined);
  });

  it('should stop blocked assessments and changed implementation selections without sending', async () => {
    const work = await workIssue();
    work.continuation.native!.assessmentSkill = async () => ({
      name: 'changed',
      path: '/changed/SKILL.md',
      scope: 'user',
      digest: 'c'.repeat(64),
    });
    const stopped = await work.run('next');
    assert.equal(stopped.status, 'blocked');
    assert.equal('code' in stopped && stopped.code, 'continuation-selection-changed');
    assert.equal((await work.run('next')).status, 'idle');
  });

  it('should retain an occupied slot until work completes and stop when guidance changes', async () => {
    await writeFile(join(workspace, 'implementation.md'), 'Original implementation guidance.');
    const work = await workIssue(result, { file: 'implementation.md' });
    await next();
    assert.match(String((await report()).response), /Slots:\*\* 1\/2/);
    await writeFile(join(workspace, 'implementation.md'), 'Changed implementation guidance.');
    const stopped = await work.run('next');
    assert.equal(stopped.status, 'blocked');
    assert.equal('code' in stopped && stopped.code, 'continuation-selection-changed');
    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    await next();
    assert.match(String((await report()).response), /Slots:\*\* 0\/2/);
  });

  it('should stop on native denial and never resend the denied continuation', async () => {
    const work = await workIssue();
    await work.run('next');
    work.continuation.continuationNative = async () => ({
      status: 'blocked',
      code: 'continuation-native-send-failed',
    });
    assert.equal((await work.run('reconcile')).status, 'blocked');
    assert.equal((await work.run('next')).status, 'idle');
  });

  it('should cancel retained work without changing its assessment or launching another turn', async () => {
    const work = await workIssue();
    await work.run('next');
    work.receive();
    assert.equal((await work.run('cancel', {}, true)).status, 'cancelled');
    assert.equal((await work.run('next')).status, 'idle');
    const records = (await request('inspect')).records as Array<Record<string, unknown>>;
    assert.deepEqual(records[0]!.result, result);
  });

  it('should reject revoked schedule authority and publication before implementation finishes', async () => {
    const work = await workIssue();
    await work.run('next');
    work.receive();
    await assert.rejects(
      work.run('delivery', { delivery: { action: 'prepare' } }, true),
      /implementation-required/,
    );
    work.continuation.activation = async () => {
      throw new Error('workflow-schedule-reconciliation-required');
    };
    await assert.rejects(work.run('context', {}, true), /schedule-reconciliation-required/);
  });

  it('should resume only delivery after a recorded implementation turn ends', async () => {
    const work = await workIssue();
    await work.run('next');
    work.receive();
    await work.run(
      'result',
      { result: { outcome: 'done', summary: 'Done.', fullResult: 'Full evidence.' } },
      true,
    );
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    const delivery = await work.run('next');
    assert.equal(delivery.status, 'prepared');
    assert.match(
      String('request' in delivery && delivery.request?.prompt),
      /only the managed PR delivery/,
    );
    work.continuation.continuationNative = async () => ({ status: 'uncertain' });
    assert.equal((await work.run('next')).status, 'pending');
  });

  for (const turnStatus of ['failed', 'interrupted'])
    it(`should not resume delivery after the implementation turn is ${turnStatus}`, async () => {
      const work = await workIssue();
      await work.run('next');
      work.receive();
      const implementation = { outcome: 'done', summary: 'Done.', fullResult: 'Full evidence.' };
      await work.run('result', { result: implementation }, true);
      native!.status = 'idle';
      native!.turnStatus = turnStatus;
      assert.equal((await work.run('reconcile')).status, 'idle');
      assert.equal((await work.run('next')).status, 'idle');
      const records = (await request('inspect')).records as Array<{
        continuation: { phase: string; result: unknown; publicationAttempt?: unknown };
      }>;
      assert.equal(records[0]!.continuation.phase, 'blocked');
      assert.deepEqual(records[0]!.continuation.result, implementation);
      assert.equal(records[0]!.continuation.publicationAttempt, undefined);
      await assert.rejects(work.run('retry', {}, 'operator'), /retry-unavailable/);
    });

  it('should retain recorded implementation and stop delivery after native approval denial', async () => {
    const work = await workIssue();
    await work.run('next');
    work.receive();
    const implementation = { outcome: 'done', summary: 'Done.', fullResult: 'Full evidence.' };
    await work.run('result', { result: implementation }, true);
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    work.continuation.continuationNative = async () => ({
      status: 'blocked',
      code: 'continuation-native-approval-denied',
    });
    assert.equal((await work.run('reconcile')).status, 'blocked');
    assert.equal((await work.run('next')).status, 'idle');
    const records = (await request('inspect')).records as Array<{
      continuation: { result: unknown; publicationAttempt?: unknown };
    }>;
    assert.deepEqual(records[0]!.continuation.result, implementation);
    assert.equal(records[0]!.continuation.publicationAttempt, undefined);
    await assert.rejects(work.run('retry', {}, 'operator'), /retry-unavailable/);
  });

  it('should leave consequential assessment questions in the issue without preparing implementation', async () => {
    const work = await workIssue({
      version: 1,
      outcome: 'clarification-needed',
      summary: 'Choose the required behavior.',
      assessment: 'The two requested behaviors conflict.',
      questions: ['Which behavior is required?'],
      evidence: [],
      progress: { completed: [], remaining: ['Resolve requirements.'] },
    });
    assert.equal((await work.run('next')).status, 'idle');
    const records = (await request('inspect')).records as Array<{
      continuation: { phase: string; attempt?: unknown };
    }>;
    assert.equal(records[0]!.continuation.phase, 'blocked');
    assert.equal(records[0]!.continuation.attempt, undefined);
  });

  it('should stop when the selected implementation skill is unavailable instead of substituting', async () => {
    const work = await workIssue();
    work.continuation.native!.assessmentSkill = async () => {
      throw new Error('dispatch-assessment-skill-unavailable');
    };
    const stopped = await work.run('next');
    assert.equal(stopped.status, 'waiting');
    assert.equal('code' in stopped && stopped.code, 'dispatch-assessment-skill-unavailable');
  });

  it('should release intake capacity while retaining announcement recovery after pr delivery', async () => {
    const work = await workIssue();
    const deliveryId = work.id;
    assert.ok(typeof deliveryId === 'string');
    await work.run('next');
    work.receive();
    await work.run(
      'result',
      { result: { outcome: 'done', summary: 'Done.', fullResult: 'Checked work.' } },
      true,
    );
    const current = await selectCodexIntake(pluginData, deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    let confirmed = false;
    assert.equal(codexItemOccupied((await store.read()).records[0]!), true);
    work.continuation.deliver = async (_data, _value, deliveryDeps) => {
      await deliveryDeps?.authorizeSchedule?.();
      await store.exclusive(async (state, save) => {
        const record = state.records.find((entry) => entry.id === work.id)!;
        const announcement = attemptedAnnouncement('U_receiver').state;
        if (confirmed) announcement.receipt = { nodeId: 'IC_announcement', databaseId: 99 };
        else announcement.code = 'delivery-announcement-failed';
        record.delivery = {
          id: deliveryId,
          binding: {
            repositoryId: 'R_repo',
            issueId: 'I_issue',
            threadId: record.threadId!,
            worktree: record.worktree!,
            branch: 'branch',
            base: 'main',
            head: 'a'.repeat(40),
            authorId: 'U_receiver',
            policyDigest: 'a'.repeat(64),
          },
          creationAttempted: true,
          pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
          reconciled: true,
          attached: true,
          cardAttempts: 1,
          announcement,
        };
        await save();
      });
      return {
        status: 'linked',
        instruction: 'Present the card.',
        notices: [],
        url: 'https://github.com/owner/repo/pull/7',
        pullRequest: { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 },
        presentation: '> PR card',
      };
    };
    await work.run('delivery', { delivery: { action: 'present' } }, true);
    assert.equal((await store.read()).records[0]!.continuation!.phase, 'delivery');
    assert.equal(codexItemOccupied((await store.read()).records[0]!), false);
    const context = await work.run('context', {}, true);
    assert.equal('deliveryOnly' in context && context.deliveryOnly, true);
    confirmed = true;
    await work.run('delivery', { delivery: { action: 'present' } }, true);
    assert.equal((await store.read()).records[0]!.continuation!.phase, 'complete');
    assert.equal(codexItemOccupied((await store.read()).records[0]!), false);
  });

  it('should pass standing work publication authority to the existing delivery owner', async () => {
    const work = await workIssue();
    await work.run('next');
    work.receive();
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
      assert.deepEqual(deliveryDeps?.schedule?.saved.capabilities, [
        'assessment',
        'implementation',
        'publication',
      ]);
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
});
