import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import properLockfile from 'proper-lockfile';

import { runCodexDispatch, type CodexDispatchDependencies } from '../agent/codex-dispatch.ts';
import type { DispatchNativeThread } from '../agent/codex-dispatch-native.ts';
import { runCodexIntake, selectCodexIntake } from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
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
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex-dispatch-')));
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
        async deliveredReports() {
          return [];
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

  it('should end assessment monitoring after authorized continuation without rewriting the result or checkout', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: native!.id } });
    native!.status = 'idle';
    native!.turnStatus = 'completed';
    now += 300001;
    const missing = await next();
    assert.equal(missing.code, 'dispatch-assessment-result-missing');
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
    assert.equal(transitioned.severity, 'info');
    assert.equal(transitioned.notify, false);
    assert.equal(transitioned.outcome, undefined);
    const after = (await request('inspect')).records as Record<string, unknown>[];
    assert.deepEqual(after[0]!.result, before[0]!.result);
    assert.equal(after[0]!.worktree, worktree);
    assert.equal((await request('handoff', { id: prepared.id }, operator)).changed, false);
    deps.native!.find = async () => {
      throw new Error('must not poll handed-off chat');
    };
    const notice = await next();
    assert.equal(notice.status, 'handed-off');
    assert.equal(notice.changed, true);
    assert.equal(notice.notify, false);
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    await assert.rejects(
      request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-handed-off/,
    );
    fixture.item.state = 'closed';
    const retire = await request('retire', { id: prepared.id }, { threadId: 'operator' });
    assert.equal(retire.status, 'retire-available');
  });

  it('should retain a quiet handoff across fresh calls until its exact report is delivered', async () => {
    const prepared = await prepare();
    created();
    await request('reconcile', { id: prepared.id, receipt: { threadId: 'issue-thread' } });
    const started = await report();
    deps.native!.deliveredReports = async () => [String(started.response)];
    assert.equal((await report()).pendingNotices, 0);
    deps.native!.deliveredReports = async () => [];
    native!.turnId = 'authorized-work';
    native!.followUpUserTurn = true;
    const operator = { threadId: 'operator' };
    const preview = await request('handoff', { id: prepared.id }, operator);
    await request('handoff', { id: prepared.id, digest: preview.digest }, operator);
    assert.equal((await next()).status, 'handed-off');
    assert.equal((await next()).status, 'idle');
    const before = (await request('inspect')).records;
    const pending = await report();
    assert.equal(pending.pendingNotices, 1);
    assert.match(String(pending.response), /DONT_NOTIFY/);
    assert.match(String(pending.response), /Work continuing in the issue chat/);
    assert.equal(String(pending.response).split('<heartbeat>').length, 2);
    assert.deepEqual(await report(), pending);
    deps.native!.deliveredReports = async () => {
      throw new Error('history unavailable');
    };
    await assert.rejects(report(), /history unavailable/);
    assert.equal(((await request('inspect')).notices as unknown[]).length, 1);
    deps.native!.deliveredReports = async (threadId, reports) => {
      assert.equal(threadId, 'intake-thread');
      assert.deepEqual(
        reports.map((entry) => entry.response),
        [pending.response],
      );
      return reports.map((entry) => entry.response);
    };
    const delivered = await report();
    assert.equal(delivered.pendingNotices, 0);
    assert.doesNotMatch(String(delivered.response), /Work continuing/);
    assert.deepEqual((await request('inspect')).records, before);
    assert.deepEqual((await request('inspect')).reports, []);
  });

  it('should preserve issue state when native access needs host approval', async () => {
    const prepared = await prepare();
    const before = await request('inspect');
    for (const code of ['EPERM', 'EACCES', 'automation-thread-host-access-required']) {
      deps.native!.find = async () => {
        throw Object.assign(new Error('denied'), { code });
      };
      await assert.rejects(request('reconcile', { id: prepared.id }), { code });
      assert.deepEqual(await request('inspect'), before);
    }
  });

  it('should refuse a quiet report based on a previous occurrence until a fresh scan completes', async () => {
    now += 60000;
    await assert.rejects(report(), /dispatch-scan-required/);
    await runCodexIntake(pluginData, false, deps);
    assert.equal((await report()).pendingNotices, 0);
  });

  it('should retain scan failure and recovery until their combined report is delivered', async () => {
    const unavailable = {
      ...deps,
      connect: async () => {
        throw new Error('provider unavailable');
      },
    };
    await runCodexIntake(pluginData, false, unavailable);
    now += 300001;
    await runCodexIntake(pluginData, false, deps);
    const pending = await report();
    assert.equal(pending.pendingNotices, 2);
    assert.match(String(pending.response), /<decision>NOTIFY<\/decision>/);
    await runCodexIntake(pluginData, false, deps);
    assert.deepEqual(await report(), pending);
    deps.native!.deliveredReports = async () => [String(pending.response)];
    assert.equal((await report()).pendingNotices, 0);
    const current = await selectCodexIntake(pluginData, deps);
    assert.deepEqual((await current.store.read())?.notices, []);
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

  it('should retain a normalized replacement and guidance across continuation without expanding authority', async () => {
    await writeFile(join(workspace, 'guidance.md'), 'Prefer small fixes.');
    await configureAssessment({ skill: ' $company:assess ', guidance: { file: 'guidance.md' } });
    const prepared = await prepare();
    const launch = prepared.request as { prompt: string };
    assert.ok(!launch.prompt.includes('Use $agent-system-issue-assessment'));
    assert.ok(launch.prompt.includes(JSON.stringify({ action: 'context', id: prepared.id })));
    assert.ok(launch.prompt.includes('JSON on stdin'));
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
    assert.ok(!String(recorded.presentation).includes(workspace));
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
    const legacy = await request('inspect');
    delete (legacy.records as Array<Record<string, unknown>>)[0]!.assessment;
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
    assert.deepEqual(after[0], { ...before[0], retired: { at: now, by: 'operator' } });
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    await assert.rejects(
      request('context', { id: first.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-retired/,
    );
    fixture.item.state = 'open';
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    await reassign();
    const second = await prepare();
    assert.notEqual(second.id, first.id);
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
    assert.match(String(blocked.message), /^## ⚠️ Add the project to continue\n/u);
    assert.ok(String(blocked.message).includes('- **Project name:** repo\n'));
    assert.ok(String(blocked.message).includes('- **Folder path:** ' + source + '\n'));
    assert.match(String(blocked.message), /https:\/\/github.com\/owner\/repo\/issues\/3/u);
    assert.match(String(blocked.message), /https:\/\/github.com\/receiver/u);
    assert.ok(String(blocked.message).includes(source));
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
        assert.equal(result.status, broken && !managed ? 'blocked' : 'routing-required');
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
    assert.ok(String(blocked.message).includes(source));
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
    assert.ok(String(blocked.message).includes(path));
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
    assert.ok(String(recorded.presentation).includes(result.assessment));
    assert.ok(String(recorded.presentation).includes(result.planSummary));
    assert.ok(String(recorded.presentation).includes(result.plan));
    assert.match(String(recorded.presentation), /Selected.*gpt-6\.1-sol \/ high/);
    assert.match(
      String(recorded.presentation),
      /Effective settings.*Verified: gpt-6\.1-sol \/ high/,
    );
    assert.equal((await next()).outcome, 'plan-ready');
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
    assert.equal((await next()).changed, true);
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
    await assert.rejects(
      request('reconcile', { id: prepared.id }),
      /dispatch-assignment-authority-revoked/,
    );
    assert.deepEqual(await request('inspect'), completed);
    assert.equal((await next()).outcome, 'plan-ready');
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
    assert.equal(revoked.code, 'dispatch-assignment-authority-revoked');
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
    assert.equal((await next()).code, 'dispatch-assessment-result-missing');
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
        assert.equal((await next()).status, 'assessing');
        const records = (await request('inspect')).records as { phase: string; result?: unknown }[];
        assert.equal(records.length, 1);
        assert.equal(records[0]!.phase, 'assessing');
        assert.equal(records[0]!.result, undefined);
      }
    }
    await request('result', { id: prepared.id, result }, { threadId: 'issue-thread' });
    assert.equal((await next()).outcome, 'plan-ready');
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
});
