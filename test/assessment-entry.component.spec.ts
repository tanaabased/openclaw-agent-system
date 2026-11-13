import composeResponseBlocks from '../channels/github/presentation/response-blocks.ts';
import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import renderNativeAssessment from '../agent/tasks/assessment/assessment-render.ts';
import { conversationExampleScenario } from '../examples/openclaw-issue-conversation/model-fixture.ts';

import assessmentEntry, {
  type AssessmentEntryDependencies,
} from '../agent/tasks/assessment/assessment-entry.ts';
import assessmentOwner from '../agent/tasks/assessment/assessment-owner.ts';
import {
  assessmentResultFormat,
  type AssessmentSubmission,
} from '../agent/tasks/assessment/assessment-result.ts';
import assessmentSkillSource from '../agent/tasks/assessment/assessment-skill-source.ts';
import { nativeIssueContext } from '../agent/tasks/context/native-issue-context.ts';
import type { SharedDispatchRecord } from '../agent/tasks/dispatch/dispatch-state.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { intakeFixture } from './github-intake-fixture.ts';

import hydrateImplementation from './implementation-material-fixture.ts';
const target = 'https://github.com/owner/repo/issues/3';
const ready = {
  outcome: 'plan-ready',
  summary: 'Assess only.',
  reviewSummary: 'A concise review.',
} satisfies AssessmentSubmission;
describe('agent/assessment-entry', () => {
  let root: string, deps: AssessmentEntryDependencies, selections: string[], reads: string[];
  let dirty: boolean, revision: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'assessment-entry-')));
    await writeFile(join(root, 'SKILL.md'), '# ordinary assessment');
    selections = [];
    reads = [];
    dirty = false;
    revision = 'a'.repeat(40);
    const fixture = intakeFixture();
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
      manifest: { agent: { id: 'receiver' } } as AgentManifest,
      now: 1,
      git: async (_cwd, argv) => {
        reads.push(argv[0]!);
        if (argv[0] === 'remote') return 'git@github.com:owner/repo.git';
        if (argv[0] === 'status') return dirty ? ' M file.ts' : '';
        return argv.includes('--show-toplevel') ? root : revision;
      },
      connectProvider: async () => {
        assert.ok(reads.length);
        return {
          ...fixture.client,
          getItemContext: async () => ({
            title: 'Issue',
            body: 'Complete issue.',
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
      assertCurrent: async () => {},
      managed: async () => undefined,
    };
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));
  const call = (operation: string, extra: object = {}) =>
    assessmentEntry({ action: 'assessment', operation, target, path: root, ...extra }, deps);
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should deliver direct assessment references without prefetching issue content in ${runtime}`, async () => {
      deps.binding.runtime = runtime;
      const connect = deps.connectProvider;
      deps.connectProvider = async () => ({
        ...(await connect()),
        getItemContext: async () => {
          throw new Error('assessment must read GitHub natively');
        },
      });
      const request = { action: 'assessment', operation: 'context', target, path: root };
      const run = (read: Record<string, unknown>) => assessmentEntry(read, deps);
      const verify = (complete: Record<string, unknown>) => {
        assert.deepEqual(complete.evidence, { source: target });
        assert.equal('contextMaterials' in complete, false);
        assert.deepEqual(complete.resultFormat, assessmentResultFormat);
        assert.equal(typeof complete.instructions, 'string');
      };
      verify(await hydrateImplementation(await run(request), run));
      await assert.rejects(readdir(deps.root), { code: 'ENOENT' });
    });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should preserve delivered ${runtime} planning facts when skill lookup fails`, async () => {
      deps.binding.runtime = runtime;
      const nativeContext = nativeIssueContext({
        id: 'delivered',

        worktree: root,
      });
      const before = structuredClone(nativeContext);
      deps.managed = async () => ({
        digest: 'c'.repeat(64),
        path: root,
        nativeContext,
      });
      deps.resolveSkill = async () => {
        throw new Error('PRIVATE skill failure');
      };
      const complete = await hydrateImplementation(await call('context'), (read) =>
        assessmentEntry(read, deps),
      );
      assert.equal(complete.status, 'native');
      assert.deepEqual(complete.project, { path: root });
      assert.deepEqual(complete.evidence, { source: target });
      assert.equal(complete.assessment, undefined);
      assert.deepEqual(complete.contextLimitations, [
        { scope: 'assessment', code: 'workflow-guidance-unavailable' },
      ]);
      assert.doesNotMatch(JSON.stringify(complete), /PRIVATE/);
      assert.deepEqual(nativeContext, before);
      deps.assertCurrent = async () => {
        throw new Error('native-owner-changed');
      };
      await assert.rejects(call('context'), /native-owner-changed/);
    });
  }
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should keep post-delivery ${runtime} planning native without creating or revising an assessment`, async () => {
      deps.binding.runtime = runtime;
      const skill = await deps.resolveSkill('configured');
      selections = [];
      const nativeContext = nativeIssueContext({
        id: 'delivered',

        worktree: root,
      });
      const before = structuredClone(nativeContext);
      deps.managed = async () => ({
        digest: 'c'.repeat(64),
        path: root,
        evidence: '{}',
        result: ready,
        selection: {
          version: 1,
          requestedSkill: 'configured',
          defaultSkill: false,
          skill,
          observedAt: 1,
        },
        nativeContext,
        selections: { assessment: { skill: 'current-override' } },
      });
      deps.git = async () => {
        throw new Error('native planning must not inspect managed checkout');
      };
      const provider = intakeFixture().client;
      deps.connectProvider = async () => ({
        ...provider,
        getItemContext: async () => ({
          title: 'Current issue',
          body: 'CURRENT REQUIREMENT',
          comments: [],
          labels: [],
          truncated: false,
        }),
      });
      for (const request of [
        { operation: 'context' },
        { operation: 'render', result: { ...ready, plan: 'Revised plan.' } },
      ]) {
        const response = await call(request.operation, request);
        if (request.operation === 'context') {
          const complete = await hydrateImplementation(response, (read) =>
            assessmentEntry(read, deps),
          );
          assert.equal(complete.status, 'native');
          assert.deepEqual(complete.evidence, { source: target });
          assert.equal(
            (complete.assessment as { requestedSkill: string }).requestedSkill,
            'current-override',
          );
          assert.equal('previousResult' in complete, false);
          if (runtime === 'openclaw') {
            // feed the real native response into the CI conversation driver, not a copied status fixture.
            const conversation: ChatCompletionRequest = {
              model: 'gpt-5.5',
              messages: [
                { role: 'system', content: 'Name: Notification Tanaabot' },
                {
                  role: 'user',
                  content: `Direct issue assessment target: ${target} checkout: ${root}`,
                },
              ],
              tools: ['agent_system_dispatch', 'agent_system_github', 'read'].map((name) => ({
                type: 'function',
                function: { name },
              })),
            };
            let rendered = '';
            let completed = false;
            let rejected = 0;
            for (let step = 0; step < 8; step++) {
              const fixture = matchFixture([...conversationExampleScenario.fixtures], conversation);
              assert.ok(fixture);
              const response =
                typeof fixture.response === 'function'
                  ? await fixture.response(conversation)
                  : fixture.response;
              if (!('toolCalls' in response) || !response.toolCalls?.length) {
                assert.deepEqual(response, { content: rendered });
                completed = true;
                break;
              }
              const tool = response.toolCalls[0]!;
              assert.ok(tool.id);
              const args = JSON.parse(tool.arguments);
              let output: unknown;
              if (tool.name === 'read') output = await readFile(args.path, 'utf8');
              else if (tool.name === 'agent_system_github')
                output = {
                  exitCode: 0,
                  truncated: false,
                  stdout: JSON.stringify({ body: 'Current issue requirement.', comments: [] }),
                };
              else if (args.operation === 'context') output = complete;
              else {
                assert.equal(args.operation, 'render');
                try {
                  const result = renderNativeAssessment(args, runtime);
                  assert.equal(result.status, 'formatted');
                  assert.equal(result.retained, false);
                  assert.ok('responseBlocks' in result);
                  rendered = composeResponseBlocks(result.responseBlocks);
                  output = result;
                } catch (error) {
                  assert.ok(error instanceof Error && error.message.includes('result.summary'));
                  rejected++;
                  output = error.message;
                }
              }
              conversation.messages.push(
                {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: tool.id,
                      type: 'function',
                      function: { name: tool.name, arguments: tool.arguments },
                    },
                  ],
                },
                {
                  role: 'tool',
                  tool_call_id: tool.id,
                  content: typeof output === 'string' ? output : JSON.stringify(output),
                },
              );
            }
            assert.equal(completed, true);
            assert.equal(rejected, 1);
            assert.ok(rendered.includes('Plan ready'));
          }
        } else assert.deepEqual(response, before);
        assert.equal('resultSubmission' in response, false);
      }
      assert.ok(selections.length > 0);
      assert.deepEqual(
        await readdir(deps.root).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        }),
        [],
      );
    });
  it('should fail explicitly on invalid managed context without selecting a manual method', async () => {
    deps.managed = async () => {
      throw new Error('assessment-managed-context-invalid');
    };
    await assert.rejects(call('context'), /assessment-managed-context-invalid/);
    assert.equal(selections.length, 0);
    assert.equal(reads.length, 0);
  });
  it('should reject non-issue targets and report missing checkout rather than prepare one', async () => {
    await assert.rejects(
      call('context', { target: 'https://github.com/owner/repo/pull/3' }),
      /assessment-issue-url-required/,
    );
    const missing = await assessmentEntry(
      { action: 'assessment', operation: 'context', target },
      deps,
    );
    assert.equal(missing.status, 'clarification-needed');
    assert.equal(selections.length, 0);
  });
  it('should preserve dirty checkout evidence and reject an invalid configured skill without fallback', async () => {
    dirty = true;
    const context = await call('context');
    assert.ok(
      'project' in context &&
        context.project &&
        typeof context.project === 'object' &&
        'dirty' in context.project,
    );
    assert.equal(context.project.dirty, true);
    deps.turnId = 'later';
    deps.inputId = 'later-input';
    deps.resolveSkill = async () => {
      throw new Error('selected-skill-unavailable');
    };
    await assert.rejects(call('context'), /selected-skill-unavailable/);
  });
  it('should honor all existing override forms and reject invalid explicit guidance without fallback', async () => {
    await writeFile(join(root, 'guidance.md'), 'File guidance.');
    const variants = [
      undefined,
      { skill: 'custom' },
      { guidance: 'Inline guidance.' },
      { guidance: { file: 'guidance.md' } },
      { skill: 'custom', guidance: 'Inline guidance.' },
      { skill: 'custom', guidance: { file: 'guidance.md' } },
      { skill: 'agent-system:agent-system-task-assessment' },
    ];
    for (const [index, configuration] of variants.entries()) {
      deps.binding.session = `configuration-${index}`;
      const fixture = intakeFixture();
      deps.manifest = {
        schemaVersion: 1,
        agent: { id: 'receiver' },
        github: {
          username: 'receiver',
          notifications: {
            ...fixture.policy,
            issueAssignment: { allowed: [], mode: 'work', assessment: configuration },
          },
        },
      } as AgentManifest;
      const selected = await call('context');
      assert.ok('presentationRequest' in selected);
      assert.equal(
        selected.assessment!.requestedSkill,
        configuration?.skill ?? 'agent-system:agent-system-task-assessment',
      );
      assert.equal(
        selected.assessment!.guidance?.content,
        typeof configuration?.guidance === 'string' ? 'Inline guidance.' : undefined,
      );
      if (configuration?.guidance && typeof configuration.guidance !== 'string') {
        assert.equal(selected.assessment!.guidance?.path, join(root, 'guidance.md'));
      }
      assert.equal(selected.mode, 'plan');
      await call('context');
      assert.equal(selections.length, (index + 1) * 2);
    }
    deps.binding.session = 'invalid-guidance';
    deps.manifest.github!.notifications!.issueAssignment!.assessment = {
      guidance: { file: 'missing.md' },
    };
    await assert.rejects(call('context'), /guidance/);
    assert.equal(selections.length, variants.length * 2 + 1);
  });
  it('should resolve managed ownership from state, rejecting stale, missing and other-session owners', () => {
    const fixture = intakeFixture();
    const admitted = [
      { id: 'admitted', repository: fixture.repository, issue: fixture.item },
    ] as never;
    const record = {
      id: 'managed',
      intakeId: 'admitted',
      threadId: 'chat',
      request: {},
      context: '{}',
      assessment: {},
      worktree: root,
    } as unknown as SharedDispatchRecord;
    const target = { repository: 'owner/repo', number: 3 };
    assert.equal(assessmentOwner([], [], 'chat', target), undefined);
    assert.equal(assessmentOwner([record], admitted, 'chat', target)?.record, record);
    assert.throws(
      () => assessmentOwner([record], [], 'chat', target),
      /assessment-managed-admission-missing/,
    );
    assert.throws(
      () => assessmentOwner([record], admitted, 'other-chat', target),
      /assessment-managed-context-invalid/,
    );
    assert.throws(
      () => assessmentOwner([record], admitted, 'chat', { ...target, number: 4 }),
      /assessment-managed-target-mismatch/,
    );
    assert.throws(
      () => assessmentOwner([record, record], admitted, 'chat', target),
      /assessment-managed-owner-ambiguous/,
    );
    assert.equal(
      assessmentOwner([{ ...record, nativeInactive: true }], admitted, 'chat', target)?.record.id,
      record.id,
    );
    for (const field of ['retirement', 'reset']) {
      assert.throws(
        () => assessmentOwner([{ ...record, [field]: true }], admitted, 'chat', target),
        /assessment-managed-context-invalid/,
      );
    }
  });
});

describe('agent/native-assessment-entry', () => {
  let root: string, workspace: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'native-assessment-')));
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
  it('should assess in an ordinary codex chat without activation, native creation or managed tools', async () => {
    const { bindCodexWorkspace } = await import('../agent/identity/codex-workspace-binding.ts');
    const { default: codexAssessmentEntry } =
      await import('../agent/tasks/assessment/codex-assessment-entry.ts');
    const { runCodexDispatch } = await import('../agent/tasks/dispatch/codex-dispatch.ts');
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
                    content: [{ type: 'text', text: 'Assess this issue only.' }],
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
                      name: 'agent-system:agent-system-task-assessment',
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
    const context = await codexAssessmentEntry(
      data,
      { action: 'assessment', operation: 'context', target, path: workspace },
      deps,
    );
    assert.equal('id' in context, false);
    assert.ok('presentationRequest' in context && context.presentationRequest);
    const result = await runCodexDispatch(
      data,
      'assessment',
      { ...context.presentationRequest, result: ready },
      deps,
    );
    assert.ok(result && 'status' in result);
    assert.equal(result.status, 'formatted');
    assert.equal('handoff' in result, false);
    assert.equal('cards' in context.presentationRequest, false);
    assert.ok(
      !(await readdir(data)).some(
        (name) => name.includes('github-intake') || name.includes('codex-dispatch'),
      ),
    );
  });
  it('should require a verified openclaw operator and remain assessment-only under work defaults', async () => {
    const { default: OpenClawIntake } = await import('../agent/openclaw-intake.ts');
    const { default: OpenClawDispatch } =
      await import('../agent/tasks/dispatch/openclaw-dispatch.ts');
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
    const intake = new OpenClawIntake({
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
    });
    const service = new OpenClawDispatch({
      root: join(root, 'dispatch'),
      config: () => ({}),
      intake,
      taskContext: intake.dependencies,
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
                    content: 'Assess only.',
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
                    name: 'agent-system-task-assessment',
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
        action: 'assessment',
        operation: 'context',
        target,
        path: workspace,
      }),
      /assessment-operator-required/,
    );
    const context = await service.run(
      manifest,
      workspace,
      caller,
      { action: 'assessment', operation: 'context', target, path: workspace },
      true,
    );
    assert.equal('id' in context, false);
    assert.ok('presentationRequest' in context && context.presentationRequest);
    const result = await service.run(
      manifest,
      workspace,
      caller,
      { ...context.presentationRequest, result: ready },
      true,
    );
    assert.equal(result.status, 'formatted');
    assert.equal('handoff' in result, false);
    assert.equal('cards' in context.presentationRequest, false);
    await assert.rejects(readdir(join(root, 'dispatch')), { code: 'ENOENT' });
  });
});
