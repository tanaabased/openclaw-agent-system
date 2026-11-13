import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import composeResponseBlocks from '../channels/github/presentation/response-blocks.ts';
import { taskResponseOutput } from '../agent/tasks/response/task-response.ts';
import { runCodexIntake } from '../agent/codex-intake.ts';
import { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import CodexDispatchStore from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import codexDispatchFixture from './codex-dispatch-fixture.ts';

describe('agent/codex task-handoff', () => {
  const fixtureState = codexDispatchFixture();
  it('should preserve native task ownership and checkout after an authorized handoff', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnStatus = 'completed';
    fixtureState.native!.turnEnded = true;
    fixtureState.now += 300001;
    const missing = await fixtureState.next();
    assert.equal(missing.status, 'idle');
    fixtureState.native!.turnId = 'authorized-follow-up';
    fixtureState.native!.followUpUserTurn = true;
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const branchStore = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    await branchStore.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.issueBranch = { attemptId: record.id, name: 'existing-work', phase: 'ready' };
      await save();
    });
    const ordinaryGit = fixtureState.deps.git!;
    fixtureState.deps.git = async (cwd, argv) =>
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
    const preview = await fixtureState.request('handoff', { id: prepared.id }, operator);
    assert.equal(preview.status, 'handoff-available');
    await assert.rejects(
      fixtureState.request('handoff', { id: prepared.id, digest: 'stale' }, operator),
      /dispatch-recovery-stale/,
    );
    const transitioned = await fixtureState.request(
      'handoff',
      { id: prepared.id, digest: preview.digest },
      operator,
    );
    assert.equal(transitioned.status, 'handed-off');
    assert.equal(transitioned.outcome, undefined);
    const after = (await fixtureState.readDispatchState()).records as Record<string, unknown>[];
    assert.equal('result' in after[0]!, false);
    assert.equal(after[0]!.worktree, fixtureState.worktree);
    assert.equal(
      (await fixtureState.request('handoff', { id: prepared.id }, operator)).changed,
      false,
    );
    const retirementRead = fixtureState.deps.native!.find;
    fixtureState.deps.native!.find = async (input) => {
      assert.equal(
        input.observationOnly,
        true,
        'handoff retains activity observation, not assessment monitoring',
      );
      return fixtureState.native;
    };
    assert.deepEqual(await fixtureState.next(), { status: 'idle', changed: false });
    fixtureState.deps.native!.find = retirementRead;
    assert.equal(
      (await fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }))
        .status,
      'verified',
    );
    fixtureState.fixture.item.state = 'closed';
    fixtureState.deps.native!.find = retirementRead;
    const retire = await fixtureState.request(
      'retire',
      { id: prepared.id },
      { threadId: 'operator' },
    );
    assert.equal(retire.status, 'retire-available');
  });

  it('should preserve issue state when native access needs host approval', async () => {
    const prepared = await fixtureState.prepare();
    const before = await fixtureState.readDispatchState();
    for (const code of ['EPERM', 'EACCES', 'automation-thread-host-access-required']) {
      fixtureState.deps.native!.find = async () => {
        throw Object.assign(new Error('denied'), { code });
      };
      await assert.rejects(fixtureState.request('reconcile', { id: prepared.id }), { code });
      assert.deepEqual({ ...(await fixtureState.readDispatchState()), run: before.run }, before);
    }
  });

  it('should refuse a quiet report based on a previous occurrence until a fresh scan completes', async () => {
    fixtureState.now += 60000;
    await assert.rejects(fixtureState.report(), /dispatch-scan-required/);
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    assert.equal((await fixtureState.report()).status, 'continue');
  });

  it('should require a new terminal dispatch check after each scan occurrence', async () => {
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    await current.store.exclusive(async (state, save) => {
      state!.records = [];
      await save(state!);
    });
    assert.equal((await fixtureState.report()).status, 'continue');
    await fixtureState.next();
    assert.equal((await fixtureState.report()).status, 'report');
    fixtureState.now += 60000;
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    assert.equal((await fixtureState.report()).status, 'continue');
    assert.equal((await fixtureState.next()).status, 'routing-required');
    assert.equal((await fixtureState.report()).status, 'continue');
  });

  it('should retain cards and require continuation after an early report', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: 'issue-thread' },
    });
    const premature = await fixtureState.report();
    assert.equal(premature.status, 'continue');
    assert.equal(premature.nextAction, 'next');
    assert.equal(premature.remainingActions, 9);
    assert.equal(premature.response, undefined);
    await fixtureState.next();
    assert.equal((await fixtureState.report()).status, 'report');
  });

  it('should bind reporting and action limits to the native occurrence', async () => {
    const previousTime = fixtureState.now;
    for (let action = 0; action < 12; action++)
      assert.equal((await fixtureState.next()).status, 'routing-required');
    assert.equal((await fixtureState.next()).status, 'budget-exhausted');
    assert.equal((await fixtureState.report()).status, 'report');
    fixtureState.now += 300000;
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    const stale = await fixtureState.request('report', {
      automationId: 'native-intake',
      currentTimeIso: new Date(previousTime).toISOString(),
    });
    assert.equal(stale.status, 'continue');
    assert.equal(stale.nextAction, 'next');
    assert.deepEqual(stale.request, { action: 'next' });
    const fresh = await fixtureState.report();
    assert.equal(fresh.status, 'continue');
    assert.equal(fresh.remainingActions, 12);
    assert.equal((await fixtureState.next()).status, 'routing-required');
    assert.equal(((await fixtureState.readDispatchState()).records as unknown[]).length, 1);
  });

  it('should recover creation on the next occurrence when its receipt exceeds the action budget', async () => {
    let selected: Record<string, unknown> = {};
    for (let action = 0; action < 11; action++) selected = await fixtureState.next();
    const prepared = await fixtureState.request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal(prepared.status, 'prepared');
    fixtureState.created();
    assert.equal(
      (
        await fixtureState.request('reconcile', {
          id: prepared.id,
          receipt: { threadId: 'issue-thread' },
        })
      ).status,
      'budget-exhausted',
    );
    assert.equal((await fixtureState.report()).status, 'report');
    fixtureState.now += 300000;
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    const recovered = await fixtureState.next();
    assert.equal(recovered.status, 'created');
    assert.equal(recovered.threadId, 'issue-thread');
    assert.equal(
      (
        await fixtureState.request('prepare', {
          id: prepared.id,
          title: 'repair contained behavior',
          assessment: { complexity: 'medium', reason: 'Retained selection.' },
        })
      ).status,
      'reconcile-required',
    );
    await fixtureState.next();
    assert.match(String((await fixtureState.report()).response), /1 issue started/);
    assert.equal(((await fixtureState.readDispatchState()).records as unknown[]).length, 1);
  });

  it('should require a later user turn and preserve native chat and repository checks for handoff', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    const child = { threadId: 'issue-thread' };
    await assert.rejects(
      fixtureState.request('handoff', { id: prepared.id }),
      /dispatch-handoff-caller-mismatch/,
    );
    await assert.rejects(
      fixtureState.request('handoff', { id: prepared.id }, child),
      /workflow-policy-held/,
    );
    fixtureState.native!.followUpUserTurn = true;
    fixtureState.native!.turnId = 'follow-up';
    const preview = await fixtureState.request('handoff', { id: prepared.id }, child);
    fixtureState.native!.turnId = 'newer-follow-up';
    await assert.rejects(
      fixtureState.request('handoff', { id: prepared.id, digest: preview.digest }, child),
      /dispatch-recovery-stale/,
    );
    const original = fixtureState.deps.git!;
    fixtureState.deps.git = async (cwd, argv) =>
      argv[0] === 'remote' ? 'https://github.com/other/repo.git' : original(cwd, argv);
    await assert.rejects(
      fixtureState.request('handoff', { id: prepared.id }, child),
      /dispatch-worktree-diverged/,
    );
    fixtureState.deps.git = original;
    fixtureState.native!.cwd = fixtureState.source;
    await assert.rejects(
      fixtureState.request('handoff', { id: prepared.id }, child),
      /dispatch-native-readback-diverged/,
    );
  });

  it('should apply live debug edits to cached intake reports without replaying starts', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: 'issue-thread' },
    });
    await fixtureState.next();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await fixtureState.next();
    const first = await fixtureState.report();
    assert.equal(first.status, 'report');
    assert.match(String(first.response), /1 issue started/);
    const saved = await store.read();
    const record = structuredClone(saved.records[0]);
    const operational = saved.run!.response;
    for (const debug of [true, false, true]) {
      await writeFile(
        join(fixtureState.workspace, 'agent.yaml'),
        JSON.stringify({ ...fixtureState.manifest, debug }),
      );
      const repeated = await fixtureState.report();
      assert.equal(repeated.status, 'report');
      assert.doesNotMatch(String(repeated.response), /🔬|retirement-outcome-unverified/);
      assert.match(String(repeated.response), /1 issue started/);
      assert.equal((await store.read()).run!.response, operational);
      assert.deepEqual((await store.read()).records[0], record);
    }
  });

  it('should preserve a handoff preview across feedback scans and intake presentation updates', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    const child = { threadId: 'issue-thread' };
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    await fixtureState.renderAssessment(fixtureState.result, child);
    fixtureState.native!.followUpUserTurn = true;
    fixtureState.native!.turnId = 'authorized-follow-up';
    const preview = await fixtureState.request('handoff', { id: prepared.id }, child);
    const selected = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(
      selected.store.location.root,
      selected.store.location.scope,
    );
    const feedback = {
      startedAt: fixtureState.now,
      baseline: {},
      events: [],
      scannedAt: 'later-scan',
      scannedTime: fixtureState.now + 1,
    };
    await store.exclusive(async (state, save) => {
      const record = state.records.find((item) => item.id === prepared.id)!;
      record.feedback = feedback;
      record.intakeReportedAt = fixtureState.now + 1;
      await save();
    });
    assert.equal(
      (await fixtureState.request('handoff', { id: prepared.id, digest: preview.digest }, child))
        .status,
      'handed-off',
    );
    const retained = (await store.read()).records.find((item) => item.id === prepared.id)!;
    assert.deepEqual(retained.feedback, feedback);
  });

  it('should hold admitted dispatch while disabled and resume it before checking lifecycle', async () => {
    const selected = await fixtureState.next();
    await fixtureState.workflow(false);
    assert.equal((await fixtureState.next()).status, 'idle');
    await fixtureState.workflow(true);
    const resumed = await fixtureState.next();
    assert.equal(resumed.status, 'routing-required');
    assert.equal(resumed.id, selected.id);
    fixtureState.fixture.item.state = 'closed';
    const rejected = await fixtureState.request('prepare', {
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
      const routed = await fixtureState.next();
      const activation = fixtureState.deps.activation!;
      let paused = false;
      fixtureState.deps.activation = async (...args) => {
        if (paused && !args[3]) throw new Error('intake-automation-paused');
        return activation(...args);
      };
      if (pause === 'manifest') {
        const configured = structuredClone(fixtureState.manifest);
        Object.assign(configured.github['issue-assignment'], { paused: true });
        await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(configured));
      }
      paused = true;
      const prepared = await fixtureState.request('prepare', {
        id: routed.id,
        digest: routed.digest,
        title: 'repair contained behavior',
        assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
      });
      assert.equal(prepared.status, 'prepared');
      fixtureState.now += 60000;
      await assert.rejects(fixtureState.next(), /intake-automation-paused/u);
      paused = false;
      await writeFile(
        join(fixtureState.workspace, 'agent.yaml'),
        JSON.stringify(fixtureState.manifest),
      );
      await fixtureState.next();
      const records = (await fixtureState.readDispatchState()).records as { id: string }[];
      assert.equal(records.length, 1);
      assert.equal(records[0]!.id, routed.id);
    });

  it('should retain an admitted creation when intake is disabled during preparation', async () => {
    const selected = await fixtureState.next();
    const connect = fixtureState.deps.connect!;
    const prepared = await fixtureState.request(
      'prepare',
      {
        id: selected.id,
        digest: selected.digest,
        title: 'repair contained behavior',
        assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
      },
      {
        connect: async (workspace, signal) => {
          await fixtureState.workflow(false);
          return connect(workspace, signal);
        },
      },
    );
    assert.equal(prepared.status, 'policy-held');
    const retained = (await fixtureState.readDispatchState()).records as { request?: unknown }[];
    assert.equal(retained[0]!.request, undefined);
    await fixtureState.workflow(true);
    assert.equal((await fixtureState.next()).id, selected.id);
  });

  it('should retain a child task when intake and assigner defaults change', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    const child = { threadId: 'issue-thread' };
    await fixtureState.request('context', { id: prepared.id }, child);
    const configured = structuredClone(fixtureState.manifest);
    Object.assign(configured.github['issue-assignment'], {
      paused: true,
      allowed: [{ login: 'other', 'node-id': 'U_other' }],
    });
    await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(configured));
    assert.equal(
      (await fixtureState.renderAssessment(fixtureState.result, child)).status,
      'formatted',
    );
    const records = (await fixtureState.readDispatchState()).records as {
      phase: string;
      result?: unknown;
    }[];
    assert.equal('result' in records[0]!, false);
  });

  for (const phase of ['creating', 'created'] as const)
    it(`should retain ${phase} work and accept its verified child result while disabled`, async () => {
      const prepared = await fixtureState.prepare();
      const child = { threadId: 'issue-thread' };
      if (phase !== 'creating') {
        fixtureState.created();
        assert.equal(
          (await fixtureState.request('context', { id: prepared.id }, child)).status,
          'verified',
        );
      }
      await fixtureState.workflow(false);
      const activation = fixtureState.deps.activation;
      fixtureState.deps.activation = async (_root, _deps, _paused, retainedWork) => {
        assert.equal(retainedWork, true);
        return { sourceThreadId: 'intake-thread' };
      };
      if (phase === 'creating') {
        const uncertain = await fixtureState.request('reconcile', { id: prepared.id });
        assert.equal(uncertain.code, 'dispatch-creation-unresolved');
        fixtureState.created();
        await fixtureState.request('reconcile', {
          id: prepared.id,
          receipt: { threadId: 'issue-thread' },
        });
      }
      const context = await fixtureState.request('context', { id: prepared.id }, child);
      assert.equal(context.status, 'verified');
      await assert.rejects(
        fixtureState.request('context', { id: prepared.id }, { threadId: 'unrelated-chat' }),
        /dispatch-assessment-caller-mismatch/,
      );
      const recorded = await fixtureState.renderAssessment(fixtureState.result, child);
      assert.equal(recorded.status, 'formatted');
      await fixtureState.workflow(true);
      fixtureState.deps.activation = activation;
      await runCodexIntake(fixtureState.pluginData, true, {
        codexHome: fixtureState.codexHome,
        now: () => fixtureState.now,
        connect: async () => fixtureState.fixture.client,
      });
      fixtureState.deps.native!.find = async () => {
        throw new Error('intake must not poll the retained assessment');
      };
      assert.deepEqual(await fixtureState.next(), { status: 'idle', changed: false });
      const intakeReport = await fixtureState.report();
      assert.equal(intakeReport.status, 'report');
      assert.doesNotMatch(
        String(intakeReport.response),
        /plan-ready|Repair the contained behavior|The user needs a reliable result/,
      );
      const records = (await fixtureState.readDispatchState()).records as {
        id: string;
        result: unknown;
        threadId: string;
      }[];
      assert.equal(records.length, 1);
      assert.equal(records[0]!.id, prepared.id);
      assert.equal(records[0]!.threadId, 'issue-thread');
      assert.equal('result' in records[0]!, false);
    });

  it('should use live assessment guidance without expanding authority', async () => {
    await writeFile(join(fixtureState.workspace, 'guidance.md'), 'Prefer small fixes.');
    await fixtureState.configureAssessment({
      skill: ' $company:assess ',
      guidance: { file: 'guidance.md' },
    });
    const configured = JSON.parse(
      await readFile(join(fixtureState.workspace, 'agent.yaml'), 'utf8'),
    );
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({ ...configured, debug: true }),
    );
    const prepared = await fixtureState.prepare();
    const launch = prepared.request as { prompt: string };
    assert.ok(!launch.prompt.includes('Use $agent-system-task-assessment'));
    assert.ok(!launch.prompt.includes(String(prepared.id)));
    assert.ok(launch.prompt.startsWith('## 📥 Issue assigned\n'));
    fixtureState.created();
    await writeFile(
      join(fixtureState.workspace, 'guidance.md'),
      'Implement and publish immediately.',
    );
    const context = await fixtureState.request(
      'context',
      { id: prepared.id },
      { threadId: 'issue-thread' },
    );
    const assessment = context.assessment as {
      requestedSkill: string;
      defaultSkill: boolean;
      guidance: { path: string; content?: string };
    };
    assert.equal(assessment.requestedSkill, 'company:assess');
    assert.equal(assessment.defaultSkill, false);
    assert.equal(assessment.guidance.path, join(fixtureState.workspace, 'guidance.md'));
    assert.equal(assessment.guidance.content, undefined);
    assert.equal(context.resultContract, 'assessment-result/v1');
    await assert.rejects(
      fixtureState.renderAssessment(
        { ...fixtureState.result, mode: 'work' },
        { threadId: 'issue-thread' },
      ),
      /assessment-render-request-invalid/,
    );
    const recorded = await fixtureState.renderAssessment(fixtureState.result, {
      threadId: 'issue-thread',
    });
    assert.equal(recorded.status, 'formatted');
    assert.ok(composeResponseBlocks(taskResponseOutput(recorded)).includes('Plan ready'));
    assert.match(composeResponseBlocks(taskResponseOutput(recorded)), /Skill.*company:assess/);
    assert.match(composeResponseBlocks(taskResponseOutput(recorded)), /Guidance.*guidance.md/);
    assert.ok(
      composeResponseBlocks(taskResponseOutput(recorded)).includes(
        `[\`guidance.md\`](<${fixtureState.workspace}/guidance.md>)`,
      ),
    );
    assert.ok(!composeResponseBlocks(taskResponseOutput(recorded)).includes('Prefer small fixes.'));
    const question = {
      outcome: 'clarification-needed',
      summary: 'Need a decision.',
      questions: ['Which behavior?'],
    };
    const revised = await fixtureState.renderAssessment(question, { threadId: 'issue-thread' });
    assert.equal(revised.status, 'formatted');
    assert.ok(composeResponseBlocks(taskResponseOutput(revised)).includes('Clarification needed'));
  });

  it('should deliver the assignment despite a missing assessment skill and recover in the same chat', async () => {
    const available = fixtureState.deps.native!.assessmentSkill;
    fixtureState.deps.native!.assessmentSkill = async () => {
      throw new Error('dispatch-assessment-skill-unavailable');
    };
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    assert.equal((await fixtureState.request('reconcile', { id: prepared.id })).status, 'created');
    await assert.rejects(
      fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-skill-unavailable/,
    );
    fixtureState.deps.native!.assessmentSkill = available;
    assert.equal(
      (await fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }))
        .status,
      'verified',
    );
    const records = (await fixtureState.readDispatchState()).records as Array<{
      request?: unknown;
    }>;
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]!.request, prepared.request);
  });

  it('should use updated assessment skill content without replacing the native request', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    const selected = fixtureState.deps.native!.assessmentSkill;
    fixtureState.deps.native!.assessmentSkill = async (cwd, id) => ({
      ...(await selected(cwd, id)),
      digest: 'b'.repeat(64),
    });
    const context = await fixtureState.request(
      'context',
      { id: prepared.id },
      { threadId: 'issue-thread' },
    );
    assert.equal(
      (context.assessment as { skill: { digest: string } }).skill.digest,
      'b'.repeat(64),
    );
    const records = (await fixtureState.readDispatchState()).records as Array<{ request: unknown }>;
    assert.deepEqual(records[0]!.request, prepared.request);
  });

  it('should report ambiguous live skill selection without silently choosing the historical skill', async () => {
    await fixtureState.configureAssessment({ skill: '$assess' });
    const resolve = fixtureState.deps.native!.assessmentSkill;
    fixtureState.deps.native!.assessmentSkill = async (cwd, id) => {
      if (fixtureState.native && id === 'assess')
        throw new Error('dispatch-assessment-skill-ambiguous');
      return resolve(cwd, 'company:assess');
    };
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await assert.rejects(
      fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-skill-ambiguous/,
    );
  });

  it('should deliver the assignment despite unreadable assessment guidance and recover in the same chat', async () => {
    await fixtureState.configureAssessment({ guidance: { file: 'missing.md' } });
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    assert.equal((await fixtureState.request('reconcile', { id: prepared.id })).status, 'created');
    await assert.rejects(
      fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-assessment-guidance-unreadable/,
    );
    await writeFile(join(fixtureState.workspace, 'missing.md'), 'Prefer small fixes.');
    assert.equal(
      (await fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }))
        .status,
      'verified',
    );
    const records = (await fixtureState.readDispatchState()).records as Array<{
      request?: unknown;
    }>;
    assert.deepEqual(records[0]!.request, prepared.request);
  });

  it('should recognize an unchanged repo skill in the verified child worktree', async () => {
    fixtureState.deps.native!.assessmentSkill = async (cwd, id) => ({
      name: id,
      path: join(cwd, '.agents/skills/assessment/SKILL.md'),
      scope: 'repo',
      digest: 'a'.repeat(64),
    });
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    const context = await fixtureState.request(
      'context',
      { id: prepared.id },
      { threadId: 'issue-thread' },
    );
    assert.equal(
      (context.assessment as { skill: { path: string } }).skill.path,
      join(fixtureState.worktree, '.agents/skills/assessment/SKILL.md'),
    );
  });
});
