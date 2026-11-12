import { GatewayClientRequestError } from '@openclaw/gateway-client';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { automationHash } from '../agent/automation-hash.ts';
import { issueKey } from '../agent/tasks/dispatch/dispatch-pending.ts';
import openClawCapacity from '../agent/tasks/dispatch/openclaw-capacity.ts';
import OpenClawDispatchStore from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import OpenClawDispatch from '../agent/tasks/dispatch/openclaw-dispatch.ts';
import AgentSystemToolError from '../api/error.ts';
import { claimBody } from '../channels/github/provider/assignment-claim.ts';
import { privateStateFileLockBusyErrorCode } from '../core/private-state-file-lock.ts';
import GitCommandError from '../tools/git/command-error.ts';
import { RepositoryPreparationError } from '../tools/git/repository-service.ts';
import GitWorktreeConflict from '../tools/git/worktree-conflict.ts';
import { baseline, removeFixtureAssignment } from './github-intake-fixture.ts';
import openclawDispatchFixture from './openclaw-dispatch-fixture.ts';

describe('agent/openclaw dispatch', () => {
  const fixtureState = openclawDispatchFixture();
  it('should apply current debug visibility to a cached intake report without repeating report effects', async () => {
    await fixtureState.prepare(await fixtureState.next());
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const caller = { ...fixtureState.coordinator, runId: 'debug-report' };
    const first = await fixtureState.service.run(fixtureState.manifest, fixtureState.root, caller, {
      action: 'report',
    });
    assert.equal(first.status, 'reported');
    assert.ok('response' in first);
    assert.match(String(first.response), /1 issue started/);
    assert.doesNotMatch(String(first.response), /🔬|retirement-outcome-unverified/);
    const saved = await current.journal.read();
    for (const debug of [true, false, true]) {
      fixtureState.manifest.debug = debug;
      const repeated = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        caller,
        { action: 'report' },
      );
      assert.ok('response' in repeated);
      assert.doesNotMatch(String(repeated.response), /🔬|retirement-outcome-unverified/);
      assert.deepEqual(await current.journal.read(), saved);
    }
  });

  it('should retain dispatch custody when assigner defaults change', async () => {
    fixtureState.manifest.github!.notifications!.runtimes = ['openclaw', 'codex'];
    await fixtureState.service.dependencies.intake.run(
      fixtureState.manifest,
      fixtureState.root,
      'activate',
    );
    const routed = await fixtureState.next();
    await fixtureState.prepare(routed);
    await fixtureState.assess(routed.id);
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const previousManifestDigest = automationHash({
      policy: 'previous-policy',
      models: fixtureState.manifest.models,
    });
    assert.notEqual(current.manifestDigest, previousManifestDigest);
    await current.journal.exclusive(async (state, save) => {
      state.records[0]!.manifestDigest = previousManifestDigest;
      await save();
    });
    assert.equal((await fixtureState.context(routed.id)).status, 'verified');
    const workflow = fixtureState.manifest.github!.notifications!.issueAssignment!;
    workflow.allowed[0] = { ...workflow.allowed[0]!, nodeId: 'foreign' };
    assert.equal((await fixtureState.context(routed.id)).status, 'verified');
  });

  it('should commit unrelated progress while native readiness is delayed', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const intake = fixtureState.fixtureIntake;
    const readiness = intake.readiness.bind(intake);
    intake.readiness = async (...args) => {
      entered.resolve();
      await release.promise;
      return readiness(...args);
    };
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const other = new OpenClawDispatchStore(current.journal.root, current.journal.scope);
    const pending = fixtureState.next();
    await entered.promise;
    try {
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

  for (const competing of ['reset', 'occurrence'] as const)
    it(`should reject stale readiness after a competing ${competing}`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      fixtureState.service.dependencies.intake.readiness = async () => {
        entered.resolve();
        await release.promise;
        return undefined;
      };
      const journal = (await fixtureState.service.scope(fixtureState.manifest, fixtureState.root))
        .journal;
      const expected =
        competing === 'reset'
          ? /notification-reset-stale-operation/
          : /dispatch-occurrence-mismatch/;
      const pending = assert.rejects(fixtureState.next(), expected);
      await entered.promise;
      if (competing === 'reset') await journal.reset('new-generation');
      else
        await journal.exclusive(async (state, save) => {
          state.openclawOccurrence = {
            sessionKey: fixtureState.coordinator.sessionKey,
            sessionId: fixtureState.coordinator.sessionId,
            runId: 'successor',
          };
          await save();
        });
      release.resolve();
      await pending;
      const saved = await journal.read();
      assert.equal(fixtureState.creates().length, 0);
      if (competing === 'reset') assert.equal(saved.resetGeneration, 'new-generation');
      else assert.equal(saved.openclawOccurrence?.runId, 'successor');
    });

  for (const pause of ['native', 'manifest'] as const)
    it(`should finish an accepted run through ${pause} pause and gate the next occurrence`, async () => {
      const routed = await fixtureState.next();
      const intake = fixtureState.fixtureIntake;
      const readiness = intake.readiness.bind(intake);
      if (pause === 'manifest')
        fixtureState.manifest.github!.notifications!.issueAssignment!.paused = true;
      intake.readiness = async () => 'intake-automation-paused';
      await fixtureState.prepare(routed);
      assert.equal(fixtureState.creates().length, 1);
      fixtureState.coordinator.runId = 'next-paused-run';
      await assert.rejects(
        fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        ),
        /intake-automation-paused/u,
      );
      assert.equal(fixtureState.creates().length, 1);
      fixtureState.manifest.github!.notifications!.issueAssignment!.paused = false;
      intake.readiness = readiness;
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      assert.equal(fixtureState.creates().length, 1);
      assert.equal((await fixtureState.record()).id, routed.id);
    });

  it('should create a first assignment with uncached compact reviewers', async () => {
    fixtureState.manifest.github!.notifications!.issueAssignment!.feedback = {
      inherit: true,
      allowed: [
        { login: 'reviewer', nodeId: '', reference: '@reviewer' },
        { login: '', nodeId: 'U_second', reference: 'U_second' },
      ],
    };
    const routed = await fixtureState.next();
    assert.equal((await fixtureState.prepare(routed)).status, 'session-created');
    assert.equal(fixtureState.creates().length, 1);
    assert.equal((await fixtureState.record()).feedback!.admission?.enabled, true);
  });

  it('should retain the previous feedback policy check across coordinator runs', async () => {
    fixtureState.manifest.github!.notifications!.issueAssignment!.feedback = {
      inherit: false,
      allowed: [],
    };
    await fixtureState.next();
    const first = fixtureState.service.dependencies.now!();
    let now = first + 1000;
    fixtureState.service.dependencies.now = () => now;
    fixtureState.coordinator.runId = 'disabled-feedback-check';
    await fixtureState.next();
    assert.equal((await fixtureState.record()).feedback!.admission?.observedAt, now);
    fixtureState.manifest.github!.notifications!.issueAssignment!.feedback = {
      inherit: true,
      allowed: [],
    };
    now += 1000;
    fixtureState.coordinator.runId = 'enabled-feedback-check';
    await fixtureState.next();
    assert.equal((await fixtureState.record()).feedback!.admission?.after, first + 1000);
  });

  for (const failure of ['transport', 'fetch-lock', 'path-permissions', 'disk-full'] as const)
    it(`should retry a repaired ${failure} worktree failure without creating twice`, async () => {
      const input = await fixtureState.next();
      const original = fixtureState.service.dependencies.worktrees.prepareGitHub;
      fixtureState.service.dependencies.worktrees.prepareGitHub = async () => {
        const wrapped = (cause: Error) =>
          Object.assign(
            new AgentSystemToolError('execution_failed', 'Git worktree preparation failed'),
            { cause },
          );
        if (failure === 'fetch-lock')
          throw wrapped(
            new GitCommandError('fetch', {
              exitCode: 128,
              stderr: "Unable to create 'main.lock': File exists",
            }),
          );
        if (failure === 'disk-full')
          throw wrapped(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
        if (failure === 'path-permissions')
          throw wrapped(
            new RepositoryPreparationError('repository-path-unsafe', fixtureState.root),
          );
        throw new Error('session-dispatch-connect-timeout');
      };
      const failed = await fixtureState.prepare(input);
      assert.ok('code' in failed);
      assert.equal(
        failed.code,
        failure === 'transport'
          ? 'session-dispatch-connect-timeout'
          : failure === 'fetch-lock'
            ? 'git-fetch-lock-exit-128'
            : failure === 'path-permissions'
              ? 'repository-path-unsafe'
              : 'repository-io-unavailable',
      );
      const retained = await fixtureState.record();
      assert.equal(retained.retry?.attempts, 1);
      assert.equal(fixtureState.creates().length, 0);
      fixtureState.service.dependencies.worktrees.prepareGitHub = original;
      fixtureState.coordinator.runId = 'before-retry';
      assert.equal(
        (
          await fixtureState.service.run(
            fixtureState.manifest,
            fixtureState.root,
            fixtureState.coordinator,
            { action: 'next' },
          )
        ).status,
        'idle',
      );
      fixtureState.service.dependencies.now = () => retained.retryAfter!;
      fixtureState.coordinator.runId = 'retry-intake';
      const retry = await fixtureState.next();
      assert.equal(retry.id, input.id);
      assert.equal(retry.status, 'routing-required');
      assert.equal((await fixtureState.prepare(retry)).status, 'session-created');
      assert.equal(fixtureState.creates().length, 1);
    });

  it('should recover retained repository failures without replaying an existing native request', async () => {
    const selected = await fixtureState.next();
    const { journal } = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.blocker = 'git-fetch-lock-exit-128';
      state.records[0]!.failureStage = 'worktree';
      await save();
    });
    fixtureState.coordinator.runId = 'repaired-retained-preparation';
    const resumed = await fixtureState.next();
    assert.equal(resumed.id, selected.id);
    assert.equal((await fixtureState.prepare(resumed)).status, 'session-created');
    assert.equal(fixtureState.creates().length, 1);
    await journal.exclusive(async (state, save) => {
      state.records[0]!.blocker = 'git-fetch-lock-exit-128';
      state.records[0]!.failureStage = 'worktree';
      await save();
    });
    fixtureState.coordinator.runId = 'existing-native-request';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal(fixtureState.creates().length, 1);
    assert.equal((await fixtureState.record()).blocker, 'git-fetch-lock-exit-128');
  });

  it('should retry an already waiting collision with one durable worktree attempt', async () => {
    await fixtureState.next();
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await current.journal.exclusive(async (state, save) => {
      const record = state.records[0]!;

      record.blocker = 'dispatch-tool-execution-failed';
      record.failureStage = 'worktree';
      delete record.context;
      await save();
    });
    const id = (await fixtureState.record()).id;
    const retry = () =>
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'retry', id },
        true,
      );
    assert.equal((await retry()).status, 'routing-required');
    fixtureState.coordinator.runId = 'fresh-preparation';
    const original = fixtureState.service.dependencies.worktrees.prepareGitHub;
    const attempts: string[] = [];
    let interrupted = true;
    fixtureState.service.dependencies.worktrees.prepareGitHub = async (input) => {
      assert.equal(input.attemptId, id);
      assert.equal(input.separateCheckout, true);
      assert.equal((await fixtureState.record()).worktreeAttemptId, id);
      attempts.push(input.attemptId!);
      const prepared = await original(input);
      if (interrupted) {
        interrupted = false;
        throw new Error('lost-preparation-result');
      }
      return prepared;
    };
    await fixtureState.prepare(await fixtureState.next());
    assert.equal((await fixtureState.record()).request, undefined);
    assert.equal(fixtureState.creates().length, 0);
    assert.equal((await retry()).status, 'routing-required');
    fixtureState.coordinator.runId = 'retry-preparation';
    assert.equal((await fixtureState.prepare(await fixtureState.next())).status, 'session-created');
    assert.deepEqual(attempts, [id, id]);
    assert.equal(fixtureState.creates().length, 1);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'reconcile', id },
    );
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should retry a chatless waiting assignment by issue url', async () => {
    const selected = await fixtureState.next();
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await current.journal.exclusive(async (state, save) => {
      const waiting = state.records[0]!;

      waiting.blocker = 'git-worktree-path-occupied';
      waiting.failureStage = 'worktree';
      delete waiting.context;
      await save();
    });
    const target = 'https://github.com/owner/repo/issues/3';
    const retry = () =>
      fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'retry', target },
        true,
      );
    await assert.rejects(
      fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'retry', target },
      ),
      /dispatch-operator-required/,
    );
    fixtureState.fixture.item.state = 'closed';
    await assert.rejects(retry(), /dispatch-issue-closed/);
    fixtureState.fixture.item.state = 'open';
    const allowed = fixtureState.manifest.github!.notifications!.issueAssignment!.allowed;
    fixtureState.manifest.github!.notifications!.issueAssignment!.allowed = [];
    assert.equal((await retry()).status, 'policy-held');
    fixtureState.manifest.github!.notifications!.issueAssignment!.allowed = allowed;
    assert.equal((await retry()).status, 'routing-required');
    assert.equal((await current.journal.read()).records[0]!.id, selected.id);
    assert.equal(fixtureState.creates().length, 0);
    fixtureState.coordinator.runId = 'fresh-evidence-after-operator-retry';
    const fresh = await fixtureState.next();
    assert.equal(fresh.id, selected.id);
    assert.equal((await fixtureState.prepare(fresh)).status, 'session-created');
    await assert.rejects(retry(), /dispatch-native-recovery-required/);
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should refuse retry when retirement starts after target selection', async () => {
    const selected = await fixtureState.next();
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await current.journal.exclusive(async (state, save) => {
      state.records[0]!.retirement = {
        reason: 'assignment-removed',
        at: baseline,
        intakeId: state.records[0]!.intakeId!,
        checkedAt: baseline,
        eligibleAt: baseline,
      };
      await save();
    });
    await assert.rejects(
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'retry', id: selected.id },
        true,
      ),
      /dispatch-issue-inactive/,
    );
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should retain a bounded worktree conflict without creating a session', async () => {
    const selected = await fixtureState.next();
    fixtureState.service.dependencies.worktrees.prepareGitHub = async () => {
      const error = new AgentSystemToolError('execution_failed', 'bounded conflict');
      error.cause = new GitWorktreeConflict('owner-mismatch', 'occupied by another attempt');
      throw error;
    };
    const result = await fixtureState.prepare(selected);
    assert.ok('code' in result && result.code === 'git-worktree-owner-mismatch');
    assert.equal((await fixtureState.record()).blocker, 'git-worktree-owner-mismatch');
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should defer reporting during an overlapping journal operation without changing work', async () => {
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await current.journal.exclusive(async (state) => {
      const before = structuredClone(state);
      const busy = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'report' },
      );
      assert.equal(busy.status, 'busy');
      assert.deepEqual(state, before);
    });
    assert.equal(fixtureState.calls.length, 0);
  });

  it('should report scheduler drift and its recovery without creating issue sessions', async () => {
    const intake = fixtureState.fixtureIntake;
    const readiness = intake.readiness.bind(intake);
    intake.readiness = async () => 'intake-automation-update-required';
    const warning = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'report' },
    );
    assert.ok('response' in warning && typeof warning.response === 'string');
    assert.match(warning.response, /intake-automation-update-required/);
    assert.match(warning.response, /Agent System Install/);
    intake.readiness = readiness;
    const recovered = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'resumed' },
      { action: 'report' },
    );
    assert.ok('response' in recovered && typeof recovered.response === 'string');
    assert.match(recovered.response, /Intake resumed/);
    assert.match(recovered.response, /condition has cleared/);
    assert.equal(fixtureState.calls.filter((call) => call.method === 'sessions.create').length, 0);
  });

  it('should prepare the same intake report on retry and suppress its blocker after restart', async () => {
    const routed = await fixtureState.next();
    removeFixtureAssignment(fixtureState.fixture);
    await fixtureState.prepare(routed);
    const intake = fixtureState.fixtureIntake;
    const run = intake.run;
    let scans = 0;
    intake.run = async (...args) => {
      scans++;
      return run.apply(intake, args);
    };
    const first = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'report' },
    );
    assert.equal(first.status, 'reported');
    assert.ok(
      'response' in first &&
        typeof first.response === 'string' &&
        first.response.includes('Diagnostic'),
    );
    const replay = await new OpenClawDispatch(fixtureState.service.dependencies).run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'report' },
    );
    assert.deepEqual(replay, {
      ...first,
      instructions: 'Reproduce response unchanged. An empty response means no card.',
    });
    assert.equal(scans, 0, 'reporting must not discover or admit more assignments');
    intake.run = run;
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      true,
    );
    await fixtureState.acknowledgeReport();
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      false,
    );
    assert.equal(fixtureState.calls.filter((call) => call.method === 'sessions.create').length, 0);
  });

  for (const waiting of [false, true])
    it(`should admit ${waiting ? 'a waiting' : 'a new'} unset assignment with the configured default`, async () => {
      const selected = await fixtureState.next();
      if (waiting) {
        const { journal } = await fixtureState.service.scope(
          fixtureState.manifest,
          fixtureState.root,
        );
        await journal.exclusive(async (state, save) => {
          state.records[0]!.blocker = 'dispatch-routing-unresolved';
          state.records[0]!.failureStage = 'routing';
          await save();
        });
        fixtureState.coordinator.runId = 'next-occurrence';
        const resumed = await fixtureState.next();
        assert.equal(resumed.id, selected.id);
      }
      const target = 'https://github.com/owner/repo/issues/3';
      const prepared = await fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        {
          action: 'prepare',
          target,
          title: 'Fix reported failure',
          assessment: { complexity: 'unset', reason: 'No complexity tier is defensible yet.' },
        },
      );
      assert.equal(prepared.status, 'session-created', JSON.stringify(prepared));
      assert.equal(fixtureState.creates().length, 1);
      assert.equal(fixtureState.creates()[0]!.params.model, 'openai/gpt-6-astra');
      assert.equal(fixtureState.creates()[0]!.params.thinkingLevel, 'high');
      await fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'reconcile', target },
      );
      assert.equal(fixtureState.creates().length, 1);
      assert.equal(fixtureState.preparedWorktrees, 1);
      const saved = await fixtureState.record();
      assert.equal(saved.id, selected.id);
      assert.equal(saved.blocker, undefined);
      assert.equal(JSON.parse(saved.routing!).profile, 'default');
    });

  it('should identify missing routing configuration before preparing a native chat', async () => {
    delete fixtureState.manifest.models;
    await fixtureState.next();
    const prepared = await fixtureState.service.runModel(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'prepare',
        target: 'https://github.com/owner/repo/issues/3',
        title: 'Fix reported failure',
        assessment: { complexity: 'unset', reason: 'No complexity tier is defensible yet.' },
      },
    );
    assert.ok('code' in prepared);
    assert.equal(prepared.code, 'model-routing-not-configured');
    assert.equal(fixtureState.creates().length, 0);
    assert.equal(fixtureState.preparedWorktrees, 0);
  });

  it('should resolve coordinator preparation and replay from the semantic issue target', async () => {
    const next = await fixtureState.service.runModel(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.ok('target' in next && typeof next.target === 'string');
    const request = {
      action: 'prepare',
      target: next.target,
      title: 'repair the result',
      assessment: { complexity: 'medium', reason: 'Interacting concerns.' },
    };
    for (const field of ['id', 'digest', 'receipt'])
      await assert.rejects(
        fixtureState.service.runModel(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { ...request, [field]: 'a'.repeat(64) },
        ),
        /binding-override|model-request-invalid/,
      );
    const prepared = await fixtureState.service.runModel(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      request,
    );
    assert.equal(prepared.status, 'session-created');
    const before = fixtureState.calls.filter((call) => call.method === 'sessions.create').length;
    await fixtureState.service.runModel(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'reconcile',
        target: next.target,
      },
    );
    assert.equal(
      fixtureState.calls.filter((call) => call.method === 'sessions.create').length,
      before,
    );
    await assert.rejects(
      fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, sessionKey: 'another-coordinator' },
        request,
      ),
      /target-unavailable/,
    );
    await assert.rejects(
      fixtureState.service.runModel(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        {
          ...request,
          target: 'https://github.com/other/repo/issues/1',
        },
      ),
      /target-unavailable/,
    );
  });

  it('should snapshot custom routing and keep prepared settings after guidance edits', async () => {
    fixtureState.manifest.debug = true;
    fixtureState.manifest.models!.routing = {
      skill: 'custom-routing',
      guidance: { file: 'routing.md' },
    };
    fixtureState.ordinarySkills.push({
      name: 'custom-routing',
      source: 'workspace',
      filePath: join(fixtureState.root, 'SKILL.md'),
      eligible: true,
      modelVisible: true,
    });
    await writeFile(join(fixtureState.root, 'routing.md'), 'Prefer small contained work.');
    const input = await fixtureState.next();
    assert.ok('routing' in input && 'instructions' in input.routing);
    assert.equal(input.routing.instructions.requestedSkill, 'custom-routing');
    await fixtureState.prepare(input);
    const saved = await fixtureState.record();
    assert.equal(saved.routingInstructions?.guidance?.content, 'Prefer small contained work.');
    await writeFile(join(fixtureState.root, 'routing.md'), 'Prefer complex work.');
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'reconcile', id: input.id },
    );
    assert.equal((await fixtureState.record()).routing, saved.routing);
    assert.equal(fixtureState.creates().length, 1);
    await fixtureState.assess(input.id);
    await fixtureState.context(input.id);
    const recorded = await fixtureState.renderAssessment(input.id);
    assert.ok('presentation' in recorded && typeof recorded.presentation === 'string');
    assert.match(recorded.presentation, /Routing method.*custom-routing.*custom guidance/);
    assert.ok(recorded.presentation.includes('Model routing instructions'));
    assert.ok(recorded.presentation.includes('routing.md'));
    assert.ok(!recorded.presentation.includes('Prefer complex work.'));
    fixtureState.manifest.models!.routing = {
      guidance: 'Later configuration is not this decision.',
    };
  });

  it('should refuse stale routing guidance before creating a session', async () => {
    fixtureState.manifest.models!.routing = { guidance: { file: 'routing.md' } };
    await writeFile(join(fixtureState.root, 'routing.md'), 'First instructions.');
    const input = await fixtureState.next();
    await writeFile(join(fixtureState.root, 'routing.md'), 'Changed instructions.');
    const outcome = await fixtureState.prepare(input);
    assert.equal('code' in outcome && outcome.code, 'model-routing-instructions-changed');
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should refuse an unavailable custom routing skill', async () => {
    fixtureState.manifest.models!.routing = { skill: 'missing-routing' };
    const outcome = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal('code' in outcome && outcome.code, 'dispatch-assessment-skill-unavailable');
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should route with verified complexity despite a conflicting content assessment', async () => {
    fixtureState.service.dependencies.connect = async () => ({
      ...fixtureState.fixture.client,
      getItemContext: async () => ({
        title: 'Repair the result',
        body: 'Return the missing result.',
        comments: [],
        labels: [],
        truncated: false,
        routingMetadata: {
          complexity: { status: 'verified', source: 'native', value: 'medium' },
          workSize: { status: 'missing', source: 'native' },
        },
      }),
    });
    const input = await fixtureState.next();
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'prepare',
        id: input.id,
        digest: input.digest,
        title: 'repair the result',
        assessment: { complexity: 'high', reason: 'Issue prose sounds architectural.' },
      },
      false,
      {},
    );
    const decision = JSON.parse((await fixtureState.record()).routing!);
    assert.equal(decision.complexity, 'medium');
    assert.equal(decision.source, 'native');
    assert.equal(decision.profile, 'medium');
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should create a session without claims or initializing installation state', async () => {
    const comments = fixtureState.enableClaims('local');
    const store = fixtureState.service.dependencies.claimStore!;
    const selected = await fixtureState.next();
    assert.equal((await fixtureState.prepare(selected)).status, 'session-created');
    assert.equal(fixtureState.creates().length, 1);
    assert.equal((await fixtureState.record()).claimId, undefined);
    assert.equal(await store.inspect(), undefined);
    assert.equal(comments.length, 0);
  });

  it('should hold a pending swarm claim after switching its route to local', async () => {
    const comments = fixtureState.enableClaims();
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        )
      ).status,
      'claim-waiting',
    );
    fixtureState.manifest.github!.notifications!.routing = ['owner/*'];
    fixtureState.coordinator.runId = 'second-local-pass';
    const held = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal('code' in held && held.code, 'claim-disabled-pending');
    assert.equal(comments.length, 1);
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should enforce pool eligibility before native creation and retain the accepted owner after edits', async () => {
    const comments = fixtureState.enableClaims();
    const identity = await fixtureState.service.dependencies.claimStore!.identity();
    const other = '11111111-1111-4111-8111-111111111111';
    const route = (target: string | string[]) => {
      fixtureState.manifest.github!.notifications!.routing = [{ 'owner/repo': target }, 'owner/*'];
    };
    route([other]);
    const excluded = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal(
      (excluded as { claim?: { code?: string } }).claim?.code,
      'claim-route-instance-ineligible',
    );
    assert.equal(comments.length, 0);
    assert.equal(fixtureState.creates().length, 0);
    route([other, identity.instanceId]);
    fixtureState.coordinator.runId = 'eligible-first';
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        )
      ).status,
      'claim-waiting',
    );
    fixtureState.coordinator.runId = 'eligible-second';
    const selected = await fixtureState.next();
    route(other);
    const held = await fixtureState.prepare(selected);
    assert.equal(
      (held as { claim?: { code?: string } }).claim?.code,
      'claim-route-owner-ineligible',
    );
    assert.equal(fixtureState.creates().length, 0);
    route(identity.instanceId);
    fixtureState.coordinator.runId = 'eligible-third';
    const ready = await fixtureState.next();
    assert.equal((await fixtureState.prepare(ready)).status, 'session-created');
    route([other]);
    fixtureState.coordinator.runId = 'excluded-after-creation';
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'reconcile', id: ready.id },
    );
    assert.equal(fixtureState.creates().length, 1);
    assert.match(comments[0]!.body, /Assignment accepted/u);
  });

  it('should hold a pending pilot assignment when claim election becomes dormant', async () => {
    const comments = fixtureState.enableClaims();
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    const store = fixtureState.service.dependencies.claimStore!;
    const before = await store.file.read();
    delete fixtureState.service.dependencies.claims;
    fixtureState.coordinator.runId = 'second-native-occurrence';
    const held = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.ok('code' in held && held.code === 'claim-disabled-pending');
    assert.equal(fixtureState.preparedWorktrees, 0);
    assert.equal(fixtureState.creates().length, 0);
    assert.equal(await store.file.read(), before);
    assert.equal(comments.length, 1);
  });

  it('should hold a selected pilot assignment before native preparation while dormant', async () => {
    fixtureState.enableClaims();
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    fixtureState.coordinator.runId = 'second-native-occurrence';
    const selected = await fixtureState.next();
    delete fixtureState.service.dependencies.claims;
    const held = await fixtureState.prepare(selected);
    assert.ok('code' in held && held.code === 'claim-disabled-pending');
    assert.equal(fixtureState.preparedWorktrees, 0);
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should reconcile existing native creation without accepting the pilot claim while dormant', async () => {
    const comments = fixtureState.enableClaims();
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    fixtureState.coordinator.runId = 'second-native-occurrence';
    const selected = await fixtureState.next();
    fixtureState.lost = true;
    assert.equal((await fixtureState.prepare(selected)).status, 'waiting');
    const store = fixtureState.service.dependencies.claimStore!;
    const before = await store.file.read();
    delete fixtureState.service.dependencies.claims;
    const recovered = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'reconcile',
        id: selected.id,
      },
    );
    assert.equal(recovered.status, 'session-created');
    assert.equal(fixtureState.creates().length, 1);
    assert.equal((await fixtureState.record()).claimAccepted, undefined);
    assert.equal(await store.file.read(), before);
    assert.doesNotMatch(comments[0]!.body, /Assignment accepted/u);
  });

  it('should wait for another native occurrence before creating and accepting one session', async () => {
    const comments = fixtureState.enableClaims();
    const first = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal(first.status, 'claim-waiting');
    assert.equal(comments.length, 1);
    assert.equal(fixtureState.preparedWorktrees, 0);
    assert.equal(fixtureState.creates().length, 0);
    fixtureState.coordinator.toolCallId = 'another-tool-call';
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        )
      ).status,
      'pass-completed',
    );
    assert.equal(fixtureState.creates().length, 0);
    fixtureState.coordinator.runId = 'second-native-occurrence';
    const routed = await fixtureState.next();
    assert.equal((await fixtureState.prepare(routed)).status, 'session-created');
    assert.equal(fixtureState.preparedWorktrees, 1);
    assert.equal(fixtureState.creates().length, 1);
    assert.equal((await fixtureState.record()).claimAccepted, true);
    assert.match(comments[0]!.body, /^Assignment accepted on /u);
    fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    fixtureState.coordinator.runId = 'third-native-occurrence';
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        )
      ).status,
      'assessment-required',
    );
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should stop before native preparation when the selected claim disappears', async () => {
    const comments = fixtureState.enableClaims();
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    fixtureState.coordinator.runId = 'second-native-occurrence';
    const routed = await fixtureState.next();
    comments.length = 0;
    const result = await fixtureState.prepare(routed);
    assert.ok('code' in result && result.code === 'claim-winner-missing');
    assert.equal(fixtureState.preparedWorktrees, 0);
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should leave native preparation to another installation with the winning claim', async () => {
    const comments = fixtureState.enableClaims();
    comments.push({
      databaseId: 1,
      nodeId: 'other-claim',
      author: { ...fixtureState.fixture.client.identity, type: 'User' },
      body: claimBody(
        {
          instanceId: '11111111-1111-4111-8111-111111111111',
          assignmentEventId: fixtureState.fixture.events[0]!.nodeId,
        },
        'other-machine',
      ),
      bodyTruncated: false,
      createdAt: new Date(baseline).toISOString(),
      updatedAt: new Date(baseline).toISOString(),
    });
    for (const runId of ['first-native-occurrence', 'second-native-occurrence']) {
      const result = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId },
        { action: 'next' },
      );
      assert.equal(result.status, 'claim-waiting');
    }
    assert.equal(comments.length, 1);
    assert.equal(fixtureState.preparedWorktrees, 0);
    assert.equal(fixtureState.creates().length, 0);
  });

  for (const target of ['local', '11111111-1111-4111-8111-111111111111'])
    it(`should reconcile uncertain native creation after a ${target === 'local' ? 'local' : 'targeted'} route edit`, async () => {
      const comments = fixtureState.enableClaims();
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      fixtureState.coordinator.runId = 'second-native-occurrence';
      const routed = await fixtureState.next();
      fixtureState.lost = true;
      assert.equal((await fixtureState.prepare(routed)).status, 'waiting');
      assert.match(comments[0]!.body, /^Assignment claim registered on /u);
      fixtureState.manifest.github!.notifications!.routing = [{ 'owner/*': target }];
      fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
      assert.equal(
        (
          await fixtureState.service.run(
            fixtureState.manifest,
            fixtureState.root,
            fixtureState.coordinator,
            { action: 'reconcile', id: routed.id },
          )
        ).status,
        'session-created',
      );
      assert.equal(fixtureState.creates().length, 1);
      assert.equal(fixtureState.preparedWorktrees, 1);
      assert.match(comments[0]!.body, /^Assignment accepted on /u);
    });

  it('should use an available slot for the next assignment after an item validation failure', async () => {
    const { items } = await fixtureState.assignments(2, 1);
    items[0]!.assignees = [];
    const failed = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'next' },
    );
    assert.equal(failed.status, 'blocked');
    assert.ok('nextAction' in failed && failed.nextAction === 'next');
    const second = await fixtureState.next();
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    const selected = (await current.journal.read()).records.find(
      (record) => record.id === second.id,
    )!;
    assert.equal(
      current.admitted.records.find((intake) => intake.id === selected.intakeId)!.issue.number,
      4,
    );
    assert.equal((await fixtureState.prepare(second)).status, 'session-created');
    assert.equal(fixtureState.creates().length, 1);
  });

  for (const [limit, occupied, expected] of [
    [2, 1, 1],
    [1, 1, 0],
  ] as const) {
    it(`should fill ${expected} initially free slots with limit ${limit} and ${occupied} occupied`, async () => {
      await fixtureState.assignments(limit + 1, limit);
      for (let index = 0; index < occupied; index++) {
        const input = await fixtureState.next();
        await fixtureState.prepare(input);
        await fixtureState.assess(input.id);
      }
      const who = { ...fixtureState.coordinator, runId: 'scheduled-pass' };
      for (let index = 0; index < occupied; index++) {
        const recovery = await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          who,
          { action: 'next' },
        );
        assert.equal(recovery.status, 'reconcile-required');
        assert.ok('id' in recovery);
        assert.equal(
          (
            await fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, {
              action: 'reconcile',
              id: recovery.id as string,
            })
          ).status,
          'assessment-pending',
        );
      }
      const ids = [];
      for (let index = 0; index < expected; index++) {
        const input = await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          who,
          { action: 'next' },
        );
        assert.ok(
          'digest' in input &&
            'id' in input &&
            typeof input.digest === 'string' &&
            typeof input.id === 'string',
        );
        ids.push(input.id);
        assert.equal(
          (
            await fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, {
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
          (
            await fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, {
              action: 'assess',
              id: input.id,
            })
          ).status,
          'assessment-pending',
        );
      }
      const state = await (
        await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
      ).journal.read();
      assert.equal(state.records.filter((record) => record.request).length, occupied + expected);
      assert.equal(fixtureState.creates().length, occupied + expected);
      assert.equal(fixtureState.sends().length, occupied + expected);
      assert.equal(
        new Set(state.records.map((record) => record.threadId)).size,
        occupied + expected,
      );
      assert.equal(new Set(ids).size, expected);
      const terminal = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        who,
        { action: 'next' },
      );
      assert.equal(terminal.status, occupied + expected ? 'pass-completed' : 'at-capacity');
      assert.equal(
        (
          await fixtureState.service.run(fixtureState.manifest, fixtureState.root, who, {
            action: 'next',
          })
        ).status,
        terminal.status,
      );
    });
  }

  it('should persist exhaustion across reconstruction without replenishing fast completions', async () => {
    // two slots exercise partial-pass recovery; one queued issue proves exhaustion.
    await fixtureState.assignments(3, 2);
    for (let index = 0; index < 2; index++) {
      const input = await fixtureState.next();
      assert.equal((await fixtureState.prepare(input)).status, 'session-created');
      await fixtureState.assess(input.id);
      await fixtureState.completeAssessment(input.id);
      fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    }
    for (let index = 0; index < 2; index++)
      assert.equal(
        (
          await fixtureState.service.run(
            fixtureState.manifest,
            fixtureState.root,
            fixtureState.coordinator,
            { action: 'next' },
          )
        ).status,
        'pass-completed',
      );
    assert.equal(fixtureState.creates().length, 2);
    const state = await (
      await fixtureState.service.scope(fixtureState.manifest, fixtureState.root)
    ).journal.read();
    assert.deepEqual(
      fixtureState.creates().map(({ params }) => params.displayName),
      ['#3: REPAIR THE RESULT', '#4: REPAIR THE RESULT'],
    );
    const later = { ...fixtureState.coordinator, runId: 'later-pass' };
    const input = await fixtureState.service.run(fixtureState.manifest, fixtureState.root, later, {
      action: 'next',
    });
    assert.equal(input.status, 'routing-required');
    assert.equal(state.openclawPasses![0]!.selected.length, 2);
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        )
      ).status,
      'pass-completed',
    );
  });

  it('should not absorb assignments admitted after the native pass snapshot', async () => {
    await fixtureState.assignments(2, 3);
    const first = await fixtureState.next();
    await fixtureState.prepare(first);
    await fixtureState.assess(first.id);
    await fixtureState.assignments(4, 3);
    const second = await fixtureState.next();
    await fixtureState.prepare(second);
    await fixtureState.assess(second.id);
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        )
      ).status,
      'pass-completed',
    );
    assert.equal(fixtureState.creates().length, 2);
    const later = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      { ...fixtureState.coordinator, runId: 'new-admissions' },
      { action: 'next' },
    );
    assert.equal(later.status, 'reconcile-required');
  });

  it('should recheck authoritative capacity when another reservation arrives before preparation', async () => {
    await fixtureState.assignments(4, 2);
    const first = await fixtureState.next();
    await fixtureState.prepare(first);
    await fixtureState.assess(first.id);
    const second = await fixtureState.next();
    const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
    await current.journal.exclusive(async (state, save) => {
      const reservation = structuredClone(state.records[0]!);
      const admission = current.admitted.records.find(
        (entry) => !state.records.some((record) => record.intakeId === entry.id),
      )!;
      reservation.id = 'f'.repeat(64);
      reservation.worktreeAttemptId = reservation.id;
      reservation.intakeId = admission.id;
      reservation.issueKey = issueKey(admission);
      reservation.threadId = `agent:receiver:dashboard:agent-system-issue-${reservation.id}`;
      assert.ok(reservation.request && 'key' in reservation.request);
      reservation.request.key = reservation.threadId;
      reservation.request.idempotencyKey = reservation.id;
      reservation.nativeTurns = reservation.nativeTurns?.filter(
        ({ role }) => role !== 'assessment',
      );
      delete reservation.assessment;

      state.records.push(reservation);
      await save();
    });
    assert.equal((await fixtureState.prepare(second)).status, 'at-capacity');
    assert.equal(fixtureState.creates().length, 1);
    assert.equal(fixtureState.preparedWorktrees, 1);
  });

  it('should reserve uncertain creations across restart and refuse new work at full capacity', async () => {
    await fixtureState.assignments(4, 1);
    const input = await fixtureState.next();
    fixtureState.lost = true;
    fixtureState.absent = true;
    await fixtureState.prepare(input);
    fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          { ...fixtureState.coordinator, runId: 'later' },
          { action: 'next' },
        )
      ).status,
      'at-capacity',
    );
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should require this native run selection before preparing', async () => {
    await fixtureState.assignments(4, 1);
    const input = await fixtureState.next();
    const foreign = { ...fixtureState.coordinator, runId: 'unselected' };
    const unauthorized = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      foreign,
      {
        action: 'prepare',
        id: input.id,
        digest: input.digest,
        title: 'repair the result',
        assessment: { complexity: 'medium', reason: 'Bounded fixture.' },
      },
    );
    assert.ok('code' in unauthorized && unauthorized.code === 'dispatch-pass-selection-required');
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should create a fresh issue session without reserving its archived predecessors label', async () => {
    const archived = { label: '#3: REPAIR THE RESULT', archived: true };
    fixtureState.sessions.set('retired-issue', archived);
    fixtureState.onCreate = () => {
      const params = fixtureState.creates().at(-1)!.params;
      if (
        params.label &&
        [...fixtureState.sessions.values()].some((entry) => entry.label === params.label)
      )
        throw new GatewayClientRequestError({
          code: 'INVALID_REQUEST',
          message: 'label already in use',
        });
    };
    const input = await fixtureState.next();
    assert.equal((await fixtureState.prepare(input)).status, 'session-created');
    assert.equal(fixtureState.creates()[0]!.params.displayName, '#3: REPAIR THE RESULT');
    assert.equal(fixtureState.creates()[0]!.params.label, undefined);
    assert.deepEqual(fixtureState.sessions.get('retired-issue'), archived);
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'reconcile', id: input.id },
    );
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should create one ordinary issue session with routed settings and no initial turn', async () => {
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      true,
    );
    const input = await fixtureState.next();
    const created = await fixtureState.prepare(input);
    assert.equal(created.status, 'session-created');
    const request = fixtureState.creates()[0]!.params;
    assert.equal(request.model, 'openai/gpt-6.1-sol');
    assert.equal(request.thinkingLevel, 'high');
    assert.equal(request.category, 'REPO');
    assert.equal(request.displayName, '#3: REPAIR THE RESULT');
    assert.equal(request.label, undefined);
    assert.equal(request.agentId, 'receiver');
    assert.equal(request.cwd, join(fixtureState.root, 'worktree'));
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

    assert.equal(
      (await fixtureState.record()).sessionCreation?.sourceSessionId,
      fixtureState.coordinator.sessionId,
    );
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      true,
    );
    assert.equal((await fixtureState.prepare(input)).status, 'reconcile-required');
    const again = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'reconcile',
        id: input.id,
      },
    );
    assert.ok('effect' in again && again.effect === 'reconciled');
    assert.equal(fixtureState.creates().length, 1);
    assert.equal(fixtureState.preparedWorktrees, 1);
  });

  it('should uppercase the issue session display title while preserving punctuation and unicode', async () => {
    const input = await fixtureState.next();
    const title = "Fix user's issue: café 東京 Straße 2026.10.6";
    const created = await fixtureState.prepare(input, {}, title);
    assert.equal(created.status, 'session-created');
    assert.equal(
      fixtureState.creates()[0]!.params.displayName,
      "#3: FIX USER'S ISSUE: CAFÉ 東京 STRASSE 2026.10.6",
    );
  });

  for (const [kind, title, expected] of [
    ['colon prefixes', 'REPO #3: #3: Fix café: references to #4', '#3: FIX CAFÉ: REFERENCES TO #4'],
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
    it(`should preserve worktree input when creating a chat title with ${kind}`, async () => {
      const prepareWorktree = fixtureState.service.dependencies.worktrees.prepareGitHub;
      fixtureState.service.dependencies.worktrees.prepareGitHub = async (input) => {
        assert.equal(input.title, title);
        return prepareWorktree(input);
      };
      const created = await fixtureState.prepare(await fixtureState.next(), {}, title);
      assert.equal(created.status, 'session-created');
      assert.equal(fixtureState.creates()[0]!.params.displayName, expected);
    });

  it('should reuse one connection and keep gateway reads free of repeated provider authorization', async () => {
    const input = await fixtureState.next();
    const connect = fixtureState.service.dependencies.connect;
    let connections = 0,
      repositories = 0;
    fixtureState.service.dependencies.connect = async (...args) => {
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
    assert.equal((await fixtureState.prepare(input)).status, 'session-created');
    assert.equal(connections, 1);
    // Action admission and the actual create boundary, regardless of native guard count.
    assert.equal(repositories, 2);
    repositories = connections = 0;
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'reconcile', id: input.id },
    );
    assert.equal(connections, 1);
    assert.equal(repositories, 1);
  });

  it('should catch assignment revocation during preparation before creating a session', async () => {
    const input = await fixtureState.next();
    const prepareWorktree = fixtureState.service.dependencies.worktrees.prepareGitHub;
    fixtureState.service.dependencies.worktrees.prepareGitHub = async (...args) => {
      const result = await prepareWorktree(...args);
      fixtureState.fixture.item.assignees = [];
      return result;
    };
    const result = await fixtureState.prepare(input);
    assert.equal(result.status, 'blocked');
    assert.ok('code' in result && result.code === 'dispatch-assignment-removed');
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should reject unbound callers before any worktree or credential operation', async () => {
    for (const operator of [false, true])
      await assert.rejects(
        fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.child,
          { action: 'next' },
          operator,
        ),
        /dispatch-intake-caller-required/,
      );
    assert.equal(fixtureState.preparedWorktrees, 0);
    assert.equal(fixtureState.calls.length, 0);
  });

  it('should not prepare a revoked assignment or wake repeatedly on its blocker', async () => {
    removeFixtureAssignment(fixtureState.fixture);
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'next' },
        )
      ).status,
      'blocked',
    );
    await fixtureState.acknowledgeReport();
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      true,
    );
    await fixtureState.acknowledgeReport();
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      false,
    );
    assert.equal(fixtureState.preparedWorktrees, 0);
    assert.equal(fixtureState.calls.length, 0);
  });

  it('should recover a rejected history read only in the owning coordinator with the same receipt', async () => {
    const input = await fixtureState.next();
    fixtureState.historyRejected = true;
    const blocked = await fixtureState.prepare(input);
    assert.ok('code' in blocked && blocked.code === 'session-dispatch-history-request-invalid');
    await fixtureState.acknowledgeReport();
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      false,
    );
    await assert.rejects(
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.child,
        { action: 'reconcile', id: input.id },
        true,
      ),
      /dispatch-intake-caller-required/,
    );
    fixtureState.historyRejected = false;
    for (let replay = 0; replay < 2; replay++) {
      const recovered = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        {
          action: 'reconcile',
          id: input.id,
        },
      );
      assert.ok('sessionId' in recovered && recovered.sessionId === 'ordinary-id');
    }

    assert.equal((await fixtureState.record()).blocker, undefined);
    assert.equal(fixtureState.creates().length, 1);
    assert.ok(
      fixtureState.calls.every(({ method }) =>
        ['sessions.create', 'sessions.describe', 'chat.history'].includes(method),
      ),
    );
  });

  it('should retain an uncertain absent session without repeating creation or clearing its slot', async () => {
    const input = await fixtureState.next();
    fixtureState.lost = true;
    fixtureState.absent = true;
    await fixtureState.prepare(input);
    const reconciled = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'reconcile',
        id: input.id,
      },
    );
    assert.ok('code' in reconciled && reconciled.code === 'dispatch-session-reconcile-required');
    assert.equal(fixtureState.creates().length, 1);
    await assert.rejects(
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'retry', id: input.id },
        true,
      ),
      /dispatch-native-recovery-required/,
    );
    await fixtureState.acknowledgeReport();
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      false,
    );
  });

  for (const missing of [false, true])
    it(`should reconcile a superseded ${missing ? 'unknown' : 'created'} session without creating again`, async () => {
      const input = await fixtureState.next();
      fixtureState.lost = true;
      fixtureState.absent = missing;
      await fixtureState.prepare(input);
      const current = await fixtureState.service.scope(fixtureState.manifest, fixtureState.root);
      const event = {
        ...fixtureState.fixture.events[0]!,
        nodeId: 'E_successor',
        databaseId: fixtureState.fixture.events[0]!.databaseId + 1,
        createdAt: new Date(baseline + 90000).toISOString(),
      };
      fixtureState.fixture.events.push(event);
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
      fixtureState.coordinator.runId = 'successor-intake';
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        { action: 'next' },
      );
      const retained = await fixtureState.record();
      assert.equal(retained.sessionCreation?.verified, missing ? undefined : true);
      assert.equal(
        retained.blocker,
        missing ? 'dispatch-session-reconcile-required' : 'dispatch-assignment-superseded',
      );
      assert.equal(fixtureState.creates().length, 1);
      assert.equal(retained.intakeId, current.admitted.records[0]!.id);
    });

  it('should reject a session replaced between description and current history readback', async () => {
    const input = await fixtureState.next();
    fixtureState.historySessionId = 'replacement-id';
    const result = await fixtureState.prepare(input);
    assert.ok('code' in result && result.code === 'dispatch-session-not-empty-idle');
    assert.equal((await fixtureState.record()).sessionCreation?.verified, undefined);
    assert.equal((await fixtureState.record()).sessionCreation?.sessionId, 'ordinary-id');
    fixtureState.historySessionId = undefined;
    const recovered = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'reconcile',
        id: input.id,
      },
    );
    assert.equal(recovered.status, 'session-created');
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should keep credentials unavailable as a blocker without reporting session success', async () => {
    fixtureState.service.dependencies.credential = {
      async use() {
        throw new Error('session-dispatch-not-enrolled');
      },
    };
    const input = await fixtureState.next();
    const result = await fixtureState.prepare(input);
    assert.ok('code' in result && result.code === 'session-dispatch-not-enrolled');
    assert.equal((await fixtureState.record()).sessionCreation?.attempted, false);
    assert.equal((await fixtureState.record()).threadId, undefined);
    assert.equal(fixtureState.calls.length, 0);
  });

  it('should fail before creation when assignment or caller authority changes during preparation', async () => {
    const input = await fixtureState.next();
    const result = await fixtureState.prepare(input, {
      assertCurrent: async () => {
        fixtureState.fixture.item.assignees = [];
      },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(fixtureState.calls.length, 0);
  });

  it('should preserve cancellation while allowing a coordinator to inspect pending creation', async () => {
    const input = await fixtureState.next();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const first = fixtureState.prepare(input, {
      signal: controller.signal,
      assertCurrent: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    try {
      assert.deepEqual(
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          { ...fixtureState.coordinator, runId: 'overlapping-run' },
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
    assert.equal(fixtureState.creates().length, 0);
  });

  it('should retain an attempted receipt when cancellation occurs after creation', async () => {
    const input = await fixtureState.next();
    const controller = new AbortController();
    fixtureState.onCreate = () => controller.abort();
    assert.equal(
      (await fixtureState.prepare(input, { signal: controller.signal })).status,
      'blocked',
    );
    assert.equal(fixtureState.creates().length, 1);
    assert.equal((await fixtureState.record()).sessionCreation?.attempted, true);
  });

  it('should reject changed session identity settings and unexpected activity', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    const original = { ...fixtureState.session! };
    for (const [change, field] of [
      [{ key: 'agent:receiver:other' }, 'key'],
      [{ sessionId: 'replacement' }, 'sessionId'],
      [{ agentId: 'other' }, 'agentId'],
      [{ spawnedCwd: '/' }, 'cwd'],
      [{ parentSessionKey: 'agent:other:main' }, 'parentSessionKey'],
      [{ parentSessionKey: 'agent:receiver:unrelated' }, 'parentSessionKey'],
      [{ spawnedBy: 'agent:receiver:main' }, 'spawnedBy'],
      [{ spawnDepth: 1 }, 'spawnDepth'],
      [{ archived: true }, 'archived'],
    ] as const) {
      fixtureState.session = { ...original, ...change };
      const result = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        {
          action: 'reconcile',
          id: input.id,
        },
      );
      assert.ok('code' in result && result.code === 'dispatch-session-mismatch');
      assert.ok('mismatchedField' in result && result.mismatchedField === field);
      assert.doesNotMatch(
        JSON.stringify(result),
        /replacement|other\/model|agent:other:main|agent:receiver:unrelated/u,
      );
    }
    fixtureState.session = original;
    fixtureState.active = true;
    const result = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'reconcile',
        id: input.id,
      },
    );
    assert.ok('code' in result && result.code === 'dispatch-session-not-empty-idle');
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should continue the same issue after cosmetic session edits', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    fixtureState.session = {
      ...fixtureState.session!,
      label: 'Renamed by the operator',
      category: 'Other group',
    };
    const result = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'reconcile',
        id: input.id,
      },
    );
    assert.notEqual('code' in result ? result.code : undefined, 'dispatch-session-mismatch');
    assert.equal(fixtureState.creates().length, 1);
  });

  for (const [change, field] of [
    [{ model: 'other/model' }, 'model'],
    [{ thinkingLevel: 'low' }, 'thinkingLevel'],
  ] as const)
    it(`should still verify requested ${field.toLowerCase()} during uncertain creation recovery`, async () => {
      const input = await fixtureState.next();
      fixtureState.lost = true;
      await fixtureState.prepare(input);
      const original = { ...fixtureState.session! };
      assert.equal((await fixtureState.record()).sessionCreation?.verified, undefined);
      Object.assign(fixtureState.session!, change);
      fixtureState.lost = false;
      const result = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        {
          action: 'reconcile',
          id: input.id,
        },
      );
      assert.ok('code' in result && result.code === 'dispatch-session-mismatch');
      assert.ok('mismatchedField' in result && result.mismatchedField === field);
      assert.equal((await fixtureState.record()).sessionCreation?.verified, undefined);
      fixtureState.session = original;
      assert.equal(
        (
          await fixtureState.service.run(
            fixtureState.manifest,
            fixtureState.root,
            fixtureState.coordinator,
            { action: 'reconcile', id: input.id },
          )
        ).status,
        'session-created',
      );
      assert.equal(fixtureState.creates().length, 1);
    });

  it('should accept an unlinked session and only the configured same-agent main parent', async () => {
    const input = await fixtureState.next();
    assert.equal((await fixtureState.prepare(input)).status, 'session-created');
    assert.equal(fixtureState.session!.parentSessionKey, 'agent:receiver:main');
    fixtureState.config = { session: { mainKey: 'inbox' } };
    fixtureState.session!.parentSessionKey = 'agent:receiver:inbox';
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'reconcile', id: input.id },
        )
      ).status,
      'session-created',
    );
    for (const settings of [
      { mainKey: 'other' },
      { mainKey: 'inbox', dmScope: 'per-channel-peer' },
      { mainKey: 'inbox', scope: 'global' },
    ] as const) {
      fixtureState.config = { session: settings };
      const blocked = await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.coordinator,
        {
          action: 'reconcile',
          id: input.id,
        },
      );
      assert.ok('code' in blocked && blocked.code === 'dispatch-session-mismatch');
      assert.ok('mismatchedField' in blocked && blocked.mismatchedField === 'parentSessionKey');
    }
    delete fixtureState.session!.parentSessionKey;
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'reconcile', id: input.id },
        )
      ).status,
      'session-created',
    );
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should recover a retained parent mismatch without creating a replacement session', async () => {
    const input = await fixtureState.next();
    fixtureState.config = { session: { mainKey: 'other' } };
    const blocked = await fixtureState.prepare(input);
    assert.ok('mismatchedField' in blocked && blocked.mismatchedField === 'parentSessionKey');
    const previous = await fixtureState.record();
    fixtureState.config = {};
    fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    const recovered = await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      {
        action: 'reconcile',
        id: input.id,
      },
    );
    assert.equal(recovered.status, 'session-created');
    assert.ok('effect' in recovered && recovered.effect === 'reconciled');
    assert.equal(
      (await fixtureState.record()).sessionCreation?.sessionId,
      previous.sessionCreation?.sessionId,
    );
    assert.deepEqual((await fixtureState.record()).request, previous.request);
    assert.equal(fixtureState.creates().length, 1);
    assert.equal(fixtureState.preparedWorktrees, 1);
  });

  it('should keep classified preparation failures value-free and explicitly retryable', async () => {
    fixtureState.service.dependencies.worktrees.prepareGitHub = async () => {
      throw Object.assign(new AgentSystemToolError('execution_failed', 'SECRET'), {
        cause: new GitCommandError('fetch', {
          exitCode: 128,
          stderr: 'Could not resolve host: private-host token=SECRET',
        }),
      });
    };
    const input = await fixtureState.next();
    const failure = await fixtureState.prepare(input);
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
    assert.equal(JSON.stringify(await fixtureState.record()).includes('SECRET'), false);
    await fixtureState.acknowledgeReport();
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      false,
    );
    await fixtureState.service.run(
      fixtureState.manifest,
      fixtureState.root,
      fixtureState.coordinator,
      { action: 'retry', id: input.id },
      true,
    );
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      true,
    );
  });

  it('should select the created session at capacity and persist exactly one assessment turn', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    assert.deepEqual(
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'recovery-created' },
        { action: 'next' },
      ),
      {
        status: 'assessment-required',
        id: input.id,
      },
    );
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-pending');
    const sent = fixtureState.sends()[0]!.params;
    assert.equal(sent.sessionId, 'ordinary-id');
    assert.equal(sent.deliver, false);
    assert.equal(sent.expectedLeafEntryId, null);
    assert.equal(sent.thinking, undefined);
    assert.ok(String(sent.message).includes('https://github.com/owner/repo/issues/3'));
    assert.doesNotMatch(String(sent.message), /Return the missing result/);
    assert.deepEqual(
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'recovery-pending' },
        { action: 'next' },
      ),
      {
        status: 'reconcile-required',
        id: input.id,
      },
    );
    await fixtureState.sendAssessment(input.id);
    const completed = await fixtureState.finish(input.id);
    assert.equal(completed.status, 'assessment-completed');
    assert.ok('executionEffort' in completed && completed.executionEffort === 'unverified');
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-completed');
    assert.equal(fixtureState.sends().length, 1);
    assert.equal(fixtureState.creates().length, 1);
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.replyEventId,
      'reply-event',
    );

    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      true,
    );
  });

  it('should recover truncated completion in the retained workflow without another effect', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    const original = await fixtureState.record();
    const complete = {
      role: 'assistant',
      stopReason: 'stop',
      __openclaw: { id: 'long-reply', runId: `${input.id}:assessment`, runTerminal: true },
      content: [{ type: 'text', text: 'complete result '.repeat(10000) }],
    };
    fixtureState.messages.push({
      ...complete,
      __openclaw: { ...complete.__openclaw, truncated: true },
    });
    fixtureState.active = false;
    fixtureState.inputReceipts = [];
    let available = false;
    const credential = fixtureState.service.dependencies.credential;
    fixtureState.service = new OpenClawDispatch({
      ...fixtureState.service.dependencies,
      credential: {
        use: (authority, operation) =>
          credential.use(authority, (request) =>
            operation(async (method, params) => {
              if (method !== 'chat.message.get') return request(method, params);
              assert.equal(params.messageId, 'long-reply');
              return available
                ? { ok: true, message: complete }
                : { ok: false, unavailableReason: 'oversized' };
            }),
          ),
      },
    });
    const pending = await fixtureState.sendAssessment(input.id);
    assert.equal('code' in pending && pending.code, 'workflow-evidence-truncated');
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'consumed',
    );
    available = true;
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-completed');
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-completed');
    const recovered = await fixtureState.record();
    assert.equal(recovered.threadId, original.threadId);
    assert.equal(recovered.worktree, original.worktree);
    assert.deepEqual(recovered.request, original.request);
    assert.deepEqual(recovered.routing, original.routing);
    assert.equal(
      recovered.nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn?.runId,
      original.nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn?.runId,
    );
    assert.equal(
      recovered.nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn?.replyEventId,
      'long-reply',
    );
    assert.equal(fixtureState.creates().length, 1);
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should recover exact accepted input after a lost send response and restart without sending again', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    fixtureState.loseSend = true;
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'waiting');
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'attempted',
    );
    assert.equal(JSON.stringify(await fixtureState.record()).includes('SECRET'), false);
    fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-pending');
    assert.equal((await fixtureState.finish(input.id)).status, 'assessment-completed');
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should verify an ordinary input consumed before the first history read', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    fixtureState.consumeSend = true;
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-pending');
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'consumed',
    );
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.consumedByEventId,
      'input-event',
    );
    assert.equal((await fixtureState.finish(input.id)).status, 'assessment-completed');
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should recover the saved accepted delivery blocker on the next coordinator run without resending', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    const journal = (await fixtureState.service.scope(fixtureState.manifest, fixtureState.root))
      .journal;
    await journal.exclusive(async (state, save) => {
      const saved = state.records[0]!;

      saved.failureStage = 'assessment-turn';
      saved.blocker = 'dispatch-turn-delivery-unverified';
      await save();
    });
    fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      true,
    );
    assert.deepEqual(
      await fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        { ...fixtureState.coordinator, runId: 'recovery-pending' },
        { action: 'next' },
      ),
      {
        status: 'reconcile-required',
        id: input.id,
      },
    );
    assert.equal((await fixtureState.finish(input.id)).status, 'assessment-completed');
    assert.equal((await fixtureState.record()).blocker, undefined);
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.replyEventId,
      'reply-event',
    );
    fixtureState.service = new OpenClawDispatch(fixtureState.service.dependencies);
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          fixtureState.coordinator,
          { action: 'reconcile', id: input.id },
        )
      ).status,
      'assessment-completed',
    );
    assert.equal(
      (await fixtureState.service.check(fixtureState.manifest, fixtureState.root)).changed,
      true,
    );
    assert.equal(fixtureState.sends().length, 1);
    assert.equal(fixtureState.creates().length, 1);
  });

  it('should preserve collected input receipts when their transcript input is outside the page', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    fixtureState.messages = [];
    fixtureState.inputReceipts = [
      { runId: `${input.id}:assessment`, state: 'consumed', consumedByEventId: 'collected-input' },
    ];
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-pending');
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.consumedByEventId,
      'collected-input',
    );
    assert.equal(fixtureState.sends().length, 1);
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
      const input = await fixtureState.next();
      await fixtureState.prepare(input);
      await fixtureState.sendAssessment(input.id);
      fixtureState.inputReceipts = [];
      const user = fixtureState.messages[0]!;
      const meta = user.__openclaw as Record<string, unknown>;
      if (mismatch === 'run') meta.runId = 'unrelated';
      if (mismatch === 'key') meta.idempotencyKey = 'unrelated:user';
      if (mismatch === 'message') user.content = 'different input';
      if (mismatch === 'truncated') meta.truncated = true;
      if (mismatch === 'missing') fixtureState.messages = [];
      if (mismatch === 'duplicate') fixtureState.messages.push(structuredClone(user));
      if (mismatch === 'incarnation') fixtureState.historySessionId = 'replacement';
      assert.equal((await fixtureState.sendAssessment(input.id)).status, 'waiting');
      assert.equal(
        (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')
          ?.turn?.status,
        'accepted',
      );
      assert.equal(fixtureState.sends().length, 1);
    });
  }

  it('should accept exact text-block input without inventing missing receipt evidence', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    fixtureState.messages[0]!.content = [{ type: 'text', text: fixtureState.messages[0]!.content }];
    assert.equal((await fixtureState.finish(input.id)).status, 'assessment-completed');
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.consumedByEventId,
      'input-event',
    );
  });

  it('should reject a changed consumption identity across reconciliation', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    fixtureState.consumeSend = true;
    await fixtureState.sendAssessment(input.id);
    (fixtureState.messages[0]!.__openclaw as Record<string, unknown>).id = 'replacement-input';
    const result = await fixtureState.sendAssessment(input.id);
    assert.ok('code' in result && result.code === 'dispatch-turn-input-mismatch');
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should not treat mirrored commentary as a terminal answer even when the run is idle', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    fixtureState.inputReceipts = [];
    fixtureState.active = false;
    fixtureState.messages.push({
      role: 'assistant',
      stopReason: 'stop',
      __openclaw: {
        id: 'commentary',
        runId: `${input.id}:assessment`,
        mirrorOrigin: 'codex-app-server',
      },
      content: [{ type: 'text', text: 'I will investigate.' }],
    });
    const result = await fixtureState.sendAssessment(input.id);
    assert.ok('code' in result && result.code === 'dispatch-turn-outcome-unverified');
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.replyEventId,
      undefined,
    );
    await fixtureState.acknowledgeReport();
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should preserve explicit cancellation after its pending receipt disappears', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    fixtureState.inputReceipts[0]!.cancelled = true;
    const cancelled = await fixtureState.sendAssessment(input.id);
    assert.ok('code' in cancelled && cancelled.code === 'dispatch-turn-cancelled');
    assert.equal(openClawCapacity([await fixtureState.record()], 1).occupied, 1);
    await fixtureState.acknowledgeReport();
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.equal(fixtureState.sends().length, 1);
    fixtureState.waitResult = { status: 'error' };
    fixtureState.active = false;
    fixtureState.inputReceipts = [];
    const failed = await fixtureState.finish(input.id);
    assert.ok('code' in failed && failed.code === 'dispatch-turn-cancelled');
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.equal(openClawCapacity([await fixtureState.record()], 1).occupied, 0);
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.replyEventId,
      undefined,
    );
    await fixtureState.acknowledgeReport();
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.equal(fixtureState.sends().length, 1);
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should keep an unknown send blocked without resending or releasing its session slot', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    fixtureState.loseSend = true;
    fixtureState.acceptSend = false;
    await fixtureState.sendAssessment(input.id);
    for (let i = 0; i < 2; i++) {
      const result = await fixtureState.sendAssessment(input.id);
      assert.ok('code' in result && result.code === 'dispatch-turn-delivery-unverified');
    }
    assert.equal(fixtureState.sends().length, 1);
    await fixtureState.acknowledgeReport();
    await fixtureState.service.check(fixtureState.manifest, fixtureState.root);
    assert.equal(fixtureState.sends().length, 1);
    assert.equal(
      (
        await fixtureState.service.run(
          fixtureState.manifest,
          fixtureState.root,
          { ...fixtureState.coordinator, runId: 'capacity-check' },
          { action: 'next' },
        )
      ).status,
      'at-capacity',
    );
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'attempted',
    );
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should reject unrelated messages busy sessions and replaced incarnations before a first send', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    fixtureState.messages = [{ role: 'user', content: 'unrelated' }];
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'waiting');
    fixtureState.messages = [];
    fixtureState.active = true;
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'waiting');
    fixtureState.active = false;
    fixtureState.session!.sessionId = 'replacement';
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'waiting');
    assert.equal(fixtureState.sends().length, 0);
  });

  it('should preserve cancellation after send and reconcile without duplicating it', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    const controller = new AbortController();
    fixtureState.onSend = () => controller.abort();
    assert.equal(
      (await fixtureState.sendAssessment(input.id, { signal: controller.signal })).status,
      'blocked',
    );
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'attempted',
    );
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-pending');
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should revalidate assignment and caller authority before sending or reconciling', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await assert.rejects(
      fixtureState.service.run(
        fixtureState.manifest,
        fixtureState.root,
        fixtureState.child,
        { action: 'assess', id: input.id },
        true,
      ),
      /dispatch-intake-caller-required/,
    );
    assert.equal(
      (
        await fixtureState.sendAssessment(input.id, {
          assertCurrent: async () => {
            throw new Error('authority-revoked');
          },
        })
      ).status,
      'blocked',
    );
    assert.equal(fixtureState.sends().length, 0);
    await fixtureState.sendAssessment(input.id);
    removeFixtureAssignment(fixtureState.fixture);
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'blocked');
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should not confuse unrelated assistant output or tool calls with the working turn reply', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    fixtureState.inputReceipts = [
      { runId: `${input.id}:assessment`, state: 'consumed', consumedByEventId: 'input-event' },
    ];
    fixtureState.active = false;
    fixtureState.messages.push({
      role: 'assistant',
      stopReason: 'stop',
      __openclaw: { id: 'other', runId: 'another-run' },
      content: [{ type: 'text', text: 'unrelated' }],
    });
    const result = await fixtureState.sendAssessment(input.id);
    assert.ok('code' in result && result.code === 'dispatch-turn-outcome-unverified');
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'consumed',
    );
    fixtureState.messages[1]!.__openclaw = { id: 'tool-call', runId: `${input.id}:assessment` };
    fixtureState.messages[1]!.stopReason = 'toolUse';
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'waiting');
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should retain executed model evidence only from the matching native terminal receipt', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    fixtureState.waitResult = {
      status: 'ok',
      terminalReceipt: {
        runId: `${input.id}:assessment`,
        sessionId: 'ordinary-id',
        effective: { provider: 'openai', model: 'gpt-6.1-sol' },
      },
    };
    assert.equal((await fixtureState.finish(input.id)).status, 'assessment-completed');
  });

  it('should reserve only one send when concurrent assessment operations overlap', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = fixtureState.sendAssessment(input.id, {
      assertCurrent: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    try {
      assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-pending');
    } finally {
      release.resolve();
      await first;
    }
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'assessment-pending');
    assert.equal(fixtureState.sends().length, 1);
    assert.equal(
      (await fixtureState.record()).nativeTurns?.filter(({ role }) => role === 'assessment').length,
      1,
    );
  });

  it('should preserve an attempted send when a lock error occurs after entering the journal', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    const result = await fixtureState.sendAssessment(input.id, {
      assertCurrent: async () => {
        if (
          (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')
            ?.turn
        )
          throw Object.assign(new Error('The private state file lock is busy.'), {
            code: privateStateFileLockBusyErrorCode,
          });
      },
    });
    assert.equal(result.status, 'retrying');
    assert.ok('code' in result && result.code === privateStateFileLockBusyErrorCode);
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'attempted',
    );
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'waiting');
    assert.equal(fixtureState.sends().length, 0);
  });

  it('should retain a persisted attempt if authority is revoked before its send reaches the host', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    const result = await fixtureState.sendAssessment(input.id, {
      assertCurrent: async () => {
        if (
          (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')
            ?.turn
        )
          throw new Error('authority-revoked');
      },
    });
    assert.equal(result.status, 'blocked');
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'attempted',
    );
    assert.equal(fixtureState.sends().length, 0);
    assert.equal((await fixtureState.sendAssessment(input.id)).status, 'waiting');
    assert.equal(fixtureState.sends().length, 0);
  });

  it('should reject terminal identity drift and retain a different observed execution model', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    fixtureState.waitResult = {
      status: 'ok',
      terminalReceipt: {
        runId: `${input.id}:assessment`,
        sessionId: 'replacement',
        effective: { provider: 'openai', model: 'gpt-6.1-sol' },
      },
    };
    const mismatch = await fixtureState.finish(input.id);
    assert.ok('code' in mismatch && mismatch.code === 'dispatch-turn-terminal-mismatch');
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'consumed',
    );
    fixtureState.waitResult = {
      status: 'ok',
      terminalReceipt: {
        runId: `${input.id}:assessment`,
        sessionId: 'ordinary-id',
        effective: { provider: 'openai', model: 'other-model' },
      },
    };
    const rerouted = await fixtureState.sendAssessment(input.id);
    assert.equal(rerouted.status, 'assessment-completed');
    assert.equal(fixtureState.sends().length, 1);
  });

  it('should reject incomplete or misbound durable assessment receipts', async () => {
    const input = await fixtureState.next();
    await fixtureState.prepare(input);
    await fixtureState.sendAssessment(input.id);
    const journal = (await fixtureState.service.scope(fixtureState.manifest, fixtureState.root))
      .journal;
    for (const change of [
      { status: 'completed' as const },
      { status: 'consumed' as const },
      { executionModel: 'openai/gpt-6.1-sol' },
      { replyEventId: 'unearned' },
    ]) {
      await assert.rejects(
        journal.exclusive(async (state, save) => {
          Object.assign(
            state.records[0]!.nativeTurns!.findLast(({ role }) => role === 'assessment')!.turn,
            change,
          );
          await save();
        }),
        /dispatch-state-invalid/,
        JSON.stringify(change),
      );
    }
    assert.equal(
      (await fixtureState.record()).nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn
        ?.status,
      'accepted',
    );
  });
});
