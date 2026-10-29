import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assessmentEntry, { type AssessmentEntryDependencies } from '../agent/assessment-entry.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import assessmentOwner from '../agent/assessment-owner.ts';
import assessmentSkillSource from '../agent/assessment-skill-source.ts';
import { automationHash } from '../agent/automation-hash.ts';
import type { AssessmentEntry } from '../agent/assessment-entry-state.ts';
import {
  assessmentResultContextSchema,
  type AssessmentResult,
  type AssessmentSubmission,
} from '../agent/assessment-result.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { intakeFixture } from './github-intake-fixture.ts';

const target = 'https://github.com/owner/repo/issues/3';
const ready = {
  version: 1,
  outcome: 'plan-ready',
  summary: 'Assess only.',
  assessment: 'Recommendation.',
  fullAssessment: 'Complete source and evidence.\n\nFull plan.',
  plan: 'Full plan.',
  reviewSummary: 'A concise review.',
  evidence: [],
  progress: { completed: [], remaining: [] },
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
    it(`should reject incomplete direct ${runtime} results before recording`, async () => {
      deps.binding.runtime = runtime;
      const context = await call('context');
      assert.ok('id' in context);
      await assert.rejects(
        call('result', { id: context.id, result: { ...ready, fullAssessment: undefined } }),
        /assessment-result-incomplete/,
      );
      await assert.rejects(
        call('result', { id: context.id, result: { ...ready, fullAssessment: ' ' } }),
        /assessment-result-incomplete/,
      );
      const unchanged = await call('context');
      assert.ok('previousResult' in unchanged);
      assert.equal(unchanged.previousResult, undefined);
      assert.equal((await call('result', { id: context.id, result: ready })).status, 'recorded');
    });
  it('should select once and retain complete output without workflow authority or invented routing', async () => {
    const context = await call('context');
    assert.ok('id' in context && 'assessment' in context && 'resultSubmission' in context);
    assert.deepEqual(context.resultSchema, assessmentResultContextSchema);
    assert.deepEqual(context.resultSubmission.request, {
      action: 'assessment',
      operation: 'result',
      id: context.id,
      target,
    });
    assert.deepEqual(context.resultSubmission.refreshRequest, {
      action: 'assessment',
      operation: 'context',
      id: context.id,
      target,
    });
    assert.equal(context.assessment!.requestedSkill, 'agent-system:agent-system-task-assessment');
    assert.equal((await call('context')).status, 'verified');
    assert.equal(selections.length, 1);
    const result = await assessmentEntry(
      {
        ...context.resultSubmission.request,
        result: {
          ...ready,
          decision: { mode: 'work', reasons: ['Model recommendation is not permission.'] },
        },
      },
      deps,
    );
    assert.equal(result.status, 'recorded');
    assert.deepEqual('handoff' in result && result.handoff, { next: 'assessment-only' });
    assert.ok('presentation' in result && !result.presentation!.includes('Continue automatically'));
    assert.ok('presentation' in result && !result.presentation!.includes('Model routing'));
    const recovered = await call('context');
    assert.equal(recovered.status, 'presented');
    assert.ok('currentTurnId' in recovered && 'previousResultTurnId' in recovered);
    assert.equal(recovered.currentTurnId, recovered.previousResultTurnId);
    assert.deepEqual(
      'previousResult' in recovered && recovered.previousResult?.fullAssessment,
      ready.fullAssessment,
    );
    assert.equal(selections.length, 1);
    assert.ok(
      !(await readdir(deps.root)).some(
        (name) => name.includes('dispatch') || name.includes('intake'),
      ),
    );
  });
  it('should present retained source without provider access or another checkout inspection', async () => {
    const context = await call('context');
    assert.ok('id' in context);
    await call('result', { id: context.id, result: ready });
    deps.connectProvider = async () => {
      throw new Error('provider unavailable');
    };
    deps.git = async () => {
      throw new Error('checkout unavailable');
    };
    const restored = await call('context');
    assert.equal(restored.status, 'presented');
    const full = await assessmentEntry(
      { action: 'assessment', operation: 'present', id: context.id, includeDetails: true },
      deps,
    );
    assert.ok('presentation' in full && full.presentation!.includes(ready.fullAssessment!));
  });
  it('should retain questions then revise with a later native answer and exact previous digest', async () => {
    const first = await call('context');
    assert.ok('id' in first);
    const question: AssessmentResult = {
      version: 1,
      outcome: 'clarification-needed',
      summary: 'Need a decision.',
      assessment: 'Partial assessment.',
      fullAssessment: 'Partial work retained.',
      questions: ['Which behavior?'],
      evidence: [],
      progress: { completed: ['Inspected code.'], remaining: ['Answer.'] },
    };
    await call('result', { id: first.id, result: question });
    deps.turnId = 'answer';
    deps.inputId = 'answer-input';
    await assert.rejects(
      call('result', { id: first.id, result: ready }),
      /assessment-context-required/,
    );
    const revised = await call('context', { id: first.id, revise: true });
    assert.ok('previousResultDigest' in revised);
    await assert.rejects(
      call('result', { id: first.id, result: ready }),
      /assessment-result-conflict/,
    );
    await call('result', {
      id: first.id,
      result: ready,
      previousResultDigest: revised.previousResultDigest,
    });
    const full = await call('present', { id: first.id, includeDetails: true });
    assert.ok('presentation' in full && full.presentation!.includes(ready.fullAssessment!));
  });
  it('should reject checkout changes, malformed output and changed native custody without overwriting a result', async () => {
    const first = await call('context');
    assert.ok('id' in first);
    revision = 'b'.repeat(40);
    await assert.rejects(
      call('result', { id: first.id, result: ready }),
      /assessment-checkout-changed/,
    );
    revision = 'a'.repeat(40);
    await call('result', { id: first.id, result: ready });
    await assert.rejects(
      call('result', { id: first.id, result: { ...ready, progress: [] } }),
      /assessment-result-invalid/,
    );
    const correction = await call('context');
    assert.ok('previousResult' in correction);
    assert.deepEqual(correction.previousResult, ready);
    assert.equal((await call('result', { id: first.id, result: ready })).status, 'recorded');
    await assert.rejects(
      call('result', { id: first.id, result: { ...ready, fullAssessment: 'x'.repeat(96001) } }),
      /assessment-result-invalid/,
    );
    deps.assertCurrent = async () => {
      throw new Error('native-input-changed');
    };
    await assert.rejects(call('context'), /native-input-changed/);
    deps.assertCurrent = async () => {};
    const read = await call('context');
    assert.ok('previousResult' in read);
    assert.equal(read.previousResult?.fullAssessment, ready.fullAssessment);
  });
  it('should reuse matching managed result and receipt without selecting or changing lifecycle state', async () => {
    const selection = await deps.resolveSkill('configured');
    selections = [];
    const managed = {
      digest: 'c'.repeat(64),
      path: root,
      selection: {
        version: 1 as const,
        requestedSkill: 'configured',
        defaultSkill: false,
        skill: selection,
        observedAt: 1,
      },
      evidence: '{}',
      result: ready,
      receipt: { original: true },
      entries: async <T>(
        run: (entries: AssessmentEntry[], save: () => Promise<void>) => Promise<T>,
      ) => run([], async () => {}),
    };
    deps.managed = async () => managed;
    const retained = await call('context');
    assert.equal(retained.status, 'presented');
    assert.deepEqual('receipt' in retained && retained.receipt, managed.receipt);
    assert.equal(selections.length, 0);
    const entries: AssessmentEntry[] = [];
    managed.entries = async (run) => run(entries, async () => {});
    const revision = await call('context', { revise: true });
    assert.ok('id' in revision);
    await call('result', {
      id: revision.id,
      result: { ...ready, fullAssessment: 'Revised assessment only.' },
      previousResultDigest: automationHash(ready),
    });
    assert.equal(managed.result, ready);
    assert.equal(entries[0]!.result!.fullAssessment, 'Revised assessment only.');
    assert.equal(selections.length, 0);
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
    assert.ok('project' in context);
    assert.equal(context.project.dirty, true);
    deps.turnId = 'later';
    deps.inputId = 'later-input';
    deps.resolveSkill = async () => {
      throw new Error('selected-skill-unavailable');
    };
    await assert.rejects(call('context', { revise: true }), /selected-skill-unavailable/);
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
      assert.ok('assessment' in selected);
      assert.equal(
        selected.assessment!.requestedSkill,
        configuration?.skill ?? 'agent-system:agent-system-task-assessment',
      );
      assert.equal(
        selected.assessment!.guidance?.content,
        typeof configuration?.guidance === 'string'
          ? 'Inline guidance.'
          : configuration?.guidance
            ? 'File guidance.'
            : undefined,
      );
      assert.equal(selected.mode, 'plan');
      await call('context');
      assert.equal(selections.length, index + 1);
    }
    deps.binding.session = 'invalid-guidance';
    deps.manifest.github!.notifications!.issueAssignment!.assessment = {
      guidance: { file: 'missing.md' },
    };
    await assert.rejects(call('context'), /guidance/);
    assert.equal(selections.length, variants.length + 1);
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
    for (const field of ['retired', 'retirement', 'reset']) {
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
    const { bindCodexWorkspace } = await import('../agent/codex-workspace-binding.ts');
    const { default: codexAssessmentEntry } = await import('../agent/codex-assessment-entry.ts');
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
    assert.ok('id' in context);
    const result = await codexAssessmentEntry(
      data,
      { action: 'assessment', operation: 'result', id: context.id, target, result: ready },
      deps,
    );
    assert.equal(result.status, 'recorded');
    assert.deepEqual('handoff' in result && result.handoff, { next: 'assessment-only' });
    assert.equal(calls.filter((name) => name === 'skills/list').length, 1);
    assert.ok(
      !(await readdir(data)).some(
        (name) => name.includes('github-intake') || name.includes('codex-dispatch'),
      ),
    );
  });
  it('should require a verified openclaw operator and remain assessment-only under work defaults', async () => {
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
    assert.ok('id' in context);
    const result = await service.run(
      manifest,
      workspace,
      caller,
      { action: 'assessment', operation: 'result', target, id: context.id, result: ready },
      true,
    );
    assert.equal(result.status, 'recorded');
    assert.deepEqual('handoff' in result && result.handoff, { next: 'assessment-only' });
    assert.equal(calls.filter((name) => name === 'skills.status').length, 1);
    assert.ok(
      !(await readdir(join(root, 'dispatch'))).some((name) => name.includes('openclaw-dispatch')),
    );
  });
});
