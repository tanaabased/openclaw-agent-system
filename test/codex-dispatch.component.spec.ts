import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import properLockfile from 'proper-lockfile';
import connectCodexGitHubAccount from '../agent/codex-github-client.ts';
import { runCodexIntake } from '../agent/codex-intake.ts';
import codexRuntimeRequest from '../agent/codex-runtime-request.ts';
import { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import {
  bindNativeMaterial,
  nativeMaterialResponse,
} from '../agent/tasks/context/native-material.ts';
import AssignmentClaimStore from '../agent/tasks/dispatch/assignment-claim-store.ts';
import CodexAssignmentClaims, {
  codexInstanceStore,
} from '../agent/tasks/dispatch/codex-assignment-claims.ts';
import { codexItemOccupied } from '../agent/tasks/dispatch/codex-capacity.ts';
import type { DispatchNativeThread } from '../agent/tasks/dispatch/codex-dispatch-native.ts';
import CodexDispatchStore, {
  type DispatchRecord,
} from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import OpenClawAssignmentClaims from '../agent/tasks/dispatch/openclaw-assignment-claims.ts';
import { selectWorkflowStage } from '../agent/tasks/workflow-stage.ts';
import workflowStatus from '../agent/tasks/workflow-status.ts';
import { githubNotificationMarkdownCode } from '../channels/github/presentation/card.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import { RepositoryPreparationError } from '../tools/git/repository-service.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import codexDispatchFixture from './codex-dispatch-fixture.ts';
import { baseline, removeFixtureAssignment } from './github-intake-fixture.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

describe('agent/codex dispatch', () => {
  const fixtureState = codexDispatchFixture();
  it('should recover initial managed assessment without requiring a direct user message', async () => {
    await writeFile(join(fixtureState.root, 'SKILL.md'), '# assessment fixture');
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', { id: prepared.id });
    const output = await fixtureState.request(
      'assessment',
      {
        action: 'assessment',
        operation: 'context',
        target: 'https://github.com/owner/repo/issues/3',
        path: fixtureState.worktree,
      },
      {
        threadId: fixtureState.native!.id,
        replyConnection: async () => ({
          close: async () => {},
          request: async (method) => {
            if (method === 'skills/list')
              return {
                data: [
                  {
                    cwd: fixtureState.workspace,
                    errors: [],
                    skills: [
                      {
                        name: 'agent-system:agent-system-task-assessment',
                        path: join(fixtureState.root, 'SKILL.md'),
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
    assert.equal((output.project as { path: string }).path, fixtureState.worktree);
    assert.ok(output.presentationRequest);
  });

  it('should launch explicit collaborator work from the selected pr head without replacing the intake task', async () => {
    const original = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', { id: original.id });
    fixtureState.operatorLaunch();
    fixtureState.selectedPullRequest();
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({
        ...fixtureState.manifest,
        debug: true,
        github: { ...fixtureState.manifest.github, routing: [], 'max-concurrent-items': 1 },
      }),
    );
    const target = 'owner/repo#3';
    await fixtureState.request('launch', {
      operation: 'context',
      target,
      pullRequest: 'https://github.com/owner/repo/pull/7',
    });
    const project = await fixtureState.request('launch', {
      operation: 'prepare',
      target,
      projects: fixtureState.projects,
    });
    assert.equal(project.status, 'routing-required', JSON.stringify(project));
    const prepared = await fixtureState.request('launch', {
      operation: 'prepare',
      target,
      assessment: { complexity: 'medium', reason: 'Collaborate on existing work.' },
      title: 'COLLABORATE',
    });
    assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
    const creation = prepared.request as {
      target: { environment: { startingState: { branchName: string } } };
    };
    assert.equal(creation.target.environment.startingState.branchName, fixtureState.commit);
    const selected = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const records = (
      await new CodexDispatchStore(fixtureState.pluginData, selected.store.location.scope).read()
    ).records;
    assert.equal(records.length, 2);
    assert.equal(records[0]!.supersededBy, undefined);
    assert.equal(records[1]!.adoptedPullRequest?.branch, 'collaborator-work');
    assert.equal(records[1]!.delivery, undefined);
    assert.ok(
      fixtureState.gitCalls.some((argv) =>
        argv.includes('refs/heads/collaborator-work:refs/remotes/origin/collaborator-work'),
      ),
    );
    const originalNative = fixtureState.native!;
    const parallelPath = join(fixtureState.root, 'parallel-worktree');
    await mkdir(parallelPath);
    const parallel = { ...originalNative, id: 'parallel-thread', cwd: parallelPath };
    fixtureState.deps.native!.find = async (input) =>
      input.sourceThreadId === 'intake-thread' ? originalNative : parallel;
    for (let retry = 0; retry < 2; retry++) {
      const recovered = await fixtureState.request('launch', { operation: 'reconcile', target });
      assert.equal(recovered.destination, parallel.id);
    }
    const shown = await fixtureState.renderAssessment(fixtureState.result, {
      threadId: parallel.id,
      connect: async () => {
        assert.fail('adopted base needs no optional lookup');
      },
    });
    assert.match(
      String(shown.presentation),
      new RegExp(`${fixtureState.commit} \\(origin/collaborator-work\\)`),
    );
    assert.match(String(shown.presentation), /PR base.*`release`/);
    const intake = await fixtureState.request(
      'next',
      { projects: fixtureState.projects },
      { threadId: 'intake-thread' },
    );
    assert.ok(!['prepared', 'routing-required'].includes(String(intake.status)));
    assert.equal(
      (await new CodexDispatchStore(fixtureState.pluginData, selected.store.location.scope).read())
        .records.length,
      2,
    );
  });

  it('should preview replacement preserve predecessor evidence and converge on one fenced successor', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', { id: prepared.id });
    await fixtureState.request(
      'context',
      { id: prepared.id },
      { threadId: fixtureState.native!.id },
    );
    await fixtureState.renderAssessment(fixtureState.result, { threadId: fixtureState.native!.id });
    const observed = fixtureState.selectedPullRequest();
    const selected = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(fixtureState.pluginData, selected.store.location.scope);
    const input = { id: prepared.id, pullRequest: 'https://github.com/owner/repo/pull/7' };
    await assert.rejects(
      fixtureState.request('recover', input, { threadId: 'operator' }),
      /chat-active-or-unverified/,
    );
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnStatus = 'completed';
    fixtureState.native!.turnEnded = true;
    const before = await store.read();
    const preview = await fixtureState.request('recover', input, { threadId: 'operator' });
    assert.equal(preview.status, 'recovery-available');
    assert.deepEqual(await store.read(), before);
    observed.head = '2'.repeat(40);
    await assert.rejects(
      fixtureState.request(
        'recover',
        { ...input, digest: preview.digest },
        { threadId: 'operator' },
      ),
      /recovery-stale/,
    );
    assert.deepEqual(await store.read(), before);
    observed.head = fixtureState.commit;
    await store.exclusive(async (state, save) => {
      state.records[0]!.denial = {
        sourceThreadId: 'intake-thread',
        turnId: 'denied-turn',
        callId: 'denied-call',
        operation: 'prepare',
        automatic: true,
        observedAt: fixtureState.now,
      };
      await save();
    });
    const held = await fixtureState.request('recover', input, { threadId: 'operator' });
    assert.equal(held.status, 'blocked');
    assert.ok((held.blockers as string[]).includes('nativeDenial'));
    assert.equal((await store.read()).records.length, 1);
    assert.ok((await store.read()).records[0]!.denial);
    await store.exclusive(async (state, save) => {
      delete state.records[0]!.denial;
      await save();
    });
    await assert.rejects(
      fixtureState.request('recover', input, { threadId: fixtureState.native!.id }),
      /operator-caller-required/,
    );
    await store.exclusive(async (state, save) => {
      state.records.push({
        ...structuredClone(state.records[0]!),
        id: 'b'.repeat(64),
        issueKey: 'c'.repeat(64),
        intakeId: 'c'.repeat(64),
        manualIssue: undefined,
        threadId: 'operator',
      });
      await save();
    });
    const unrelated = (await store.read()).records[1]!;
    const applied = await fixtureState.request(
      'recover',
      { ...input, apply: true },
      { threadId: 'operator' },
    );
    assert.equal(applied.status, 'recovery-ready');
    const after = await store.read();
    assert.equal(after.records.length, 3);
    assert.deepEqual(after.records[1], unrelated);
    const old = after.records[0]!,
      successor = after.records[2]!;
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
    assert.equal(successor.delivery, undefined);
    assert.equal(successor.adoptedPullRequest?.pullRequestNumber, 7);
    assert.equal(codexItemOccupied(old), false);
    assert.equal(
      (await fixtureState.request('recover', input, { threadId: 'operator' })).successorId,
      successor.id,
    );
    assert.equal((await store.read()).records.length, 3);
    await assert.rejects(
      fixtureState.request('context', { id: old.id }, { threadId: fixtureState.native!.id }),
      /task-superseded/,
    );
  });

  it('should inspect a selected saved owner without scanning or modifying state', async () => {
    const prepared = await fixtureState.prepare();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(fixtureState.pluginData, current.store.location.scope);
    const before = await store.read();
    fixtureState.deps.connect = async () => {
      throw new Error('unexpected provider read');
    };
    const result = await fixtureState.request('inspect', { target: 'owner/repo#3', limit: 1 });
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
    assert.deepEqual(
      (await fixtureState.request('inspect', { target: 'other/repo#3' })).records,
      [],
    );
  });

  for (const waiting of [false, true])
    it(`should admit ${waiting ? 'a waiting' : 'a new'} unset assignment with the configured default`, async () => {
      const connect = fixtureState.deps.connect!;
      fixtureState.deps.connect = async (...args) => ({
        ...(await connect(...args)),
        getItemContext: async () => ({
          title: 'investigate and fix this failure',
          body: 'Investigate package-source DNS failures on Ubuntu.',
          comments: [],
          labels: [],
          truncated: false,
        }),
      });
      let selected = await fixtureState.next();
      if (waiting) {
        const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
        const store = new CodexDispatchStore(fixtureState.pluginData, current.store.location.scope);
        await store.exclusive(async (state, save) => {
          state.records[0]!.blocker = 'dispatch-routing-unresolved';
          await save();
        });
        fixtureState.now += 300000;
        const resumed = await fixtureState.next();
        assert.equal(resumed.status, 'routing-required');
        assert.equal(resumed.id, selected.id);
        selected = resumed;
      }
      const prepared = await fixtureState.request('prepare', {
        id: selected.id,
        digest: selected.digest,
        title: 'Fix reported failure',
        assessment: { complexity: 'unset', reason: 'No complexity tier is defensible yet.' },
      });
      assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
      const creation = prepared.request as { model: string; thinking: string };
      assert.equal(creation.model, 'gpt-6-astra');
      assert.equal(creation.thinking, 'high');
      fixtureState.created();
      fixtureState.native!.model = creation.model;
      fixtureState.native!.effort = creation.thinking;
      const reconciled = await fixtureState.request('reconcile', { id: selected.id });
      assert.equal(reconciled.status, 'created', JSON.stringify(reconciled));
      await fixtureState.request('reconcile', { id: selected.id });
      assert.equal((await fixtureState.next()).status, 'idle');
      const records = (await fixtureState.readDispatchState()).records as DispatchRecord[];
      assert.equal(records.length, 1);
      assert.equal(records[0]!.id, selected.id);
      assert.equal(records[0]!.threadId, fixtureState.native!.id);
      assert.equal(records[0]!.blocker, undefined);
    });

  it('should resume the same assignment after correcting an unsupported model provider', async () => {
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({
        ...fixtureState.manifest,
        models: {
          ...fixtureState.models,
          medium: { model: 'anthropic/claude-sonnet-4', effort: 'high' },
        },
      }),
    );
    const selected = await fixtureState.next();
    const failed = await fixtureState.request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Bounded work.' },
    });
    assert.equal(failed.code, 'codex-model-provider-unsupported');
    const before = ((await fixtureState.readDispatchState()).records as DispatchRecord[])[0]!;
    assert.equal(before.request, undefined);
    assert.ok(before.retryAfter);
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify(fixtureState.manifest),
    );
    assert.equal((await fixtureState.next()).status, 'idle');
    fixtureState.now = before.retryAfter;
    const resumed = await fixtureState.next();
    assert.equal(resumed.status, 'routing-required');
    assert.equal(resumed.id, selected.id);
    const prepared = await fixtureState.request('prepare', {
      id: resumed.id,
      digest: resumed.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Bounded work.' },
    });
    assert.equal(prepared.status, 'prepared');
    assert.equal((prepared.request as { model: string }).model, 'gpt-6.1-sol');
    assert.equal(((await fixtureState.readDispatchState()).records as DispatchRecord[]).length, 1);
  });

  it('should resume the same assignment after resolving ambiguous saved projects', async () => {
    const original = fixtureState.projects;
    fixtureState.projects = [
      ...original,
      { ...(original[0] as object), projectId: 'duplicate-project' },
    ];
    const failed = await fixtureState.next();
    assert.equal(failed.code, 'dispatch-project-ambiguous');
    const before = ((await fixtureState.readDispatchState()).records as DispatchRecord[])[0]!;
    assert.equal(before.request, undefined);
    assert.ok(before.retryAfter);
    fixtureState.projects = original;
    fixtureState.now = before.retryAfter;
    const resumed = await fixtureState.next();
    assert.equal(resumed.status, 'routing-required');
    assert.equal(resumed.id, before.id);
    assert.equal(((await fixtureState.readDispatchState()).records as DispatchRecord[]).length, 1);
  });

  for (const failure of ['inventory', 'workspace', 'fetch-lock'] as const) {
    it(`should resume the same assignment after repairing local ${failure} preparation`, async () => {
      const originalGit = fixtureState.deps.git!;
      fixtureState.deps.git = async (cwd, argv, signal) => {
        if (
          (failure === 'inventory' && argv[0] === 'remote') ||
          (failure === 'fetch-lock' && argv[0] === 'fetch')
        )
          throw Object.assign(new Error('dispatch-project-git-unavailable'), {
            providerDiagnostic: providerDiagnostic('git', 'git-command', 'unknown', {
              providerMessage:
                failure === 'inventory'
                  ? 'fatal: bad config line 1 in file .git/config'
                  : "Unable to create 'main.lock': File exists",
            }),
          });
        if (failure === 'workspace' && argv.includes('--is-bare-repository')) return 'true';
        return originalGit(cwd, argv, signal);
      };
      const failed = await fixtureState.next();
      assert.equal(
        failed.code,
        failure === 'inventory'
          ? 'dispatch-project-inventory-unavailable'
          : failure === 'workspace'
            ? 'dispatch-project-workspace-required'
            : 'dispatch-project-git-unavailable',
      );
      const before = ((await fixtureState.readDispatchState()).records as DispatchRecord[])[0]!;
      assert.equal(before.request, undefined);
      assert.ok(before.retryAfter);
      fixtureState.deps.git = originalGit;
      assert.equal((await fixtureState.next()).status, 'idle');
      fixtureState.now = before.retryAfter;
      const resumed = await fixtureState.next();
      assert.equal(resumed.status, 'routing-required');
      assert.equal(resumed.id, before.id);
      const prepared = await fixtureState.request('prepare', {
        id: resumed.id,
        digest: resumed.digest,
        title: 'repair contained behavior',
        assessment: { complexity: 'medium', reason: 'Bounded work.' },
      });
      assert.equal(prepared.status, 'prepared');
      assert.equal(
        ((await fixtureState.readDispatchState()).records as DispatchRecord[]).length,
        1,
      );
    });
  }

  it('should identify missing routing configuration before preparing a native chat', async () => {
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({ ...fixtureState.manifest, models: undefined }),
    );
    const selected = await fixtureState.next();
    const prepared = await fixtureState.request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'Fix reported failure',
      assessment: { complexity: 'unset', reason: 'No complexity tier is defensible yet.' },
    });
    assert.equal(prepared.code, 'model-routing-not-configured');
    assert.equal(prepared.request, undefined);
    assert.equal(fixtureState.native, undefined);
  });

  it('should consume custom initial routing while verified complexity retains its tier', async () => {
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({
        ...fixtureState.manifest,
        models: {
          ...fixtureState.models,
          routing: { skill: 'company:route', guidance: 'Prefer cheap work.' },
        },
      }),
    );
    const selected = await fixtureState.next();
    const routing = selected.routing as {
      instructions: { requestedSkill: string; skill?: { name: string } };
    };
    assert.equal(routing.instructions.requestedSkill, 'company:route');
    assert.equal(routing.instructions.skill?.name, 'company:route');
    const prepared = await fixtureState.request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'low', reason: 'Custom content judgment.' },
    });
    assert.equal(prepared.status, 'prepared');
    assert.equal((prepared.request as { model: string }).model, 'gpt-6.1-sol');
    const saved = (
      (await fixtureState.readDispatchState()).records as Array<{
        routingInstructions: { requestedSkill: string };
      }>
    )[0]!;
    assert.equal(saved.routingInstructions.requestedSkill, 'company:route');
    assert.equal('routingNote' in saved, false);
  });

  it('should reject changed routing instructions before native creation', async () => {
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({
        ...fixtureState.manifest,
        models: { ...fixtureState.models, routing: { guidance: { file: 'routing.md' } } },
      }),
    );
    await writeFile(join(fixtureState.workspace, 'routing.md'), 'First instructions.');
    const selected = await fixtureState.next();
    await writeFile(join(fixtureState.workspace, 'routing.md'), 'Changed instructions.');
    const prepared = await fixtureState.request('prepare', {
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
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({
        ...fixtureState.manifest,
        models: { ...fixtureState.models, routing: { skill: 'company:missing' } },
      }),
    );
    fixtureState.deps.native!.assessmentSkill = async () => {
      throw new Error('dispatch-assessment-skill-unavailable');
    };
    assert.equal((await fixtureState.next()).code, 'dispatch-assessment-skill-unavailable');
  });

  it('should reject malformed receipt ids without changing state and preserve lookup behavior', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    const child = { threadId: 'issue-thread' };
    const before = await fixtureState.readDispatchState();
    await assert.rejects(
      fixtureState.request('context', { id: 'x'.repeat(100) }, child),
      /dispatch-receipt-id-invalid/,
    );
    await assert.rejects(
      fixtureState.request(
        'reconcile',
        {
          id: 'x'.repeat(100),
          receipt: { threadId: 'issue-thread' },
        },
        child,
      ),
      /dispatch-receipt-id-invalid/,
    );
    assert.deepEqual(await fixtureState.readDispatchState(), before);
    await assert.rejects(
      fixtureState.request('context', { id: 'a'.repeat(64) }, child),
      /dispatch-receipt-missing/,
    );
    assert.equal(
      (await fixtureState.request('context', { id: prepared.id }, child)).status,
      'verified',
    );
  });

  it('should prepare and reconcile without claims or creating installation state', async () => {
    const { comments } = await fixtureState.claiming('local');
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify(fixtureState.manifest),
    );
    const prepared = await fixtureState.prepare();
    const prompt = (prepared.request as { prompt: string }).prompt;
    assert.ok(prompt.startsWith('## 📥 Issue assigned\n'));
    assert.ok(!prompt.includes(String(prepared.id)));
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    const records = (await fixtureState.readDispatchState()).records as Array<{
      claimId?: number;
      effective?: unknown;
    }>;
    assert.ok(records[0]!.effective);
    assert.equal(records[0]!.claimId, undefined);
    assert.equal(await codexInstanceStore(fixtureState.pluginData).inspect(), undefined);
    assert.equal(comments.length, 0);
  });

  it('should hold a pending swarm claim after switching its route to local', async () => {
    const { comments } = await fixtureState.claiming();
    assert.equal((await fixtureState.next()).status, 'claim-waiting');
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify(fixtureState.manifest),
    );
    fixtureState.now += 300000;
    const held = await fixtureState.next();
    assert.equal(held.code, 'claim-disabled-pending');
    assert.equal(comments.length, 1);
    assert.deepEqual(fixtureState.gitCalls, []);
  });

  it('should enforce uuid eligibility through native preparation and retain accepted ownership after edits', async () => {
    const { store, comments } = await fixtureState.claiming();
    const identity = await store.identity();
    const other = '11111111-1111-4111-8111-111111111111';
    const route = async (target: string | string[]) =>
      writeFile(
        join(fixtureState.workspace, 'agent.yaml'),
        JSON.stringify({
          ...fixtureState.manifest,
          github: {
            ...fixtureState.manifest.github,
            routing: [{ 'owner/repo': target }, 'owner/*'],
          },
        }),
      );
    await route(other);
    const excluded = await fixtureState.next();
    assert.equal((excluded.claim as { code: string }).code, 'claim-route-instance-ineligible');
    assert.equal(comments.length, 0);
    assert.deepEqual(fixtureState.gitCalls, []);
    await route(identity.instanceId);
    fixtureState.now += 300000;
    assert.equal((await fixtureState.next()).status, 'claim-waiting');
    fixtureState.now += 300000;
    const selected = await fixtureState.next();
    assert.equal(selected.status, 'routing-required');
    await route([other]);
    const held = await fixtureState.request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal((held.claim as { code: string }).code, 'claim-route-owner-ineligible');
    assert.equal(fixtureState.native, undefined);
    await route([other, identity.instanceId]);
    fixtureState.now += 300000;
    const prepared = await fixtureState.prepare();
    await route(other);
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /Assignment accepted/u);
  });

  it('should prepare a first assignment with uncached compact reviewers', async () => {
    const updated = structuredClone(fixtureState.manifest);
    Object.assign(updated.github['issue-assignment'], { reviewers: ['@reviewer', 'U_second'] });
    await writeFile(join(fixtureState.workspace, 'agent.yaml'), JSON.stringify(updated));
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    const records = (await fixtureState.readDispatchState()).records as Array<{
      effective?: unknown;
      feedback?: { admission?: { enabled: boolean } };
    }>;
    assert.ok(records[0]!.effective);
    assert.equal(records[0]!.feedback?.admission?.enabled, true);
  });

  it('should uppercase the issue session title while preserving punctuation and unicode', async () => {
    const title = "Fix user's issue: café 東京 Straße 2026.10.6";
    const prepared = await fixtureState.prepare(title);
    const records = (await fixtureState.readDispatchState()).records as Array<{
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
      const prepared = await fixtureState.prepare(title);
      const records = (await fixtureState.readDispatchState()).records as Array<{
        request?: { title?: string };
      }>;
      assert.equal(prepared.status, 'prepared');
      assert.equal(records[0]!.request?.title, expected);
    });

  it('should hold a saved pilot claim without preparing work or changing its receipt', async () => {
    const { store, comments } = await fixtureState.claiming();
    assert.equal((await fixtureState.next()).status, 'claim-waiting');
    const before = await store.file.read();
    delete fixtureState.deps.claims;
    fixtureState.now += 300000;
    const held = await fixtureState.next();
    assert.equal(held.code, 'claim-disabled-pending');
    assert.deepEqual(fixtureState.gitCalls, []);
    assert.equal(await store.file.read(), before);
    assert.equal(comments.length, 1);
    assert.doesNotMatch(comments[0]!.body, /Assignment accepted/u);
  });

  it('should hold a selected pilot claim if claims are disabled before preparation', async () => {
    const { store } = await fixtureState.claiming();
    await fixtureState.next();
    fixtureState.now += 300000;
    const selected = await fixtureState.next();
    const before = await store.file.read();
    delete fixtureState.deps.claims;
    const held = await fixtureState.request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
    });
    assert.equal(held.code, 'claim-disabled-pending');
    assert.equal(await store.file.read(), before);
    const records = (await fixtureState.readDispatchState()).records as Array<{
      request?: unknown;
    }>;
    assert.equal(records[0]!.request, undefined);
  });

  it('should recover existing native work without accepting its pilot claim while dormant', async () => {
    const { store, comments } = await fixtureState.claiming();
    await fixtureState.next();
    fixtureState.now += 300000;
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    const before = await store.file.read();
    delete fixtureState.deps.claims;
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    const records = (await fixtureState.readDispatchState()).records as Array<{
      claimAccepted?: boolean;
      effective?: unknown;
    }>;
    assert.ok(records[0]!.effective);
    assert.equal(records[0]!.claimAccepted, undefined);
    assert.equal(await store.file.read(), before);
    assert.doesNotMatch(comments[0]!.body, /Assignment accepted/u);
  });

  it('should inherit native adapter capture and preserve signal versus timeout metadata', async () => {
    const bin = join(fixtureState.root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'gh'), '', { mode: 0o700 });
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = bin;
      for (const termination of ['signal', 'timeout', 'no-output-timeout'] as const) {
        const connection = await connectCodexGitHubAccount(
          fixtureState.workspace,
          new AbortController().signal,
          async (argv, options) => {
            for (const field of ['maxOutputBytes', 'maxCombinedOutputBytes', 'outputCapture'])
              assert.equal(Object.hasOwn(options, field), false);
            const identity = argv.includes('/user');
            return {
              code: identity ? 0 : null,
              stdout: identity ? JSON.stringify(fixtureState.fixture.client.identity) : 'tail',
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
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({
        ...fixtureState.manifest,
        github: { ...fixtureState.manifest.github, routing: [{ 'owner/*': 'swarm' }] },
      }),
    );
    const comments: Array<GitHubCanonicalIssueComment & { bodyLength: number; issueUrl: string }> =
      [];
    const bin = join(fixtureState.root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'gh'), '', { mode: 0o700 });
    const previousPath = process.env.PATH;
    let connection: Awaited<ReturnType<typeof connectCodexGitHubAccount>>;
    try {
      process.env.PATH = bin;
      connection = await connectCodexGitHubAccount(
        fixtureState.workspace,
        new AbortController().signal,
        async (argv, options) => {
          assert.equal(options.cwd, fixtureState.workspace);
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
              const identity = [
                fixtureState.fixture.repository.owner,
                fixtureState.fixture.client.identity,
              ].find((entry) => entry.nodeId === nodeId);
              assert.ok(identity, 'requested identity belongs to the fixture');
              return { id: identity.nodeId, login: identity.login, __typename: identity.type };
            });
            value = { data: ids ? { nodes } : { node: nodes[0] } };
          } else if (endpoint === '/user') value = fixtureState.fixture.client.identity;
          else if (endpoint === '/repos/owner/repo') value = fixtureState.fixture.repository;
          else if (endpoint === '/repos/owner/repo/issues/3') {
            value = {
              ...fixtureState.fixture.item,
              isPullRequest: false,
              title: 'Repair contained behavior',
              body: 'The acceptance criteria require a safe plan.',
              commentCount: comments.length,
              labels: [],
            };
          } else if (endpoint === '/repos/owner/repo/issues/3/events')
            value = fixtureState.fixture.events;
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
                author: fixtureState.fixture.client.identity,
                body,
                bodyTruncated: false,
                bodyLength: body.length,
                issueUrl: 'https://api.github.com/repos/owner/repo/issues/3',
                createdAt: new Date(fixtureState.now).toISOString(),
                updatedAt: new Date(fixtureState.now).toISOString(),
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
    fixtureState.deps.connect = async () => connection.client;
    fixtureState.deps.claims = new CodexAssignmentClaims(
      codexInstanceStore(fixtureState.pluginData),
    );
    await codexInstanceStore(fixtureState.pluginData).identity();
    const first = await fixtureState.next();
    assert.equal(first.status, 'claim-waiting', JSON.stringify(first));
    assert.equal((await fixtureState.next()).status, 'idle');
    assert.deepEqual(fixtureState.gitCalls, []);
    assert.equal(comments.length, 1);
    fixtureState.now += 300000;
    const prepared = await fixtureState.prepare();
    assert.doesNotMatch(comments[0]!.body, /Assignment accepted/u);
    const unresolved = await fixtureState.request('reconcile', { id: prepared.id });
    assert.equal(unresolved.code, 'dispatch-creation-unresolved');
    assert.doesNotMatch(comments[0]!.body, /Assignment accepted/u);
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    assert.match(comments[0]!.body, /Assignment accepted/u);
    const record = (await fixtureState.readDispatchState()).records as Array<{
      claimAccepted: boolean;
    }>;
    assert.equal(record[0]!.claimAccepted, true);
    assert.equal(comments.length, 1);
  });

  it('should leave a claim owned by openclaw without preparing any codex repository or chat', async () => {
    const { store, client, comments } = await fixtureState.claiming();
    const selected = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const intake = (await selected.store.read())!.records[0]!;
    const other = new OpenClawAssignmentClaims(
      new AssignmentClaimStore(join(fixtureState.root, 'openclaw-instance')),
      () => client,
    );
    const eligibleInstanceIds = [
      (await store.identity()).instanceId,
      (await other.store.identity()).instanceId,
    ];
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({
        ...fixtureState.manifest,
        github: {
          ...fixtureState.manifest.github,
          routing: [{ 'owner/repo': eligibleInstanceIds }],
        },
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
      client: fixtureState.fixture.client as never,
      caller,
      hasCapacity: true,
    });
    assert.equal((await fixtureState.next()).status, 'claim-waiting');
    fixtureState.now += 300000;
    const loser = await fixtureState.next();
    assert.equal((loser.claim as { status: string }).status, 'other-owner');
    assert.deepEqual(fixtureState.gitCalls, []);
    assert.equal(
      (
        await other.select({
          mode: 'swarm',
          eligibleInstanceIds: [...eligibleInstanceIds].reverse(),
          intake,
          client: fixtureState.fixture.client as never,
          caller: { ...caller, runId: 'second' },
          hasCapacity: true,
        })
      ).status,
      'owned',
    );
    assert.equal(comments.length, 1);
  });

  it('should stop preparation when the selected winner disappears', async () => {
    const { comments } = await fixtureState.claiming();
    await fixtureState.next();
    fixtureState.now += 300000;
    const selected = await fixtureState.next();
    assert.equal(selected.status, 'routing-required');
    comments.length = 0;
    const stopped = await fixtureState.request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair behavior',
      assessment: { complexity: 'medium', reason: 'Contained change.' },
    });
    assert.equal(stopped.code, 'claim-winner-missing');
    const records = (await fixtureState.readDispatchState()).records as Array<{
      request?: unknown;
    }>;
    assert.equal(records[0]!.request, undefined);
  });

  it('should release a blocked owner only after native terminal evidence and retain it on unreadable history', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    fixtureState.native!.status = 'notLoaded';
    fixtureState.native!.turnStatus = 'interrupted';
    await fixtureState.next();
    assert.equal(codexItemOccupied((await store.read()).records[0]!), true);
    fixtureState.native!.turnEnded = true;
    await fixtureState.next();
    assert.equal(codexItemOccupied((await store.read()).records[0]!), false);
    fixtureState.deps.native!.find = async () => {
      throw new Error('dispatch-host-unavailable');
    };
    await fixtureState.next();
    assert.equal(codexItemOccupied((await store.read()).records[0]!), true);
  });

  it('should retry a transient preparation failure only after its backoff', async () => {
    const original = fixtureState.deps.connect!;
    fixtureState.deps.connect = async (...args) => ({
      ...(await original(...args)),
      getItemContext: async () => {
        throw new Error('dispatch-host-unavailable');
      },
    });
    const failure = await fixtureState.next();
    assert.equal(failure.code, 'dispatch-host-unavailable');
    const selected = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(
      selected.store.location.root,
      selected.store.location.scope,
    );
    const retained = (await store.read()).records[0]!;
    assert.equal(retained.retry?.attempts, 1);
    assert.equal((await fixtureState.next()).status, 'idle');
    fixtureState.deps.connect = original;
    fixtureState.now = retained.retryAfter!;
    assert.equal((await fixtureState.next()).status, 'routing-required');
  });

  it('should fill available slots past running assessments and retain the remaining queue and notices', async () => {
    const items = [
      fixtureState.fixture.item,
      ...[4, 5].map((number) => ({
        ...fixtureState.fixture.item,
        number,
        nodeId: 'I_' + number,
        databaseId: 20 + number,
      })),
    ];
    fixtureState.fixture.client.discoverAssigned = async () => ({
      candidates: items.map((item) => ({ ...item, repositoryPath: '/repos/owner/repo' })),
      incomplete: false,
      totalCount: items.length,
      truncated: false,
    });
    fixtureState.fixture.client.getItem = async (_owner, _repo, number) =>
      items.find((item) => item.number === number)!;
    fixtureState.fixture.client.listAssignmentEvents = async (_owner, _repo, number) => ({
      events:
        number === 3
          ? fixtureState.fixture.events
          : fixtureState.fixture.events.map((event) => ({
              ...event,
              nodeId: 'E_' + number,
              databaseId: 30 + number,
            })),
      truncated: false,
    });
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    const children = new Map<string, DispatchNativeThread>();
    const checked: string[] = [];
    fixtureState.deps.native!.find = async ({ threadId }) => {
      checked.push(threadId!);
      return children.get(threadId!);
    };
    const launch = async (number: number) => {
      const prepared = await fixtureState.prepare();
      fixtureState.created();
      fixtureState.native!.id = 'issue-thread-' + number;
      fixtureState.native!.name = '#' + number + ': REPAIR CONTAINED BEHAVIOR';
      children.set(fixtureState.native!.id, fixtureState.native!);
      const launched = await fixtureState.request('reconcile', {
        id: prepared.id,
        receipt: { threadId: fixtureState.native!.id },
      });
      assert.equal(launched.nextAction, 'next');
      return prepared;
    };
    await launch(3);
    const second = await launch(4);
    assert.deepEqual(await fixtureState.next(), { status: 'at-capacity', changed: false });
    assert.equal(((await fixtureState.readDispatchState()).records as unknown[]).length, 2);
    const started = await fixtureState.report();
    assert.match(String(started.response), /2 issues started/);
    assert.ok(String(started.response).includes('[owner/repo#3](codex://threads/issue-thread-3)'));
    assert.ok(String(started.response).includes('[owner/repo#4](codex://threads/issue-thread-4)'));

    fixtureState.now += 300001;
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    checked.length = 0;
    assert.deepEqual(await fixtureState.next(), { status: 'at-capacity', changed: false });
    assert.deepEqual([...new Set(checked)], ['issue-thread-3', 'issue-thread-4']);
    assert.equal((await fixtureState.report()).status, 'report');

    await fixtureState.renderAssessment(fixtureState.result, { threadId: 'issue-thread-3' });
    Object.assign(children.get('issue-thread-3')!, {
      status: 'idle',
      turnEnded: true,
      turnStatus: 'completed',
    });
    fixtureState.now += 300001;
    await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    const third = await launch(5);
    assert.notEqual(third.id, second.id);
    assert.deepEqual(await fixtureState.next(), { status: 'at-capacity', changed: false });
    const completed = await fixtureState.report();
    assert.match(String(completed.response), /1 issue started/);
    assert.doesNotMatch(String(completed.response), /#3|Plan ready/);
    assert.match(String(completed.response), /repo#5/);
    assert.equal((await fixtureState.report()).status, 'report');
    assert.equal(((await fixtureState.readDispatchState()).records as unknown[]).length, 3);
  });

  it('should retry a verified denial only through a fresh operator recovery preview', async () => {
    const first = await fixtureState.prepare();
    const operator = {
      threadId: 'operator',
      activation: async (_data: string, _deps: unknown, paused?: boolean) => {
        assert.equal(paused, true);
        return { sourceThreadId: 'intake-thread' };
      },
    };
    await assert.rejects(
      fixtureState.request('retry-denied', { id: first.id }),
      /dispatch-operator-caller-required/,
    );
    const preview = await fixtureState.request('retry-denied', { id: first.id }, operator);
    assert.equal(preview.status, 'retry-available');
    await assert.rejects(
      fixtureState.request('retry-denied', { id: first.id, digest: 'stale' }, operator),
      /dispatch-recovery-stale/,
    );
    assert.equal(
      (
        await fixtureState.request(
          'retry-denied',
          { id: first.id, digest: preview.digest },
          operator,
        )
      ).status,
      'retry-ready',
    );
    await assert.rejects(
      fixtureState.request('retry-denied', { id: first.id, digest: preview.digest }, operator),
      /dispatch-denial-unverified/,
    );
    const rerouted = await fixtureState.next();
    assert.equal((rerouted.recovery as { status: string }).status, 'verified-denial');
    assert.equal(rerouted.nextAction, 'prepare');
    const second = await fixtureState.prepare();
    assert.equal(second.id, first.id);
    assert.notEqual(
      (second.request as { prompt: string }).prompt,
      (first.request as { prompt: string }).prompt,
    );
    const state = await fixtureState.readDispatchState();
    const recovered = (state.records as DispatchRecord[])[0]!.creationRecovery!;
    assert.equal(recovered.attempts, 1);
    assert.deepEqual(recovered.latest, {
      kind: 'denied',
      createdAt: fixtureState.now,
      recoveredAt: fixtureState.now,
      turnId: 'denied-turn',
      callId: 'denied-call',
    });
    for (let attempt = 1; attempt < 10; attempt++) {
      fixtureState.now += 300000;
      await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
      const retry = await fixtureState.request('retry-denied', { id: first.id }, operator);
      assert.equal(retry.status, 'retry-available');
      await fixtureState.request('retry-denied', { id: first.id, digest: retry.digest }, operator);
      await fixtureState.prepare();
    }
    const retained = (await fixtureState.readDispatchState()).records as DispatchRecord[];
    assert.equal(retained[0]!.creationRecovery!.attempts, 10);
  });

  it('should allow verified operator recovery from an unrelated managed task chat', async () => {
    const first = await fixtureState.prepare();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
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
      fixtureState.request('retry-denied', input, {
        threadId: 'operator',
        native: {
          ...fixtureState.deps.native!,
          operatorInput: async () => {
            throw new Error('reply-native-user-input-required');
          },
        },
      }),
      /reply-native-user-input-required/,
    );
    assert.equal(
      (await fixtureState.request('retry-denied', input, { threadId: 'operator' })).status,
      'retry-ready',
    );
    const state = await store.read();
    assert.equal(state.records[0]!.creationRecovery?.latest?.approvedBy, 'operator');
    assert.deepEqual(state.records[1], unrelated);
  });

  it('should recover an explicitly approved denied request after reassignment without retaining its waiting continuation', async () => {
    const first = await fixtureState.prepare();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      record.nativeWork = {
        selection: (
          await selectWorkflowStage({
            stage: 'assessment',
            workspace: fixtureState.workspace,
            observedAt: fixtureState.now,
            resolveSkill: (id) =>
              fixtureState.deps.native!.assessmentSkill!(fixtureState.workspace, id),
          })
        ).selection,
      };
      await save();
    });
    await fixtureState.reassign();
    fixtureState.deps.native!.deniedCreation = async (
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
      fixtureState.request('retry-denied', { id: first.id }, operator),
      /dispatch-denial-approval-required/,
    );
    const input = { id: first.id, approvedCallId: 'denied-call' };
    const preview = await fixtureState.request('retry-denied', input, operator);
    fixtureState.fixture.item.state = 'closed';
    await assert.rejects(
      fixtureState.request('retry-denied', { ...input, digest: preview.digest }, operator),
      /dispatch-issue-closed/,
    );
    fixtureState.fixture.item.state = 'open';
    assert.equal(
      (
        await fixtureState.request(
          'retry-denied',
          { id: first.id, apply: true, renewAuthorization: true },
          operator,
        )
      ).status,
      'retry-ready',
    );
    const retained = (await store.read()).records[0]!;
    assert.equal(retained.nativeWork, undefined);
    assert.equal(retained.preparationTurnId, undefined);
    assert.equal(retained.creationRecovery?.latest?.approvedBy, 'operator');
    const successor = await fixtureState.prepare();
    assert.equal(successor.id, first.id);
    assert.notDeepEqual(successor.request, first.request);
  });

  it('should preserve uncertain or already created requests during operator recovery', async () => {
    const first = await fixtureState.prepare();
    const operator = { threadId: 'operator' };
    await assert.rejects(
      fixtureState.request(
        'retry-denied',
        { id: first.id },
        {
          ...operator,
          native: {
            ...fixtureState.deps.native!,
            async deniedCreation() {
              throw new Error('dispatch-denial-unverified');
            },
          },
        },
      ),
      /dispatch-denial-unverified/,
    );
    fixtureState.created();
    await assert.rejects(
      fixtureState.request('retry-denied', { id: first.id }, operator),
      /dispatch-denial-unverified/,
    );
    fixtureState.native = undefined;
    await fixtureState.request('reconcile', {
      id: first.id,
      receipt: { clientThreadId: 'pending-native-creation' },
    });
    await assert.rejects(
      fixtureState.request('retry-denied', { id: first.id }, operator),
      /dispatch-denial-unverified/,
    );
    const state = await fixtureState.readDispatchState();
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
    assert.deepEqual((await fixtureState.request('inspect', {}, unavailable)).records, []);
    await assert.rejects(
      fixtureState.request('next', { projects: fixtureState.projects }, unavailable),
      /dispatch-activation-required/,
    );
    await assert.rejects(
      fixtureState.request('next', { projects: fixtureState.projects }, { threadId: 'other-chat' }),
      /(?:dispatch-intake|feedback-schedule)-caller-required/,
    );
    assert.equal(fixtureState.gitCalls.length, 0);
  });

  it('should reject malformed project inventories without retaining a task failure', async () => {
    fixtureState.deps.prepareRepository = async () =>
      assert.fail('invalid input must not prepare a checkout');
    fixtureState.deps.connect = async () =>
      assert.fail('invalid input must not read assignments or claim work');
    for (const projects of [undefined, {}, Array(1001).fill(null)]) {
      await assert.rejects(
        fixtureState.request('next', { projects }),
        /dispatch-project-inventory-invalid/,
      );
      assert.deepEqual((await fixtureState.readDispatchState()).records, []);
      assert.equal(fixtureState.gitCalls.length, 0);
    }
  });

  it('should recover a retained inventory error with valid input and preserve its identity', async () => {
    const selected = await fixtureState.next();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      const record = state.records[0]!;
      delete record.project;
      delete record.context;
      delete record.preparationObservation;

      await save();
    });
    const previous = (await store.read()).records;
    await assert.rejects(fixtureState.request('next'), /dispatch-project-inventory-invalid/);
    const afterInvalid = (await store.read()).records;
    assert.equal(afterInvalid.length, 1);
    assert.equal(afterInvalid[0]!.id, previous[0]!.id);

    assert.equal(afterInvalid[0]!.request, undefined);
    const resumed = await fixtureState.next();
    assert.equal(resumed.status, 'routing-required');
    assert.equal(resumed.id, selected.id);
    const records = (await store.read()).records;
    assert.equal(records.length, 1);
    assert.equal(records[0]!.request, undefined);
  });

  it('should retain one quiet setup blocker and resume the same assignment after project setup', async () => {
    fixtureState.projects = [];
    const blocked = await fixtureState.next();
    assert.equal(blocked.code, 'dispatch-project-registration-unavailable');
    assert.equal(blocked.changed, true);
    assert.match(String(blocked.message), /^> ## ⚠️ Add the project to continue\n/u);
    assert.ok(String(blocked.message).includes('- **Project name:** `repo`\n'));
    assert.ok(
      String(blocked.message).includes(
        '- **Folder path:** ' + githubNotificationMarkdownCode(fixtureState.source) + '\n',
      ),
    );
    assert.match(String(blocked.message), /https:\/\/github.com\/owner\/repo\/issues\/3/u);
    assert.match(String(blocked.message), /primary folder/u);
    fixtureState.now += 300001;
    assert.equal((await fixtureState.next()).changed, false);
    fixtureState.projects = [
      {
        projectId: 'saved-project',
        path: fixtureState.source,
        projectKind: 'local',
        hostId: 'local',
        isGitRepository: true,
      },
    ];
    fixtureState.now += 300001;
    const resumed = await fixtureState.next();
    assert.equal(resumed.status, 'routing-required');
    assert.equal(resumed.id, blocked.id);
  });

  for (const managed of [true, false]) {
    for (const broken of [true, false]) {
      it(`should prepare only owned saved base checkouts when ${managed ? 'managed' : 'external'} and ${broken ? 'bare-configured' : 'healthy'}`, async () => {
        if (managed) {
          fixtureState.source = join(
            fixtureState.workspace,
            '.agent-system',
            'worktrees',
            gitWorktreeRepositoryDirectoryName('github-10').replace(/\.git$/u, ''),
            'codex-project',
          );
          await mkdir(fixtureState.source, { recursive: true });
          Object.assign(fixtureState.projects[0]!, { path: fixtureState.source });
        }
        let preparations = 0;
        const prepareRepository = fixtureState.deps.prepareRepository!;
        fixtureState.deps.prepareRepository = async (...args) => {
          preparations++;
          return prepareRepository(...args);
        };
        const git = fixtureState.deps.git!;
        fixtureState.deps.git = async (cwd, argv, signal) =>
          broken && preparations === 0 && argv.includes('--is-bare-repository')
            ? 'true'
            : git(cwd, argv, signal);
        const result = await fixtureState.next();
        assert.equal(preparations, managed ? 1 : 0);
        assert.equal(result.status, broken && !managed ? 'retrying' : 'routing-required');
        if (broken && !managed) {
          assert.equal(result.code, 'dispatch-project-workspace-required');
          const retained = (
            (await fixtureState.readDispatchState()).records as DispatchRecord[]
          )[0]!;
          assert.equal(retained.request, undefined);
          assert.ok(retained.retryAfter && retained.retryAfter > fixtureState.now);
          fixtureState.now = retained.retryAfter;
          assert.equal((await fixtureState.next()).status, 'retrying');
          assert.equal(preparations, 0);
          fixtureState.deps.git = git;
          fixtureState.now = (
            (await fixtureState.readDispatchState()).records as DispatchRecord[]
          )[0]!.retryAfter!;
          const resumed = await fixtureState.next();
          assert.equal(resumed.status, 'routing-required');
          assert.equal(resumed.id, result.id);
          assert.equal(preparations, 0);
        }
      });
    }
  }

  it('should give the exact retained location and mapping key for configuration recovery', async () => {
    fixtureState.projects = [];
    fixtureState.deps.prepareRepository = async (input) => {
      throw new RepositoryPreparationError(
        'repository-preparation-changed',
        fixtureState.source,
        'github.com/' + input.repository,
      );
    };
    const blocked = await fixtureState.next();
    assert.equal(blocked.code, 'repository-preparation-changed');
    assert.ok(String(blocked.remediation).includes('git.worktrees.repositories.local.github-10'));
    assert.ok(
      String(blocked.remediation).includes(githubNotificationMarkdownCode(fixtureState.source)),
    );
    assert.match(String(blocked.remediation), /Verify the retained checkout/u);
    assert.doesNotMatch(String(blocked.remediation), /Reconcile through Install/u);
    assert.match(String(blocked.remediation), /do not delete/u);
    assert.equal(fixtureState.gitCalls.length, 0);
  });

  it('should honor a configured directory instead of using another saved checkout', async () => {
    const path = join(fixtureState.root, 'checkouts', 'repo');
    await mkdir(path, { recursive: true });
    await writeFile(
      join(fixtureState.workspace, 'agent.yaml'),
      JSON.stringify({
        ...fixtureState.manifest,
        git: { worktrees: { repositories: { 'working-directory': '../checkouts' } } },
      }),
    );
    let preparations = 0;
    fixtureState.deps.prepareRepository = async (input, dependencies) => {
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
    const blocked = await fixtureState.next();
    assert.equal(blocked.code, 'dispatch-project-registration-unavailable');
    assert.ok(String(blocked.message).includes(githubNotificationMarkdownCode(path)));
    assert.equal(preparations, 1);
    assert.ok(!fixtureState.gitCalls.some((argv) => argv[0] === 'fetch'));
  });

  it('should emit one exact launch and recover uncertain creation instead of issuing another', async () => {
    const prepared = await fixtureState.prepare();
    const launch = prepared.request as {
      prompt: string;
      model: string;
      thinking: string;
      target: { projectId: string; environment: { startingState: { branchName: string } } };
    };
    assert.equal(launch.model, 'gpt-6.1-sol');
    assert.equal(launch.thinking, 'high');
    assert.equal(launch.target.projectId, 'saved-project');
    assert.equal(launch.target.environment.startingState.branchName, fixtureState.commit);
    assert.ok(!launch.prompt.includes('The acceptance criteria require a safe plan.'));
    const retry = await fixtureState.request('prepare', {
      id: prepared.id,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Same request.' },
    });
    assert.equal(retry.status, 'reconcile-required');
    const uncertain = await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { clientThreadId: 'pending-client', hostId: 'local' },
    });
    assert.equal(uncertain.status, 'creating');
    assert.equal(uncertain.changed, false);
    assert.equal(uncertain.code, undefined);
    fixtureState.created();
    fixtureState.now += 300001;
    const recovered = await fixtureState.next();
    assert.equal(recovered.status, 'created');
    assert.equal(recovered.threadId, 'issue-thread');
    const retained = await fixtureState.request(
      'context',
      { id: prepared.id },
      { threadId: 'issue-thread' },
    );
    assert.deepEqual(retained.evidence, { source: 'https://github.com/owner/repo/issues/3' });
    const records = (await fixtureState.readDispatchState()).records as {
      clientThreadId: string;
      threadId: string;
      effective: { status: string };
    }[];
    assert.equal(records.length, 1);
    assert.equal(records[0]!.clientThreadId, 'pending-client');
    assert.equal(records[0]!.effective.status, 'verified');
  });

  it('should bound pending worktree setup without repeating native creation', async () => {
    const prepared = await fixtureState.prepare();
    const pending = await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { clientThreadId: 'pending-client', hostId: 'local' },
    });
    assert.equal(pending.status, 'creating');
    assert.equal(pending.changed, false);
    assert.equal((await fixtureState.next()).changed, false);
    fixtureState.now += 300000;
    const expired = await fixtureState.next();
    assert.equal(expired.code, 'dispatch-creation-unresolved');
    assert.equal(expired.changed, true);
    fixtureState.now += 300001;
    assert.equal((await fixtureState.next()).changed, false);
    const state = await fixtureState.readDispatchState();
    assert.deepEqual((state.records as { request: unknown }[])[0]!.request, prepared.request);
  });

  it('should recover a lost response from the returned creation handoff without another creation', async () => {
    const prepared = await fixtureState.prepare();
    assert.equal(typeof prepared.nativeHandoff, 'string');
    let creations = 0;
    await assert.rejects(
      runInNewContext('(async () => {' + prepared.nativeHandoff + '})()', {
        text: () => {},
        tools: {
          mcp__codex_app__create_thread: async (input: unknown) => {
            assert.deepEqual(JSON.parse(JSON.stringify(input)), prepared.request);
            creations++;
            fixtureState.created();
            throw new Error('native response lost');
          },
        },
      }),
      /native response lost/,
    );
    const recovered = await fixtureState.request('reconcile', { id: prepared.id });
    assert.equal(recovered.status, 'created');
    assert.equal(recovered.threadId, 'issue-thread');
    assert.equal(recovered.nativeHandoff, undefined);
    const again = await fixtureState.request('prepare', {
      id: prepared.id,
      title: 'repair contained behavior',
      assessment: { complexity: 'medium', reason: 'Same request.' },
    });
    assert.equal(again.status, 'reconcile-required');
    assert.equal(again.nativeHandoff, undefined);
    assert.equal(creations, 1);
  });

  it('should report unknown creation outcomes immediately without a pending receipt', async () => {
    const prepared = await fixtureState.prepare();
    const unknown = await fixtureState.request('reconcile', { id: prepared.id });
    assert.equal(unknown.code, 'dispatch-creation-unresolved');
    assert.equal(unknown.changed, true);
  });

  it('should return preparation guidance without persisting a failure for premature reconciliation', async () => {
    const routed = await fixtureState.next();
    const before = (await fixtureState.readDispatchState()).records;
    const response = await fixtureState.request('reconcile', { id: routed.id });
    assert.equal(response.status, 'routing-required');
    assert.equal(response.nextAction, 'prepare');
    assert.equal(response.changed, false);
    assert.deepEqual((await fixtureState.readDispatchState()).records, before);
    const prepared = await fixtureState.request('prepare', {
      id: response.id,
      digest: response.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'low', reason: 'Contained change.' },
    });
    assert.equal(prepared.status, 'prepared');
    fixtureState.created();
    assert.equal((await fixtureState.request('reconcile', { id: prepared.id })).status, 'created');
  });

  it('should rearm an unsubmitted creation only on a later verified occurrence', async () => {
    const preparedAt = fixtureState.now;
    const prepared = await fixtureState.prepare();
    assert.equal(prepared.recovery, undefined);
    await fixtureState.request('reconcile', { id: prepared.id });
    assert.equal((await fixtureState.next()).changed, false);
    fixtureState.now += 300001;
    fixtureState.deps.native!.unsubmittedCreation = async (threadId, pending, turnId) => {
      assert.equal(threadId, 'intake-thread');
      assert.deepEqual(pending, {
        createdAt: preparedAt,
        turnId: 'run-' + preparedAt,
        prompt: (prepared.request as { prompt: string }).prompt,
      });
      assert.equal(turnId, 'run-' + fixtureState.now);
      return { turnId: 'run-' + preparedAt };
    };
    const routing = await fixtureState.next();
    assert.equal((routing.recovery as { status: string }).status, 'verified-unsubmitted');
    assert.equal(routing.nextAction, 'prepare');
    const retry = await fixtureState.prepare();
    assert.equal(retry.id, prepared.id);
    const recovery = retry.recovery as {
      status: string;
      previousAttempt: { turnId: string; createdAt: number; recoveredAt: number };
    };
    assert.equal(recovery.status, 'verified-unsubmitted');
    assert.deepEqual(recovery.previousAttempt, {
      turnId: 'run-' + preparedAt,
      createdAt: preparedAt,
      recoveredAt: fixtureState.now,
    });
    const original = prepared.request as { prompt: string; model: string; thinking: string };
    const replacement = retry.request as typeof original;
    assert.notEqual(replacement.prompt, original.prompt);
    assert.equal(replacement.model, original.model);
    assert.equal(replacement.thinking, original.thinking);
    const record = (
      (await fixtureState.readDispatchState()).records as Record<string, unknown>[]
    )[0]!;
    assert.deepEqual(record.creationRecovery, {
      attempts: 1,
      latest: {
        kind: 'unsubmitted',
        createdAt: preparedAt,
        recoveredAt: fixtureState.now,
        turnId: 'run-' + preparedAt,
      },
    });
    assert.equal(record.result, undefined);
    assert.equal(
      (
        await fixtureState.request('prepare', {
          id: prepared.id,
          title: 'repair contained behavior',
          assessment: { complexity: 'medium', reason: 'Same request.' },
        })
      ).status,
      'reconcile-required',
    );
    let creations = 0;
    await runInNewContext('(async () => {' + retry.nativeHandoff + '})()', {
      text: () => {},
      tools: {
        mcp__codex_app__create_thread: async (input: unknown) => {
          assert.deepEqual(JSON.parse(JSON.stringify(input)), retry.request);
          creations++;
          fixtureState.created();
          return { threadId: 'issue-thread' };
        },
      },
    });
    assert.equal((await fixtureState.request('reconcile', { id: retry.id })).status, 'created');
    assert.equal(creations, 1);
  });

  it('should preserve an uncertain request when absence cannot be proved', async () => {
    const prepared = await fixtureState.prepare();
    await fixtureState.request('reconcile', { id: prepared.id });
    fixtureState.now += 300001;
    assert.equal((await fixtureState.next()).code, 'dispatch-creation-unresolved');
    const record = (
      (await fixtureState.readDispatchState()).records as Record<string, unknown>[]
    )[0]!;
    assert.deepEqual(record.request, prepared.request);
    assert.equal(record.creationRecovery, undefined);
  });

  it('should preserve native denials during automatic creation recovery', async () => {
    const prepared = await fixtureState.prepare();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    await store.exclusive(async (state, save) => {
      state.records[0]!.denial = {
        sourceThreadId: 'intake-thread',
        turnId: 'denied-turn',
        callId: 'denied-call',
        operation: 'prepare',
        automatic: true,
        observedAt: fixtureState.now,
      };
      state.records[0]!.blocker = 'native-approval-denied';
      await save();
    });
    await fixtureState.reassign();
    fixtureState.deps.native!.unsubmittedCreation = async () => {
      assert.fail('a denial requires operator recovery');
    };
    assert.equal((await fixtureState.next()).status, 'idle');
    assert.deepEqual((await store.read()).records[0]!.request, prepared.request);
  });

  it('should reconcile a superseded unsubmitted request before preparing its successor', async () => {
    const prepared = await fixtureState.prepare();
    await fixtureState.reassign();
    fixtureState.deps.native!.unsubmittedCreation = async () => ({
      turnId: 'completed-original-turn',
    });
    const successor = await fixtureState.prepare();
    assert.equal(successor.id, prepared.id);
    assert.notDeepEqual(successor.request, prepared.request);
    const retained = (
      (await fixtureState.readDispatchState()).records as Record<string, unknown>[]
    )[0]!;
    assert.equal((retained.creationRecovery as { attempts: number }).attempts, 1);
    assert.deepEqual(retained.request, successor.request);
  });

  it('should preserve a superseded request when its native outcome is unknown', async () => {
    const prepared = await fixtureState.prepare();
    await fixtureState.reassign();
    assert.equal((await fixtureState.next()).code, 'dispatch-assignment-superseded');
    const retained = (
      (await fixtureState.readDispatchState()).records as Record<string, unknown>[]
    )[0]!;
    assert.deepEqual(retained.request, prepared.request);
    assert.equal(retained.creationRecovery, undefined);
  });

  it('should continue the occurrence after an item-specific failure instead of ending the report loop', async () => {
    await fixtureState.prepare();
    await fixtureState.reassign();
    const failed = await fixtureState.next();
    assert.equal(failed.nextAction, 'next');
    const state = await fixtureState.readDispatchState();
    assert.equal((state.run as { stopped?: string }).stopped, undefined);
    assert.equal((await fixtureState.next()).status, 'idle');
  });

  it('should recover a superseded native creation without issuing another request', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.reassign();
    assert.equal((await fixtureState.next()).status, 'blocked');
    const retained = (
      (await fixtureState.readDispatchState()).records as Record<string, unknown>[]
    )[0]!;
    assert.deepEqual(retained.request, prepared.request);
    assert.equal(retained.threadId, 'issue-thread');
    assert.equal(retained.blocker, 'dispatch-assignment-superseded');
    assert.equal(retained.creationRecovery, undefined);
  });

  it('should never rearm pending native worktree receipts', async () => {
    const prepared = await fixtureState.prepare();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { clientThreadId: 'pending' },
    });
    fixtureState.deps.native!.unsubmittedCreation = async () => {
      assert.fail('a native receipt must preclude automatic rearming');
    };
    fixtureState.now += 300001;
    assert.equal((await fixtureState.next()).code, 'dispatch-creation-unresolved');
  });

  it('should recover proven unsubmitted creations beyond the former lifetime limit', async () => {
    let prepared = await fixtureState.prepare();
    fixtureState.deps.native!.unsubmittedCreation = async () => ({ turnId: 'completed-turn' });
    for (let count = 0; count < 9; count++) {
      await fixtureState.request('reconcile', { id: prepared.id });
      fixtureState.now += 300001;
      prepared = await fixtureState.prepare();
      assert.equal(prepared.status, 'prepared');
    }
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    assert.equal((await store.read()).records[0]!.creationRecovery?.attempts, 9);
  });

  it('should format results only for the verified child without saving or freezing plans', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', { id: prepared.id });
    const child = { threadId: fixtureState.native!.id };
    await fixtureState.request('context', { id: prepared.id }, child);
    await assert.rejects(
      fixtureState.renderAssessment(fixtureState.result, { threadId: 'other-chat' }),
      /assessment-managed-context-invalid/,
    );
    await assert.rejects(
      fixtureState.renderAssessment('invalid', child),
      /assessment-render-request-invalid/,
    );
    for (const plan of ['Initial plan.', 'Current revised plan.']) {
      const formatted = await fixtureState.renderAssessment(
        { ...fixtureState.result, reviewSummary: plan },
        child,
      );
      assert.equal(formatted.status, 'formatted');
      assert.equal(formatted.retained, false);
      assert.equal('assessment' in formatted, false);
    }
  });

  it('should retain and present questions and setup obstacles without changing routing', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    delete fixtureState.native!.model;
    delete fixtureState.native!.effort;
    const child = { threadId: 'issue-thread' };
    const common = {
      summary: 'Additional input is needed.',
      reviewSummary: 'Additional input is needed.',
    };
    for (const outcome of [
      {
        ...common,
        outcome: 'clarification-needed',
        questions: ['How long should evidence remain?'],
      },
      {
        ...common,
        outcome: 'operator-setup-blocker',
        code: 'source-unavailable',
        remediation: 'Restore access to the required source.',
      },
    ]) {
      fixtureState.native!.turnId = outcome.outcome;
      await fixtureState.request('context', { id: prepared.id }, child);
      const recorded = await fixtureState.renderAssessment(outcome, child);
      assert.equal(recorded.status, 'formatted');
      assert.ok(
        String(recorded.presentation).includes(
          'questions' in outcome ? outcome.questions[0]! : outcome.remediation,
        ),
      );
      const resumed = await fixtureState.request('context', { id: prepared.id }, child);
      assert.equal(resumed.previousResult, undefined);
    }
  });

  for (const relocation of [
    'same repository',
    'foreign repository',
    'project root',
    'shared checkout',
  ] as const) {
    it(`should reconcile closed task checkout ownership before native cleanup: ${relocation}`, async () => {
      const prepared = await fixtureState.prepare();
      fixtureState.created();
      await fixtureState.request('reconcile', {
        id: prepared.id,
        receipt: { threadId: fixtureState.native!.id },
      });
      const moved =
        relocation === 'project root'
          ? fixtureState.source
          : join(fixtureState.root, 'moved-checkout');
      if (moved !== fixtureState.source) await mkdir(moved);
      fixtureState.native!.cwd = moved;
      fixtureState.native!.status = 'idle';
      fixtureState.native!.turnEnded = true;
      fixtureState.fixture.item.state = 'closed';
      await fixtureState.writeCleanup(0);
      fixtureState.now += 60_000;
      const git = fixtureState.deps.git!;
      fixtureState.deps.git = async (path, args) =>
        relocation === 'foreign repository' && path === moved && args[0] === 'remote'
          ? 'https://github.com/other/repo.git'
          : git(path, args);
      fixtureState.deps.retirementNative = {
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
      const attempt = await fixtureState.request('next', {
        projects: fixtureState.projects,
        threads,
      });
      const record = async () =>
        ((await fixtureState.readDispatchState()).records as DispatchRecord[])[0]!;
      if (relocation !== 'same repository') {
        assert.notEqual(attempt.status, 'retirement-prepared');
        assert.equal((await record()).retirement?.archiveAttempt, undefined);
        assert.ok(await record());
        return;
      }
      assert.equal(attempt.status, 'retirement-prepared');
      assert.deepEqual(attempt.request, {
        threadId: 'issue-thread',
        hostId: 'local',
        archived: true,
      });
      assert.equal((await record()).worktree, moved);
      const archives: unknown[] = [];
      await runInNewContext('(async () => {' + attempt.nativeHandoff + '})()', {
        text: () => {},
        tools: {
          mcp__codex_app__set_thread_archived: async (input: unknown) => {
            archives.push(JSON.parse(JSON.stringify(input)));
            fixtureState.native!.archived = true;
            return {};
          },
        },
      });
      assert.deepEqual(archives, [attempt.request]);
      fixtureState.native!.cwd = fixtureState.source;
      await fixtureState.next();
      assert.equal((await record()).retirement?.code, 'retirement-native-reclamation-pending');
      await rm(moved, { recursive: true });
      await fixtureState.next();
      assert.equal(await record(), undefined);
      assert.ok(!fixtureState.gitCalls.some((args) => args.includes('remove')));
    });
  }

  for (const reason of ['closure', 'closure after removal', 'operator request'] as const) {
    it(`should prepare native archival during intake and retire only after observed reclamation: ${reason}`, async () => {
      fixtureState.worktree = join(fixtureState.codexHome, 'worktrees', 'retiring', 'repo');
      await mkdir(fixtureState.worktree, { recursive: true });
      const prepared = await fixtureState.prepare();
      fixtureState.created();
      await fixtureState.request('reconcile', {
        id: prepared.id,
        receipt: { threadId: fixtureState.native!.id },
      });
      fixtureState.native!.status = 'idle';
      fixtureState.native!.turnEnded = true;
      if (reason === 'closure') fixtureState.fixture.item.state = 'closed';
      else if (reason === 'closure after removal') {
        removeFixtureAssignment(fixtureState.fixture);
        fixtureState.now += 60_000;
        await fixtureState.next();
        const held = await fixtureState.request('inspect');
        assert.equal(
          (held.records as { workflowStatus: string }[])[0]!.workflowStatus,
          'awaiting-reassignment',
        );
        fixtureState.fixture.item.state = 'closed';
      }
      if (reason !== 'operator request') {
        fixtureState.now += 60_000;
        await fixtureState.next();
      }
      const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      if (reason !== 'operator request')
        fixtureState.now = (await store.read()).records[0]!.retirement!.eligibleAt;
      const git = fixtureState.deps.git!;
      fixtureState.deps.git = async (path, args) =>
        args[0] === 'for-each-ref' ? 'refs/heads/preserved' : git(path, args);
      fixtureState.deps.retirementNative = {
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
          ? await fixtureState.request('retire', { id: prepared.id }, operator)
          : undefined;
      const archived = preview
        ? await fixtureState.request(
            'retire',
            { id: prepared.id, digest: preview.digest, threads },
            operator,
          )
        : await fixtureState.request('next', { projects: fixtureState.projects, threads });
      if (preview) {
        assert.equal(fixtureState.fixture.item.state, 'open');
        assert.equal((await store.read()).records[0]!.retirement!.eligibleAt, fixtureState.now);
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
      assert.ok((await store.read()).records[0]!);
      fixtureState.native!.archived = true;
      await fixtureState.next();
      assert.equal(
        (await store.read()).records[0]!.retirement?.code,
        'retirement-native-reclamation-pending',
      );
      assert.ok((await store.read()).records[0]!);
      await rm(fixtureState.worktree, { recursive: true });
      await fixtureState.next();
      assert.deepEqual((await store.read()).records, []);
      await fixtureState.next();
      assert.deepEqual((await store.read()).records, []);
    });
  }

  it('should retain unassigned codex work without requesting native cleanup', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: fixtureState.native!.id },
    });
    fixtureState.native!.status = 'idle';
    fixtureState.native!.turnEnded = true;
    await writeFile(join(fixtureState.worktree, 'retained-local.txt'), 'unfinished work');
    removeFixtureAssignment(fixtureState.fixture);
    fixtureState.now += 60_000;
    await fixtureState.next();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const pending = (await store.read()).records[0]!;
    assert.equal(pending.retirement?.reason, 'assignment-removed');
    assert.equal(codexItemOccupied(pending), false);
    fixtureState.now = pending.retirement!.eligibleAt;
    await fixtureState.next();
    const saved = (await store.read()).records[0]!;
    assert.equal(saved.retirement?.code, undefined);
    assert.equal(workflowStatus(saved), 'awaiting-reassignment');
    assert.ok(saved);
    assert.equal(saved.threadId, pending.threadId);
    assert.equal(
      await readFile(join(fixtureState.worktree, 'retained-local.txt'), 'utf8'),
      'unfinished work',
    );
    assert.equal((await store.read()).records.length, 1);
    assert.equal(
      fixtureState.gitCalls.some((args) => args.includes('remove')),
      false,
    );
  });

  it('should revalidate assignment and metadata without giving issue prose model authority', async () => {
    const selected = await fixtureState.next();
    const prepared = await fixtureState.request('prepare', {
      id: selected.id,
      digest: selected.digest,
      title: 'repair contained behavior',
      assessment: { complexity: 'high', reason: 'Issue prose sounds architectural.' },
    });
    assert.equal(prepared.status, 'prepared');
    const launch = prepared.request as { model: string; thinking: string };
    assert.equal(launch.model, 'gpt-6.1-sol');
    assert.equal(launch.thinking, 'high');
    const routed = (
      (await fixtureState.readDispatchState()).records as Array<{ routing: string }>
    )[0]!;
    const decision = JSON.parse(routed.routing);
    assert.equal(decision.complexity, 'medium');
    assert.equal(decision.source, 'native');
    assert.match(decision.reason, /Verified native Complexity: medium/u);
    fixtureState.now += 300001;
    fixtureState.fixture.item.state = 'closed';
    const revoked = await fixtureState.next();
    assert.equal(revoked.status, 'idle');
    const retired = (
      (await fixtureState.readDispatchState()).records as Array<{ retirement?: { reason: string } }>
    )[0]!;
    assert.equal(retired.retirement?.reason, 'issue-closed');
    assert.equal(fixtureState.gitCalls.filter((argv) => argv[0] === 'fetch').length, 1);
  });

  it('should refuse stale preparation and preserve a native model mismatch', async () => {
    const selected = await fixtureState.next();
    await assert.rejects(
      fixtureState.request('prepare', {
        id: selected.id,
        digest: 'stale',
        title: 'repair contained behavior',
        assessment: { complexity: 'medium', reason: 'Verified native complexity.' },
      }),
      /dispatch-preparation-stale/,
    );
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    fixtureState.native!.model = 'another-model';
    const blocked = await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: 'issue-thread' },
    });
    assert.equal(blocked.code, 'dispatch-native-model-diverged');
    assert.equal(blocked.threadId, 'issue-thread');
    assert.match(String(blocked.message), /model access/);
    assert.doesNotMatch(String(blocked.message), /Set issue-assignment mode/);
  });

  it('should still reject effort drift before codex creation is verified', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    fixtureState.native!.effort = 'low';
    const blocked = await fixtureState.request('reconcile', { id: prepared.id });
    assert.equal(blocked.code, 'dispatch-native-model-diverged');
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    assert.equal((await store.read()).records[0]!.effective, undefined);
    fixtureState.native!.effort = 'high';
    assert.equal((await fixtureState.request('reconcile', { id: prepared.id })).status, 'created');
  });

  it('should suppress an overlapping poll while the first owns the dispatch journal', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = fixtureState.deps.connect!;
    fixtureState.deps.connect = async (workspace, signal) => {
      entered();
      await waiting;
      return connect(workspace, signal);
    };
    const first = fixtureState.next();
    await started;
    assert.equal((await fixtureState.next()).status, 'busy');
    release();
    assert.equal((await first).status, 'routing-required');
  });

  it('should wait for a concurrent writer and report the newly saved journal state', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: 'issue-thread' },
    });
    await fixtureState.next();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const writer = store.exclusive(async (state, save) => {
      entered.resolve();
      await release.promise;
      state.records[0]!.intakeReportedAt = fixtureState.now;
      await save();
    });
    await entered.promise;
    try {
      const reporting = fixtureState.report();
      release.resolve();
      await writer;
      const recheck = await reporting;
      assert.equal(recheck.status, 'report');
      const completed = await fixtureState.report();
      assert.equal(completed.status, 'report');
      assert.doesNotMatch(String(completed.response), /1 issue started/);
      assert.equal((await store.read()).records[0]!.intakeReportedAt, fixtureState.now);
    } finally {
      release.resolve();
      await writer;
    }
  });

  it('should leave reporting unconsumed when the bounded journal wait is exhausted', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: 'issue-thread' },
    });
    await fixtureState.next();
    const before = await fixtureState.readDispatchState();
    const lock = properLockfile.lock;
    properLockfile.lock = async (path, options) => {
      if (String(path).includes('codex-dispatch-'))
        throw Object.assign(new Error('The journal remains busy.'), {
          code: 'private-state-file-lock-busy',
        });
      return lock(path, options);
    };
    try {
      assert.deepEqual(await fixtureState.report(), { status: 'busy', changed: false });
      assert.deepEqual(await fixtureState.readDispatchState(), before);
    } finally {
      properLockfile.lock = lock;
    }
    const recovered = await fixtureState.report();
    assert.equal(recovered.status, 'report');
    assert.match(String(recovered.response), /1 issue started/);
    assert.deepEqual(await fixtureState.report(), recovered);
  });

  it('should wait for the journal lease for context and leave it untouched when formatting', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
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
        (await fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }))
          .status,
        'verified',
      );
      refuse = true;
      assert.equal(
        (await fixtureState.renderAssessment(fixtureState.result, { threadId: 'issue-thread' }))
          .status,
        'formatted',
      );
      assert.equal(refuse, true);
    } finally {
      properLockfile.lock = lock;
    }
  });

  it('should preserve a native title edit without blocking assessment or reconciliation', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    fixtureState.native!.name = 'a normalized native title';
    assert.equal(
      (await fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }))
        .status,
      'verified',
    );
    assert.equal(fixtureState.native!.name, 'a normalized native title');
    assert.equal((await fixtureState.request('reconcile', { id: prepared.id })).status, 'created');
    fixtureState.native!.turnStatus = 'failed';
    fixtureState.native!.status = 'idle';
    fixtureState.now += 300001;
    assert.equal((await fixtureState.next()).status, 'idle');
    assert.equal(
      (await fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }))
        .status,
      'verified',
    );
    assert.equal(
      (await fixtureState.renderAssessment(fixtureState.result, { threadId: 'issue-thread' }))
        .status,
      'formatted',
    );
    assert.equal(((await fixtureState.readDispatchState()).records as unknown[]).length, 1);
  });

  it('should page managed implementation through its original dispatch command', async () => {
    const work = await fixtureState.workIssue();
    work.receive();
    const history: unknown[] = [];
    const run = async (input: Record<string, unknown>) => {
      const parsed = codexRuntimeRequest(
        'dispatch',
        ['implementation', 'context', '--plugin-data', fixtureState.pluginData],
        input,
      ).request;
      const bound = await bindNativeMaterial(
        'dispatch',
        parsed,
        (async function* () {
          yield* history;
        })(),
      );
      const response = nativeMaterialResponse(
        await fixtureState.request('implementation', bound, {
          ...work.continuation,
          threadId: fixtureState.native!.id,
        }),
        'dispatch',
        parsed,
      );
      history.unshift(response);
      return response;
    };
    const first = await run({ action: 'implementation', operation: 'context' });
    assert.equal(first.status, 'verified');
    assert.ok(first.contextMaterials);
    const before = await fixtureState.readDispatchState();
    let pages = 0;
    const restored = await hydrateImplementation(first, async (read) => {
      assert.equal(read.action, 'implementation');
      assert.equal(read.operation, 'context');
      assert.equal('id' in read, false);
      assert.equal('digest' in (read.material as object), false);
      pages++;
      return run(read);
    });
    assert.ok(pages >= 2);
    assert.equal(typeof restored.instructions, 'string');
    assert.deepEqual(await fixtureState.readDispatchState(), before);
  });

  it('should defer pre-transaction continuation contention without consuming work or action counters', async () => {
    const work = await fixtureState.workIssue();
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
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
      const work = await fixtureState.workIssue(
        null,
        'Continue the task.',
        'company:implement',
        mode,
      );
      const store = await fixtureState.workStore();
      fixtureState.native!.status = 'active';
      fixtureState.native!.turnStatus = 'inProgress';
      fixtureState.native!.turnEnded = false;
      const observe = work.continuation.continuationNative!;
      let advanced = false;
      work.continuation.continuationNative = async (...args) => {
        if (!advanced) {
          advanced = true;
          await store.exclusive(async (state, save) => {
            state.run = {
              id: 'concurrent-intake',
              automationId: 'native-intake',
              currentTimeIso: new Date(fixtureState.now).toISOString(),
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
    });

  it('should retain occurrence accounting across competing native observations', async () => {
    const work = await fixtureState.workIssue();
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
    const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
    const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
    assert.equal((await store.read()).continuationRun?.actions, 1);
  });

  it('should commit unrelated progress while continuation native readback is delayed', async () => {
    const work = await fixtureState.workIssue();
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
      const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
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
      const prepared = await fixtureState.prepare();
      fixtureState.created();
      const child = { threadId: fixtureState.native!.id };
      await fixtureState.request('context', { id: prepared.id }, child);
      const current = await selectCodexTaskContext(fixtureState.pluginData, fixtureState.deps);
      const store = new CodexDispatchStore(
        current.store.location.root,
        current.store.location.scope,
      );
      const before = (await store.read()).records[0]!;
      fixtureState.native![setting] = setting === 'model' ? 'gpt-6-luna' : 'low';
      const context = await fixtureState.request('context', { id: prepared.id }, child);
      assert.equal(context.status, 'verified');
      assert.deepEqual(context.effective, {
        status: 'verified',
        model: fixtureState.native!.model,
        effort: fixtureState.native!.effort,
      });
      assert.equal(
        (await fixtureState.renderAssessment(fixtureState.result, child)).status,
        'formatted',
      );
      await fixtureState.request('reconcile', { id: prepared.id });
      const after = (await store.read()).records[0]!;
      assert.deepEqual(after.request, before.request);
      assert.equal(after.routing, before.routing);
      assert.equal(after.threadId, before.threadId);
      assert.equal(after.worktree, before.worktree);
      assert.deepEqual(after.effective, context.effective);
    });

  it('should not declare missing results from unloaded history or an active native chat', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: 'issue-thread' },
    });
    for (const status of ['notLoaded', 'active']) {
      for (const turnStatus of ['completed', 'failed', 'interrupted']) {
        fixtureState.native!.status = status;
        fixtureState.native!.turnStatus = turnStatus;
        fixtureState.now += 300001;
        assert.equal((await fixtureState.next()).status, 'idle');
        const records = (await fixtureState.readDispatchState()).records as {
          result?: unknown;
        }[];
        assert.equal(records.length, 1);
        assert.equal(records[0]!.result, undefined);
      }
    }
    await fixtureState.renderAssessment(fixtureState.result, { threadId: 'issue-thread' });
  });

  it('should not require a cosmetic rename to continue a verified issue chat', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    fixtureState.native!.name = 'Operator title';
    fixtureState.deps.native!.rename = async () => {
      throw new Error('rename-unavailable');
    };
    assert.equal(
      (await fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }))
        .status,
      'verified',
    );
    assert.equal(fixtureState.native!.name, 'Operator title');
    assert.equal((await fixtureState.request('reconcile', { id: prepared.id })).status, 'created');
  });

  it('should not rename a chat whose worktree or model verification fails', async () => {
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    fixtureState.native!.name = 'shortened title';
    fixtureState.deps.native!.rename = async () => {
      assert.fail('unverified chat must not be renamed');
    };
    fixtureState.native!.model = 'another-model';
    await assert.rejects(
      fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-native-model-diverged/,
    );
    fixtureState.native!.model = 'gpt-6.1-sol';
    fixtureState.native!.cwd = fixtureState.source;
    await assert.rejects(
      fixtureState.request('context', { id: prepared.id }, { threadId: 'issue-thread' }),
      /dispatch-worktree-required/,
    );
  });

  it('should preserve native and fallback disagreements with their provenance', async () => {
    const connect = fixtureState.deps.connect!;
    fixtureState.deps.connect = async (workspace, signal) => {
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
    const selected = await fixtureState.next();
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
      fixtureState.now += 60000;
      fixtureState.fixture.events.push({
        ...fixtureState.fixture.events[0]!,
        nodeId: 'assignment-' + fixtureState.now,
        databaseId: fixtureState.now,
        createdAt: new Date(fixtureState.now).toISOString(),
      });
      await runCodexIntake(fixtureState.pluginData, false, fixtureState.deps);
    };
    await reassign();
    const prepared = await fixtureState.prepare();
    fixtureState.created();
    await fixtureState.request('reconcile', {
      id: prepared.id,
      receipt: { threadId: 'issue-thread' },
    });
    await fixtureState.next();
    assert.match(String((await fixtureState.report()).response), /\*\*Pending:\*\* 0/);
    await reassign();
    assert.equal((await fixtureState.next()).status, 'idle');
    const response = String((await fixtureState.report()).response);
    assert.match(response, /\*\*Active:\*\* 1 issues · \*\*Pending:\*\* 0/);
    assert.doesNotMatch(response, /issues? pending/);
    assert.equal(((await fixtureState.readDispatchState()).records as unknown[]).length, 1);
  });
});
