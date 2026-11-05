import hydrateImplementation, { type Field } from './implementation-material-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assessmentEntry, { type AssessmentEntryDependencies } from '../agent/assessment-entry.ts';
import assessmentSkillSource from '../agent/assessment-skill-source.ts';
import implementationEntry from '../agent/implementation-entry.ts';
import implementationEntryDelivery from '../agent/implementation-entry-delivery.ts';
import { DirectEntryStore } from '../agent/assessment-entry-store.ts';
import { implementationEntriesSchema } from '../agent/implementation-entry-state.ts';
import type { AgentManifest } from '../manifest/types.ts';
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
    it(`should recover oversized ${runtime} retained material without changing scope or consumed inputs`, async () => {
      deps.binding.runtime = runtime;
      const largePlan = 'Complete engineering plan.\n'.repeat(1300);
      const first = await call('context', { plan: largePlan });
      assert.equal(first.status, 'verified');
      assert.ok('publicationAuthorized' in first);
      assert.equal(first.publicationAuthorized, false);
      const store = new DirectEntryStore(
        deps.root,
        deps.binding,
        implementationEntriesSchema,
        'implementation',
      );
      const before = await store.exclusive(async (entries) => structuredClone(entries));
      const count = selections.length;
      const restored = await hydrateImplementation(first, async (request) =>
        implementationEntry(request, deps),
      );
      assert.equal(restored.plan, largePlan);
      assert.equal(restored.publicationAuthorized, false);
      assert.deepEqual(await store.exclusive(async (entries) => entries), before);
      assert.equal(selections.length, count);
      assert.ok('contextMaterials' in first && first.contextMaterials);
      const fields = (first.contextMaterials as { fields: Field[] }).fields;
      const read = fields[0]!.request;
      await assert.rejects(
        implementationEntry({ ...read, id: 'b'.repeat(64) }, deps),
        /implementation-entry-unavailable/,
      );
      const denied = {
        ...deps,
        assertCurrent: async () => {
          throw new Error('current-owner-denied');
        },
      };
      await assert.rejects(implementationEntry(read, denied), /current-owner-denied/);
    });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should inject the configured ${runtime} implementation once and retain ordinary output unchanged`, async () => {
      deps.binding.runtime = runtime;
      const first = await call();
      assert.ok('implementation' in first && first.implementation);
      assert.equal(first.plan, plan);
      assert.equal(first.assessment, undefined);
      assert.equal(first.issueStage, 'implementation');
      assert.equal(first.resultContract, 'implementation-result/v1');
      assert.ok('publicationAuthorized' in first);
      assert.equal(first.publicationAuthorized, false);
      assert.equal(first.entry, 'direct');
      const resumed = await call('context', { id: first.id });
      assert.ok('implementation' in resumed);
      assert.deepEqual(resumed.implementation, first.implementation);
      assert.equal(selections.length, 1);
      const saved = await call('result', { id: first.id, result: ready });
      assert.ok('presentation' in saved);
      assert.equal(saved.presentation, ready.fullResult);
      assert.deepEqual('handoff' in saved && saved.handoff, { next: 'complete' });
      deps.resolveSkill = async () => {
        throw new Error('unexpected selection');
      };
      deps.connectProvider = async () => {
        throw new Error('unexpected provider');
      };
      const completed = await call('context', { id: first.id });
      assert.equal(completed.status, 'presented');
      assert.ok('previousResult' in completed);
      assert.deepEqual(completed.previousResult, ready);
      await assert.rejects(
        call('result', { id: first.id, result: { ...ready, summary: 'Changed' } }),
        /implementation-result-conflict/,
      );
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
  it('should retain a missing-plan question and use the later answer without inventing an assessment', async () => {
    const missing = await call('context', { plan: undefined });
    assert.equal(missing.status, 'clarification-needed');
    assert.ok('id' in missing && missing.id);
    assert.equal(selections.length, 0);
    deps.turnId = 'answer';
    deps.inputId = 'answer-input';
    const answered = await call('context', { id: missing.id });
    assert.equal(answered.status, 'verified');
    assert.ok('assessment' in answered);
    assert.equal(answered.assessment, undefined);
  });
  it('should reuse an actual retained actionable assessment without reassessment', async () => {
    const context = await assessmentEntry(
      { action: 'assessment', operation: 'context', target, path: root },
      deps,
    );
    assert.ok('id' in context);
    await assessmentEntry(
      {
        action: 'assessment',
        operation: 'result',
        id: context.id,
        target,
        result: {
          version: 1,
          outcome: 'plan-ready',
          summary: 'Ready',
          assessment: 'Inspected',
          fullAssessment: 'Complete assessment',
          plan,
          evidence: [],
          progress: { completed: [], remaining: [] },
        },
      },
      deps,
    );
    selections = [];
    const direct = await call('context', { plan: undefined });
    assert.ok('plan' in direct);
    assert.equal(direct.plan, plan);
    assert.equal(selections.length, 1);
  });
  it('should pause questions inside the stage and resume partial work only on a new native input', async () => {
    const first = await call();
    assert.ok('id' in first);
    const question = {
      outcome: 'clarification-needed',
      summary: 'Need behavior',
      fullResult: 'Partial handler retained.',
      questions: ['Which result?'],
    };
    await call('result', { id: first.id, result: question });
    assert.equal((await call('context', { id: first.id })).status, 'clarification-needed');
    await assert.rejects(
      call('result', { id: first.id, result: ready }),
      /implementation-answer-required/,
    );
    deps.turnId = 'answer';
    deps.inputId = 'answer-input';
    await assert.rejects(
      call('result', { id: first.id, result: ready }),
      /implementation-context-required/,
    );
    const resumed = await call('context', { id: first.id });
    assert.ok('previousResult' in resumed);
    assert.deepEqual(resumed.previousResult, question);
    assert.equal(selections.length, 1);
    assert.equal((await call('result', { id: first.id, result: ready })).status, 'recorded');
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
      entries: async (run) => run([], async () => {}),
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
    const feedbackOwner = deps.managed;
    deps.managed = async (target) => {
      const owner = await feedbackOwner(target);
      return owner && { ...owner, implementationResult: ready };
    };
    const read = await call('present', { id: 'd'.repeat(64) });
    assert.equal(read.status, 'presented');
    assert.equal('handoff' in read, false);

    assert.equal(reads, 0);
    assert.equal(selections.length, 0);
  });
  it('should preserve consumed inputs across restart and reject changed targets native custody and publication scope', async () => {
    const first = await call();
    assert.ok('id' in first);
    await assert.rejects(
      call('context', { id: first.id, plan: 'Replace consumed plan' }),
      /implementation-consumed-plan-changed/,
    );
    await assert.rejects(
      call('context', { id: first.id, scope: 'pull-request' }),
      /implementation-scope-new-input-required/,
    );
    await assert.rejects(
      call('delivery', { id: first.id, deliveryOperation: 'prepare' }),
      /implementation-publication-not-authorized/,
    );
    deps.assertCurrent = async () => {
      throw new Error('native-input-changed');
    };
    await assert.rejects(call('result', { id: first.id, result: ready }), /native-input-changed/);
    deps.assertCurrent = async () => {};
    deps.binding.incarnation = 'replacement';
    await assert.rejects(call('context', { id: first.id }), /implementation-entry-unavailable/);
  });
  for (const configuration of [
    undefined,
    { skill: 'custom' },
    { guidance: 'Inline rule.' },
    { guidance: { file: 'guide.md' } },
    { skill: 'agent-system:agent-system-task-implementation', guidance: 'Combined rule.' },
  ]) {
    it(`should use existing selector semantics for ${configuration ? JSON.stringify(configuration).toLowerCase() : 'defaults'}`, async () => {
      await writeFile(join(root, 'guide.md'), 'Contained rule.');
      deps.manifest.github = {
        notifications: { issueAssignment: { implementation: configuration } },
      } as AgentManifest['github'];
      const first = await call();
      assert.ok('implementation' in first && first.implementation);
      assert.equal(
        first.implementation.requestedSkill,
        configuration?.skill ?? 'agent-system:agent-system-task-implementation',
      );
      if (configuration?.guidance) assert.ok(first.implementation.guidance?.content);
      await call('context', { id: first.id });
      assert.equal(selections.length, 1);
    });
  }
  it('should retain original implementation authorization when a later operator explicitly requests publication', async () => {
    const context = await call();
    assert.ok('id' in context);
    await call('result', { id: context.id, result: ready });
    deps.turnId = 'publication-request';
    deps.inputId = 'publication-input';
    deps.message = 'Now open a pull request for the completed work.';
    const resumed = await call('context', { id: context.id, scope: 'pull-request' });
    assert.ok('deliveryOnly' in resumed && resumed.deliveryOnly);
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
      assert.deepEqual(entries[0]!.result, ready);
    });
  });
  it('should recover lost push and pr responses through the same persisted publication without repeated effects', async () => {
    const context = await call('context', { scope: 'pull-request' });
    assert.ok('id' in context);
    const result = await call('result', { id: context.id, result: ready });
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
    const perform = (deliveryOperation: 'prepare' | 'publish' | 'reconcile', digest?: string) =>
      store().exclusive(async (entries, save) =>
        implementationEntryDelivery({
          entry: entries[0]!,
          action: {
            action: 'implementation',
            operation: 'delivery',
            id: context.id,
            deliveryOperation,
            digest,
            title: 'Implement handler',
            body: 'Verified change. Closes #3',
          },
          deps,
          save,
          provider,
        }),
      );
    const prepared = await perform('prepare');
    assert.ok('digest' in prepared);
    await assert.rejects(perform('publish', prepared.digest), /lost-push-response/);
    await assert.rejects(perform('publish', prepared.digest), /lost-create-response/);
    const delivered = await perform('reconcile');
    assert.equal(delivered.status, 'delivered');
    assert.equal(pushes, 1);
    assert.equal(creates, 1);
    await perform('publish', prepared.digest);
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
    const stopped = await call('context', { id: context.id, scope: 'local' });
    assert.equal('publicationAuthorized' in stopped && stopped.publicationAuthorized, false);
    assert.deepEqual(
      await store().exclusive(async (entries) => entries[0]!.delivery),
      receiptBeforeRestriction,
    );
    await assert.rejects(
      perform('publish', prepared.digest),
      /implementation-publication-not-authorized/,
    );
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
    assert.ok('id' in context);
    const result = await codexImplementationEntry(
      data,
      { action: 'implementation', operation: 'result', id: context.id, target, result: ready },
      deps,
    );
    assert.equal(result.status, 'recorded');
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
    assert.ok('id' in context);
    const result = await service.run(
      manifest,
      workspace,
      caller,
      { action: 'implementation', operation: 'result', target, id: context.id, result: ready },
      true,
    );
    assert.equal(result.status, 'recorded');
    assert.deepEqual('handoff' in result && result.handoff, { next: 'complete' });
    assert.equal(calls.filter((name) => name === 'skills.status').length, 1);
    assert.ok(
      !(await readdir(join(root, 'dispatch'))).some((name) => name.includes('openclaw-dispatch')),
    );
  });
});
