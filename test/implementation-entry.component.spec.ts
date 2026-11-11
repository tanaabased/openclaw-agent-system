import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeIssueContext } from '../agent/native-issue-context.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

import assessmentEntry, { type AssessmentEntryDependencies } from '../agent/assessment-entry.ts';
import renderNativeAssessment from '../agent/assessment-render.ts';
import assessmentSkillSource from '../agent/assessment-skill-source.ts';
import codexRuntimeRequest from '../agent/codex-runtime-request.ts';
import { DirectEntryStore } from '../agent/direct-entry-store.ts';
import implementationEntryDelivery from '../agent/implementation-entry-delivery.ts';
import { implementationEntriesSchema } from '../agent/implementation-entry-state.ts';
import implementationEntry from '../agent/implementation-entry.ts';
import {
  implementationReviewInstructions,
  taskScopeInstructions,
} from '../agent/native-task-instructions.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { parseDirectImplementationRequest } from '../tools/dispatch/implementation-schema.ts';
import { intakeFixture } from './github-intake-fixture.ts';

const target = 'https://github.com/owner/repo/issues/3';
const plan =
  'Implement the requested handler; verify success and missing-input behavior with focused tests.';
const ready = {
  outcome: 'done' as const,
  summary: 'Implemented.',
  fullResult:
    'Complete custom report.\nChecks passed; commit abc. Remaining live behavior unverified.',
};

