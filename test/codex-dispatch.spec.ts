import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCodexDispatch, type CodexDispatchDependencies } from '../agent/codex-dispatch.ts';
import type { DispatchNativeThread } from '../agent/codex-dispatch-native.ts';
import { runCodexIntake } from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { baseline, intakeFixture } from './github-intake-fixture.ts';

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
  async function prepare() {
    const selected = await next();
    assert.equal(selected.status, 'routing-required');
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
        if (argv[0] === 'rev-parse') return commit;
        return '';
      },
      native: {
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
    assert.equal(blocked.code, 'dispatch-project-missing');
    assert.equal(blocked.changed, true);
    assert.match(String(blocked.message), /https:\/\/github.com\/owner\/repo\/issues\/3/u);
    assert.match(String(blocked.message), /https:\/\/github.com\/receiver/u);
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

  it('should emit one exact launch and recover uncertain creation instead of issuing another', async () => {
    const prepared = await prepare();
    const launch = prepared.request as {
      model: string;
      thinking: string;
      target: { projectId: string; environment: { startingState: { branchName: string } } };
    };
    assert.equal(launch.model, 'gpt-6.1-sol');
    assert.equal(launch.thinking, 'high');
    assert.equal(launch.target.projectId, 'saved-project');
    assert.equal(launch.target.environment.startingState.branchName, commit);
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
    assert.equal((await request('result', { id: prepared.id, result }, child)).status, 'recorded');
    assert.equal((await next()).outcome, 'plan-ready');
    assert.deepEqual(await next(), { status: 'idle', changed: false });
    assert.equal((await request('result', { id: prepared.id, result }, child)).status, 'recorded');
    await assert.rejects(
      request('result', { id: prepared.id, result: { ...result, plan: 'Changed.' } }, child),
      /assessment-result-already-recorded/,
    );
    native!.turnId = 'user-follow-up';
    assert.equal(
      (
        await request(
          'result',
          { id: prepared.id, result: { ...result, plan: 'Refined after clarification.' } },
          child,
        )
      ).status,
      'recorded',
    );
    assert.equal((await next()).changed, true);
    assert.deepEqual(await next(), { status: 'idle', changed: false });
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

  it('should offer one title repair and retain a missing-result failure without another launch', async () => {
    const prepared = await prepare();
    created();
    native!.name = 'a normalized native title';
    const blocked = await request('reconcile', { id: prepared.id });
    assert.deepEqual(blocked.repair, {
      threadId: 'issue-thread',
      title: '#3: REPAIR CONTAINED BEHAVIOR',
    });
    assert.equal((await request('reconcile', { id: prepared.id })).repair, undefined);
    native!.name = '#3: REPAIR CONTAINED BEHAVIOR';
    native!.turnStatus = 'failed';
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