describe('agent/implementation-entry', () => {
  let root: string, deps: AssessmentEntryDependencies, selections: string[], reads: number;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'implementation-entry-')));
    await writeFile(join(root, 'SKILL.md'), '# ordinary implementation body');
    const fixture = intakeFixture();
    selections = [];
    reads = 0;
    deps = {
      root: join(root, 'private'),
      binding: {
        runtime: 'openclaw',
        agentId: 'receiver',
        workspace: root,
        namespace: 'test',
        session: 'chat',
        incarnation: 'session',
      },
      turnId: 'turn',
      inputId: 'input',
      message: 'Implement the plan locally.',
      now: 1,
      manifest: { agent: { id: 'receiver' } } as AgentManifest,
      git: async (_cwd, argv) =>
        argv[0] === 'remote'
          ? 'git@github.com:owner/repo.git'
          : argv[0] === 'status'
            ? ''
            : argv.includes('--show-toplevel')
              ? root
              : 'a'.repeat(40),
      connectProvider: async () => {
        reads++;
        return {
          ...fixture.client,
          getItemContext: async () => ({
            title: 'Issue',
            body: 'Requested handler.',
            comments: [],
            labels: [],
            truncated: false,
          }),
        };
      },
      resolveSkill: async (name) => {
        selections.push(name);
        return assessmentSkillSource({ name, path: join(root, 'SKILL.md'), scope: 'user' });
      },
      managed: async () => undefined,
      assertCurrent: async () => {},
    };
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const call = (operation = 'context', extra = {}) =>
    implementationEntry(
      {
        action: 'implementation',
        operation,
        target,
        path: root,
        ...(operation === 'context' ? { plan } : {}),
        ...extra,
      },
      deps,
    );

  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should select ${runtime} direct work by native custody and require a real target only when ambiguous`, async () => {
      deps.binding.runtime = runtime;
      const context = await call();
      assert.ok('id' in context);
      await call('result', { result: ready });
      const request = { action: 'implementation', operation: 'context' };
      assert.equal((await implementationEntry(request, deps)).status, 'verified');
      for (const field of ['id', 'digest', 'agentId', 'workspace', 'threadId'])
        await assert.rejects(
          implementationEntry({ ...request, [field]: context.id }, deps),
          /implementation-request-invalid/,
        );
      const store = new DirectEntryStore(
        deps.root,
        deps.binding,
        implementationEntriesSchema,
        'implementation',
      );
      await store.exclusive(async (entries, save) => {
        entries.push({
          ...structuredClone(entries[0]!),
          id: 'f'.repeat(64),
          target: target.replace('/3', '/4'),
        });
        await save();
      });
      await assert.rejects(implementationEntry(request, deps), /target-selection-required/);
      assert.equal((await implementationEntry({ ...request, target }, deps)).status, 'verified');
      deps.binding.incarnation = 'another-native-conversation';
      assert.equal(
        (await implementationEntry({ ...request, target }, deps)).status,
        'clarification-needed',
      );
    });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should preserve delivered ${runtime} implementation facts when skill lookup fails`, async () => {
      deps.binding.runtime = runtime;
      const ownerId = 'd'.repeat(64);
      const nativeContext = nativeIssueContext({ id: ownerId, worktree: root });
      const before = structuredClone(nativeContext);
      deps.managed = async () => ({
        digest: 'c'.repeat(64),
        owner: { id: ownerId },
        path: root,
        nativeContext,
        entries: async () => {
          throw new Error('must not read historical implementations');
        },
      });
      deps.resolveSkill = async () => {
        throw new Error('PRIVATE skill failure');
      };
      const complete = await hydrateImplementation(await call(), (read) =>
        implementationEntry(read, deps),
      );
      assert.equal(complete.status, 'native');
      assert.deepEqual(complete.project, { path: root });
      assert.deepEqual(complete.evidence, { source: target });
      assert.equal(complete.implementation, undefined);
      assert.deepEqual(complete.contextLimitations, [
        { scope: 'implementation', code: 'workflow-guidance-unavailable' },
      ]);
      assert.doesNotMatch(JSON.stringify(complete), /PRIVATE/);
      assert.deepEqual(nativeContext, before);
      deps.assertCurrent = async () => {
        throw new Error('native-owner-changed');
      };
      await assert.rejects(call(), /native-owner-changed/);
    });
  }
  for (const [runtime, skillName] of [
    ['codex', undefined],
    ['codex', 'current-implementation'],
    ['openclaw', undefined],
    ['openclaw', 'current-implementation'],
  ] as const)
    it(`should refresh delivered ${runtime} ${skillName ? 'custom' : 'built-in'} context without another managed implementation round`, async () => {
      deps.binding.runtime = runtime;
      const skill = await deps.resolveSkill('old-assessment');
      const ownerId = 'd'.repeat(64);
      const nativeContext = nativeIssueContext({
        id: ownerId,
        worktree: root,
      });
      deps.managed = async () => ({
        digest: 'c'.repeat(64),
        owner: { id: ownerId },
        path: root,
        nativeContext,
        selections: { implementation: { skill: skillName } },
        selection: {
          version: 1,
          requestedSkill: 'old-assessment',
          defaultSkill: false,
          skill,
          observedAt: 0,
        },
        evidence: 'OLD SNAPSHOT',
        entries: async () => {
          throw new Error('must not reopen historical entries');
        },
      });
      let pages = 0;
      const complete = await hydrateImplementation(await call(), (read) => {
        pages++;
        assert.equal('id' in read, false);
        return implementationEntry(read, deps);
      });
      if (runtime === 'openclaw') assert.ok(pages > 0);
      assert.equal(complete.status, 'native');
      assert.equal(
        (complete.implementation as { requestedSkill: string }).requestedSkill,
        skillName ?? 'agent-system:agent-system-task-implementation',
      );
      assert.ok(String(complete.instructions).includes(taskScopeInstructions));
      assert.ok(String(complete.instructions).includes(implementationReviewInstructions));
      assert.deepEqual(complete.evidence, { source: target });
      assert.doesNotMatch(JSON.stringify(complete), /old-assessment|OLD SNAPSHOT/);
      assert.equal('resultSubmission' in complete, false);
      assert.equal('plan' in complete, false);
      assert.deepEqual(
        await new DirectEntryStore(
          deps.root,
          deps.binding,
          implementationEntriesSchema,
          'implementation',
        ).exclusive(async (entries) => entries),
        [],
      );
    });

  it('should retain direct custody without copying completed output across twenty entries', async () => {
    const connect = deps.connectProvider;
    deps.connectProvider = async () => {
      const provider = await connect();
      return {
        ...provider,
        getItem: async (owner, name, number) => ({
          ...(await provider.getItem(owner, name, number)),
          number,
          nodeId: `I_${number}`,
        }),
      };
    };
    const first = await call();
    assert.ok('id' in first);
    await call('result', { result: ready });
    for (let number = 4; number <= 23; number++)
      await call('context', { target: `https://github.com/owner/repo/issues/${number}` });
    const entries = await new DirectEntryStore(
      deps.root,
      deps.binding,
      implementationEntriesSchema,
      'implementation',
    ).exclusive(async (entries) => entries);
    assert.equal(entries.length, 21);
    deps.connectProvider = async () => {
      throw new Error('completed work must recover without provider access');
    };
  });

  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should keep ${runtime} plans in native input without saving or freezing them`, async () => {
      deps.binding.runtime = runtime;
      const largePlan = 'NATIVE-PLAN-ONLY.\n'.repeat(1300);
      deps.message = 'Implement ' + largePlan;
      const first = await call('context', { plan: largePlan });
      assert.ok('id' in first);
      assert.equal(first.status, 'verified');
      assert.doesNotMatch(JSON.stringify(first), /NATIVE-PLAN-ONLY/);
      const store = new DirectEntryStore(
        deps.root,
        deps.binding,
        implementationEntriesSchema,
        'implementation',
      );
      const entries = await store.exclusive(async (entries) => structuredClone(entries));
      assert.equal('plan' in entries[0]!, false);
      assert.equal((await call('context', { plan: 'Current revised plan.' })).status, 'verified');
      const resumed = await call('context', { plan: undefined });
      assert.equal(resumed.status, 'verified');
      assert.doesNotMatch(JSON.stringify(resumed), /HISTORICAL-PLAN|HISTORICAL-ISSUE-SNAPSHOT/);
      assert.ok('evidence' in resumed);
      assert.deepEqual(resumed.evidence, { source: target });
      assert.doesNotMatch(
        JSON.stringify(await store.exclusive(async (entries) => entries)),
        /NATIVE-PLAN-ONLY|Current revised plan/,
      );
    });

  for (const [runtime, skillName] of [
    ['codex', undefined],
    ['codex', 'custom:implement'],
    ['openclaw', undefined],
    ['openclaw', 'custom:implement'],
  ] as const) {
    it(`should inject the ${runtime} ${skillName ? 'custom' : 'built-in'} implementation once and format ordinary output without saving it`, async () => {
      deps.binding.runtime = runtime;
      deps.manifest.github = {
        notifications: { issueAssignment: { implementation: { skill: skillName } } },
      } as AgentManifest['github'];
      const first = await call();
      assert.ok('implementation' in first && first.implementation);
      assert.equal('plan' in first, false);
      assert.equal('assessment' in first, false);
      assert.ok('issueStage' in first);
      assert.equal(first.issueStage, 'implementation');
      assert.equal('resultContract' in first, false);
      assert.ok('publicationAuthorized' in first);
      assert.equal(first.publicationAuthorized, false);
      assert.equal(first.entry, 'direct');
      const delivered = await hydrateImplementation(first, (read) =>
        implementationEntry(read, deps),
      );
      assert.ok(String(delivered.instructions).includes(taskScopeInstructions));
      assert.ok(String(delivered.instructions).includes(implementationReviewInstructions));
      assert.deepEqual(selections, [skillName ?? 'agent-system:agent-system-task-implementation']);
      const resumed = await call('context', {});
      assert.ok('implementation' in resumed);
      assert.deepEqual(resumed.implementation, first.implementation);
      assert.equal(selections.length, 2);
      const saved = await call('result', { result: ready });
      assert.ok('presentation' in saved);
      assert.equal(saved.presentation, ready.fullResult);
      assert.deepEqual('handoff' in saved && saved.handoff, { next: 'complete' });
      deps.turnId = 'followup';
      deps.inputId = 'new-direction';
      const completed = await call('context', {});
      assert.equal(completed.status, 'verified');
      assert.equal('previousResult' in completed, false);
    });
  }
  it('should reject malformed execution and delivery requests before native or provider access', async () => {
    const requests = [
      { operation: 'result', id: 'a'.repeat(64) },
      { operation: 'context', result: ready },
      { operation: 'delivery', id: 'a'.repeat(64) },
      { operation: 'result', id: 'a'.repeat(64), result: ready, scope: 'pull-request' },
    ];
    deps.assertCurrent = async () => {
      throw new Error('native-must-not-run');
    };
    for (const request of requests)
      await assert.rejects(
        implementationEntry({ action: 'implementation', ...request }, deps),
        /implementation-request-invalid/,
      );
    assert.equal(reads, 0);
  });
  it('should explain incorrect context fields in both runtimes without echoing their values', async () => {
    deps.assertCurrent = async () => {
      throw new Error('native-must-not-run');
    };
    for (const runtime of ['codex', 'openclaw'] as const) {
      deps.binding.runtime = runtime;
      await assert.rejects(
        implementationEntry(
          {
            action: 'implementation',
            operation: 'context',
            issue: 'private-target',
            checkout: 'private-checkout',
          },
          deps,
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal('code' in error && error.code, 'implementation-request-invalid');
          assert.match(error.message, /target and path/);
          assert.match(error.message, /without bootstrapping again/);
          assert.doesNotMatch(error.message, /private-/);
          return true;
        },
      );
    }
    assert.equal(reads, 0);
  });
  it('should explain malformed result envelopes in both runtimes before accessing state', async () => {
    deps.assertCurrent = async () => {
      throw new Error('native-must-not-run');
    };
    for (const runtime of ['codex', 'openclaw'] as const) {
      deps.binding.runtime = runtime;
      for (const fields of [
        { summary: 'private-summary', changed: ['private-file'] },
        { result: { outcome: 'done', summary: 'private-summary' } },
        {},
      ])
        await assert.rejects(
          implementationEntry({ action: 'implementation', operation: 'result', ...fields }, deps),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal('code' in error && error.code, 'implementation-request-invalid');
            assert.match(error.message, /outcome, summary and fullResult inside result/);
            assert.doesNotMatch(error.message, /target and path|private-/);
            return true;
          },
        );
    }
    assert.deepEqual(
      parseDirectImplementationRequest({
        action: 'implementation',
        operation: 'result',
        result: ready,
      }).result,
      ready,
    );
    assert.equal(reads, 0);
  });
  it('should retain a missing-plan question and use the later answer without inventing an assessment', async () => {
    const missing = await call('context', { plan: undefined });
    assert.equal(missing.status, 'clarification-needed');
    assert.ok('id' in missing && missing.id);
    assert.equal(selections.length, 0);
    deps.turnId = 'answer';
    deps.inputId = 'answer-input';
    const answered = await call('context', {});
    assert.equal(answered.status, 'verified');
    assert.equal('assessment' in answered, false);
  });
  it('should not treat a native assessment as an explicitly supplied implementation plan', async () => {
    const context = await assessmentEntry(
      { action: 'assessment', operation: 'context', target, path: root },
      deps,
    );
    assert.ok('presentationRequest' in context);
    renderNativeAssessment({
      ...context.presentationRequest,
      result: {
        outcome: 'plan-ready',
        summary: 'Ready',
        reviewSummary: 'Ready for discussion.',
      },
    });
    selections = [];
    const direct = await call('context', { plan: undefined });
    assert.equal(direct.status, 'clarification-needed');
    assert.equal('plan' in direct, false);
    assert.equal(selections.length, 0);
  });
  it('should keep questions in native chat without a clarification checkpoint', async () => {
    const first = await call();
    assert.ok('id' in first);
    const question = {
      outcome: 'clarification-needed',
      summary: 'Need behavior',
      fullResult: 'Partial handler retained.',
      questions: ['Which result?'],
    };
    assert.equal((await call('result', { result: question })).status, 'native');
    assert.equal((await call('context', {})).status, 'verified');
    deps.turnId = 'answer';
    deps.inputId = 'answer-input';
    await assert.rejects(call('result', { result: ready }), /implementation-context-required/);
    const resumed = await call('context', {});
    assert.equal('previousResult' in resumed, false);
    assert.equal(selections.length, 3);
    assert.equal((await call('result', { result: ready })).status, 'native');
  });
  it('should keep ownership failures ahead of provider access and never fall back to manual work', async () => {
    for (const code of [
      'inactive',
      'wrong-session',
      'wrong-target',
      'missing-admission',
      'stale-source',
      'replaced-incarnation',
    ]) {
      deps.managed = async () => {
        throw new Error(code);
      };
      await assert.rejects(call(), new RegExp(code));
    }
    assert.equal(reads, 0);
    assert.equal(selections.length, 0);
  });
  it('should route matching managed work without selecting a manual method or replacing receipts', async () => {
    const skill = await deps.resolveSkill('configured');
    selections = [];
    deps.managed = async () => ({
      digest: 'c'.repeat(64),
      owner: { id: 'd'.repeat(64) },
      path: root,
      selection: {
        version: 1,
        requestedSkill: 'configured',
        defaultSkill: false,
        skill,
        observedAt: 1,
      },
      evidence: '{}',
    });
    const managed = await call();
    assert.equal(managed.status, 'managed');
    assert.ok('owner' in managed);
    assert.deepEqual(managed.owner, { id: 'd'.repeat(64) });
    const originalManaged = deps.managed;
    deps.managed = async (target) => {
      const owner = await originalManaged(target);
      return owner && { ...owner, owner: { id: 'd'.repeat(64), eventId: 'e'.repeat(64) } };
    };
    const feedback = await call();
    assert.ok('owner' in feedback);
    assert.deepEqual(feedback.owner, { id: 'd'.repeat(64), eventId: 'e'.repeat(64) });
    assert.equal(reads, 0);
    assert.equal(selections.length, 0);
  });
  it('should preserve consumed inputs across restart and reject changed targets native custody and publication scope', async () => {
    const first = await call();
    assert.ok('id' in first);
    assert.equal((await call('context', { plan: 'Current plan' })).status, 'verified');
    await assert.rejects(
      call('context', { scope: 'pull-request' }),
      /implementation-scope-new-input-required/,
    );
    await assert.rejects(
      call('delivery', { deliveryOperation: 'prepare' }),
      /implementation-publication-not-authorized/,
    );
    deps.assertCurrent = async () => {
      throw new Error('native-input-changed');
    };
    await assert.rejects(call('result', { result: ready }), /native-input-changed/);
    deps.assertCurrent = async () => {};
    deps.binding.incarnation = 'replacement';
    await assert.rejects(call('result', { result: ready }), /implementation-entry-unavailable/);
    assert.equal((await call('context')).status, 'verified');
  });
  for (const configuration of [
    undefined,
    { skill: 'custom' },
    { guidance: 'Inline rule.' },
    { guidance: { file: 'custom guidance.md' } },
    { skill: 'agent-system:agent-system-task-implementation', guidance: 'Combined rule.' },
  ]) {
    it(`should use existing selector semantics for ${configuration ? JSON.stringify(configuration).toLowerCase() : 'defaults'}`, async () => {
      await writeFile(join(root, 'custom guidance.md'), 'Contained rule.');
      deps.manifest.github = {
        notifications: { issueAssignment: { implementation: configuration } },
      } as AgentManifest['github'];
      const first = await call();
      assert.ok('implementation' in first && first.implementation);
      assert.equal(
        first.implementation.requestedSkill,
        configuration?.skill ?? 'agent-system:agent-system-task-implementation',
      );
      if (typeof configuration?.guidance === 'string')
        assert.ok(first.implementation.guidance?.content);
      else if (configuration?.guidance) {
        assert.equal(first.implementation.guidance?.path, join(root, 'custom guidance.md'));
        assert.equal(first.implementation.guidance?.content, undefined);
        assert.equal(
          await readFile(first.implementation.guidance!.path!, 'utf8'),
          'Contained rule.',
        );
      }
      await call('context', {});
      assert.equal(selections.length, 2);
    });
  }
  it('should retain original implementation authorization when a later operator explicitly requests publication', async () => {
    const context = await call();
    assert.ok('id' in context && typeof context.id === 'string');
    await call('result', { result: ready });
    deps.turnId = 'publication-request';
    deps.inputId = 'publication-input';
    deps.message = 'Now open a pull request for the completed work.';
    const resumed = await call('context', { scope: 'pull-request' });
    assert.equal('deliveryOnly' in resumed && resumed.deliveryOnly, false);
    assert.equal('publicationAuthorized' in resumed && resumed.publicationAuthorized, true);
    const store = new DirectEntryStore(
      deps.root,
      deps.binding,
      implementationEntriesSchema,
      'implementation',
    );
    await store.exclusive(async (entries) => {
      assert.deepEqual(entries[0]!.authorization, { turnId: 'turn', inputId: 'input' });
      assert.deepEqual(entries[0]!.scopeSource, {
        turnId: 'publication-request',
        inputId: 'publication-input',
      });
    });
  });
  it('should recover lost push and pr responses through the same persisted publication without repeated effects', async () => {
    const context = await call('context', { scope: 'pull-request' });
    assert.ok('id' in context && typeof context.id === 'string');
    const result = await call('result', { result: ready });
    assert.equal('handoff' in result && result.handoff?.next, 'delivery');
    let remote = '',
      pushes = 0,
      creates = 0,
      lostPush = true,
      lostCreate = true;
    let receipt: { pullRequestNodeId: string; pullRequestNumber: number } | undefined;
    deps.connectDelivery = async () => ({
      account: {
        identity: { login: 'agent', nodeId: 'U_agent' },
        execute: async () => {
          throw new Error('unexpected provider transport');
        },
      },
      git: async (argv) => {
        if (argv[0] === 'branch') return 'task';
        if (argv[0] === 'check-ref-format' || argv[0] === 'status') return '';
        if (argv[0] === 'rev-list') return '1';
        if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
        if (argv[0] === 'ls-remote') return remote ? `${remote} refs/heads/task` : '';
        if (argv[0] === 'push') {
          pushes++;
          remote = 'a'.repeat(40);
          if (lostPush) {
            lostPush = false;
            throw new Error('lost-push-response');
          }
          return '';
        }
        return argv.includes('--show-toplevel') ? root : 'a'.repeat(40);
      },
    });
    const store = () =>
      new DirectEntryStore(deps.root, deps.binding, implementationEntriesSchema, 'implementation');
    const provider = {
      inspect: async () => receipt,
      publish: async (
        publication: Parameters<
          NonNullable<Parameters<typeof implementationEntryDelivery>[0]['provider']>['publish']
        >[0],
      ) => {
        if (!receipt) {
          await publication.beforeCreate?.();
          creates++;
          receipt = { pullRequestNodeId: 'PR_7', pullRequestNumber: 7 };
          if (lostCreate) {
            lostCreate = false;
            throw new Error('lost-create-response');
          }
        }
        await publication.checkpoint?.(receipt);
        return receipt;
      },
    };
    const perform = (deliveryOperation: 'prepare' | 'publish' | 'reconcile') =>
      store().exclusive(async (entries, save) =>
        implementationEntryDelivery({
          entry: entries[0]!,
          action: {
            action: 'implementation',
            operation: 'delivery',
            deliveryOperation,
            title: 'Implement handler',
            body: 'Verified change. Closes #3',
          },
          deps,
          save,
          provider,
        }),
      );
    const prepared = await perform('prepare');
    assert.equal('digest' in prepared, false);
    assert.equal(await store().exclusive(async (entries) => entries[0]!.delivery), undefined);
    const publishPrepared = () =>
      store().exclusive(async (entries, save) =>
        implementationEntryDelivery({
          entry: entries[0]!,
          action: parseDirectImplementationRequest(
            codexRuntimeRequest(
              'dispatch',
              ['implementation', 'publish', '--plugin-data', '/private/plugin'],
              JSON.parse(JSON.stringify(prepared)),
            ).request,
          ),
          deps,
          save,
          provider,
        }),
      );
    await assert.rejects(publishPrepared(), /lost-push-response/);
    await assert.rejects(publishPrepared(), /lost-create-response/);
    const delivered = await perform('reconcile');
    assert.equal(delivered.status, 'delivered');
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
    await publishPrepared();
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
    assert.equal(
      await store().exclusive(async (entries) => entries[0]!.delivery?.reconciled),
      true,
    );
    const receiptBeforeRestriction = await store().exclusive(async (entries) =>
      structuredClone(entries[0]!.delivery),
    );
    deps.turnId = 'stop-publication';
    deps.inputId = 'restriction-input';
    const stopped = await call('context', { scope: 'local' });
    assert.equal('publicationAuthorized' in stopped && stopped.publicationAuthorized, false);
    assert.deepEqual(
      await store().exclusive(async (entries) => entries[0]!.delivery),
      receiptBeforeRestriction,
    );
    await assert.rejects(publishPrepared(), /implementation-publication-not-authorized/);
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
  });

  it('should reject invalid explicit overrides without falling back to the default', async () => {
    deps.manifest.github = {
      notifications: { issueAssignment: { implementation: { skill: 'missing' } } },
    } as AgentManifest['github'];
    deps.resolveSkill = async (name) => {
      selections.push(name);
      throw new Error('skill-unavailable');
    };
    await assert.rejects(call(), /skill-unavailable/);
    assert.deepEqual(selections, ['missing']);
    deps.manifest.github!.notifications!.issueAssignment!.implementation = {
      guidance: { file: '../outside.md' },
    };
    deps.resolveSkill = async (name) =>
      assessmentSkillSource({ name, path: join(root, 'SKILL.md'), scope: 'user' });
    await assert.rejects(call(), /guidance/);
  });
});

describe('agent/native-implementation-entry', () => {
  let root: string, workspace: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'native-implementation-')));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(root, 'SKILL.md'), '# assessment body without runtime plumbing');
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const git = async (_cwd: string, argv: string[]) =>
    argv[0] === 'remote'
      ? 'https://github.com/owner/repo.git'
      : argv[0] === 'status'
        ? ''
        : argv.includes('--show-toplevel')
          ? workspace
          : 'a'.repeat(40);
  it('should implement in an ordinary codex chat without activation, native creation or managed tools', async () => {
    const { bindCodexWorkspace } = await import('../agent/codex-workspace-binding.ts');
    const { default: codexImplementationEntry } =
      await import('../agent/codex-implementation-entry.ts');
    const home = join(root, 'codex'),
      data = join(root, 'plugin');
    await mkdir(home);
    await writeFile(join(workspace, 'agent.yaml'), 'schema-version: 1\nagent:\n  id: receiver\n');
    await bindCodexWorkspace(data, workspace);
    const calls: string[] = [];
    const fixture = intakeFixture();
    const deps = {
      codexHome: home,
      threadId: 'chat',
      git,
      connect: async () => ({
        ...fixture.client,
        getItemContext: async () => ({
          title: 'Issue',
          body: 'Assess.',
          comments: [],
          labels: [],
          truncated: false,
        }),
      }),
      replyConnection: async () => ({
        request: async (method: string) => {
          calls.push(method);
          if (method === 'thread/read') return { thread: { id: 'chat' } };
          if (method === 'thread/turns/list')
            return { data: [{ id: 'turn', status: 'inProgress' }] };
          if (method === 'thread/items/list')
            return {
              data: [
                {
                  turnId: 'turn',
                  item: {
                    id: 'input',
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'Implement the supplied plan locally.' }],
                  },
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
                      name: 'agent-system:agent-system-task-implementation',
                      path: join(root, 'SKILL.md'),
                      scope: 'user',
                      enabled: true,
                    },
                  ],
                },
              ],
            };
          throw new Error(`unexpected native call ${method}`);
        },
        close: async () => {},
      }),
    };
    const context = await codexImplementationEntry(
      data,
      { action: 'implementation', operation: 'context', target, path: workspace, plan },
      deps,
    );
    assert.ok('id' in context && typeof context.id === 'string');
    const result = await codexImplementationEntry(
      data,
      { action: 'implementation', operation: 'result', target, result: ready },
      deps,
    );
    assert.equal(result.status, 'native');
    assert.deepEqual('handoff' in result && result.handoff, { next: 'complete' });
    assert.equal(calls.filter((name) => name === 'skills/list').length, 1);
    assert.ok(
      !(await readdir(data)).some(
        (name) => name.includes('github-intake') || name.includes('codex-dispatch'),
      ),
    );
  });
  it('should require a verified openclaw operator and retain explicit local scope under work defaults', async () => {
    const { default: OpenClawIntake } = await import('../agent/openclaw-intake.ts');
    const { default: OpenClawDispatch } = await import('../agent/openclaw-dispatch.ts');
    const fixture = intakeFixture();
    const provider = {
      ...fixture.client,
      getItemContext: async () => ({
        title: 'Issue',
        body: 'Assess.',
        comments: [],
        labels: [],
        truncated: false,
      }),
    };
    const manifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'receiver' },
      github: {
        notifications: {
          ...fixture.policy,
          runtimes: ['openclaw'],
          issueAssignment: { ...fixture.policy.issueAssignment!, mode: 'work' },
        },
      },
    };
    const calls: string[] = [];
    const service = new OpenClawDispatch({
      root: join(root, 'dispatch'),
      config: () => ({}),
      intake: new OpenClawIntake({
        root: join(root, 'intake'),
        namespace: root,
        connect: async () => provider,
        manifestService: {
          loadForAgentId: async () => ({
            status: 'loaded' as const,
            manifest,
            scope: { agentId: 'receiver', workspaceDir: workspace },
            path: join(workspace, 'agent.yaml'),
            digest: 'manifest',
            diagnostics: [],
            validationChecks: [],
          }),
        },
      }),
      connect: async () => provider,
      assessmentGit: ({ cwd, argv }) => git(cwd, argv),
      feedbackConnect: async () => provider as never,
      worktrees: {
        prepareGitHub: async () => {
          throw new Error('unexpected preparation');
        },
        inspectGitHub: async () => {
          throw new Error('unexpected setup');
        },
      },
      coordinator: async () => {
        throw new Error('unexpected coordinator');
      },
      credential: {
        use: async (_authority, run) =>
          run(async (method) => {
            calls.push(method);
            if (method === 'chat.history')
              return {
                sessionId: 'session',
                messages: [
                  {
                    role: 'user',
                    content: 'Implement locally.',
                    idempotencyKey: 'turn:user',
                    __openclaw: {
                      id: 'input',
                      idempotencyKey: 'turn:user',
                      runId: 'turn',
                      senderIsOwner: true,
                    },
                  },
                ],
              };
            if (method === 'skills.status')
              return {
                skills: [
                  {
                    name: 'agent-system-task-implementation',
                    filePath: join(root, 'SKILL.md'),
                    source: 'user',
                    eligible: true,
                    modelVisible: true,
                  },
                ],
              };
            throw new Error(`unexpected native call ${method}`);
          }),
      },
    });
    const caller = { sessionKey: 'chat', sessionId: 'session', runId: 'turn', toolCallId: 'call' };
    await assert.rejects(
      service.run(manifest, workspace, caller, {
        action: 'implementation',
        operation: 'context',
        target,
        path: workspace,
        plan,
      }),
      /implementation-operator-required/,
    );
    const context = await service.run(
      manifest,
      workspace,
      caller,
      { action: 'implementation', operation: 'context', target, path: workspace, plan },
      true,
    );
    assert.ok('id' in context && typeof context.id === 'string');
    const result = await service.run(
      manifest,
      workspace,
      caller,
      { action: 'implementation', operation: 'result', target, result: ready },
      true,
    );
    assert.equal(result.status, 'native');
    assert.deepEqual('handoff' in result && result.handoff, { next: 'complete' });
    assert.equal(calls.filter((name) => name === 'skills.status').length, 1);
    assert.ok(
      !(await readdir(join(root, 'dispatch'))).some((name) => name.includes('openclaw-dispatch')),
    );
  });
});
