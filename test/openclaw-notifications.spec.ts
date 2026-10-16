import assert from 'node:assert/strict';

import { createCliStyles } from '../cli/output.ts';

import { issueKey } from '../agent/dispatch-pending.ts';
import assignmentIntakePolicy from '../agent/assignment-intake-policy.ts';
import OpenClawNotifications from '../agent/openclaw-notifications.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';
import refresh from '../channels/github/cli/refresh.ts';
import status from '../channels/github/cli/status.ts';
import wait from '../channels/github/cli/wait.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { intakeFixture, baseline } from './github-intake-fixture.ts';

const selector = { itemType: 'issue' as const, repository: 'owner/repo', number: 3 };
function fixture() {
  const provider = intakeFixture();
  const manifest: AgentManifest = {
    schemaVersion: 1,
    agent: { id: 'receiver' },
    github: {
      username: 'receiver',
      notifications: { ...provider.policy, runtimes: ['openclaw'] },
    },
  };
  const selected = assignmentIntakePolicy(manifest, 'openclaw')!;
  let state: IntakeState | undefined = {
    version: 1,
    scope: 'scope',
    workspaceDir: '/workspace',
    agentId: 'receiver',
    account: { login: 'receiver', nodeId: 'U_receiver' },
    policyDigest: selected.digest,
    baselineAt: baseline,
    checkpoint: baseline + 1,
    records: [
      {
        version: 1,
        id: 'intake',
        scope: 'scope',
        receiving: { login: 'receiver', nodeId: 'U_receiver' },
        workspaceDir: '/workspace',
        agentId: 'receiver',
        host: 'github.com',
        repository: provider.repository,
        issue: { nodeId: provider.item.nodeId, databaseId: provider.item.databaseId, number: 3 },
        assignment: { ...provider.events[0]!, event: 'assigned' },
        evidence: {
          policyDigest: selected.digest,
          mode: 'plan',
          open: true,
          assigned: true,
          repositoryReadable: true,
          ownerPinned: true,
          actorPinned: true,
        },
        observedAt: baseline + 1,
        admittedAt: baseline + 1,
        status: 'admitted',
        requiresRevalidation: true,
      },
    ],
  };
  const records: OpenClawDispatchRecord[] = [];
  let requests = 0;
  let now = baseline;
  const service = new OpenClawNotifications({
    root: '/unused',
    intake: {
      async select(value) {
        return {
          selected: assignmentIntakePolicy(value, 'openclaw'),
          store: {
            location: { scope: 'scope' },
            async read() {
              return state;
            },
          },
        };
      },
    },
    async readDispatch() {
      return { records };
    },
    async inspectRun() {
      return 'pending' as const;
    },
    async requestRun(_manifest, _workspace, signal) {
      signal.throwIfAborted();
      requests++;
      return { status: 'queued', runId: 'native-run' };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  });
  return {
    manifest,
    service,
    records,
    get state() {
      return state;
    },
    set state(value) {
      state = value;
    },
    get requests() {
      return requests;
    },
  };
}
function record(): OpenClawDispatchRecord {
  return {
    id: 'a'.repeat(64),
    intakeId: 'intake',
    issueKey: 'b'.repeat(64),
    sourceThreadId: 'coordinator',
    phase: 'routing',
    createdAt: baseline,
    manifestDigest: 'digest',
  };
}

describe('agent/openclaw-notifications', () => {
  it('should inspect native admission and capacity without running intake or exposing provider prose', async () => {
    const f = fixture();
    const result = await f.service.inspect(f.manifest, '/workspace', selector);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.capacity, { active: 0, queued: 1, limit: 2 });
    assert.equal(result.items[0]?.workflow?.phase, 'queued');
    assert.equal(result.items[0]?.stage, 'admitted');
    assert.equal(f.requests, 0);
    assert.equal(JSON.stringify(result).includes('policyDigest'), false);
  });

  it('should distinguish creation uncertainty preparation assessment and retained plan completion', async () => {
    const f = fixture();
    const r = record();
    r.issueKey = issueKey(f.state!.records[0]!);
    f.records.push(r);
    r.phase = 'creating';
    assert.equal(
      (await f.service.inspect(f.manifest, '/workspace')).items[0]?.workflow?.phase,
      'uncertain',
    );
    r.phase = 'created';
    r.worktree = '/worktree';
    r.threadId = 'issue-chat';
    r.sessionCreation = {
      attempted: true,
      sourceSessionId: 'coordinator',
      sourceRunId: 'run',
      sourceToolCallId: 'tool',
      sessionId: 'session',
      verified: true,
    };
    let result = await f.service.wait(f.manifest, '/workspace', {
      selector,
      target: 'prepared',
      timeoutMs: 1,
      refresh: false,
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.observation.items[0]?.workflow?.conversation, 'issue-chat');
    delete r.sessionCreation;
    r.native = {
      sessionKey: 'issue-chat',
      sessionId: 'session',
      runId: 'run',
      sourceSessionId: 'coordinator',
      toolCallId: 'tool',
    };
    r.effective = { status: 'verified' };
    r.setupComplete = true;
    result = await f.service.wait(f.manifest, '/workspace', {
      selector,
      target: 'prepared',
      timeoutMs: 1,
      refresh: false,
    });
    assert.equal(
      result.status,
      'completed',
      'retained verified native bindings must remain observable',
    );

    r.phase = 'assessing';
    result = await f.service.wait(f.manifest, '/workspace', {
      selector,
      target: 'plan-ready',
      timeoutMs: 1,
      refresh: false,
    });
    assert.equal(result.status, 'timed-out');
    r.phase = 'complete';
    r.result = {
      version: 1,
      outcome: 'plan-ready',
      summary: 'summary',
      assessment: 'assessment',
      plan: 'plan',
      evidence: [],
      progress: { completed: [], remaining: [] },
    };
    result = await f.service.wait(f.manifest, '/workspace', {
      selector,
      target: 'plan-ready',
      timeoutMs: 1,
      refresh: false,
    });
    assert.equal(result.status, 'completed');
  });

  it('should report blocked and unreadable state as failure rather than an empty successful scan', async () => {
    const f = fixture();
    f.records.push({
      ...record(),
      issueKey: issueKey(f.state!.records[0]!),
      phase: 'blocked',
      blocker: 'dispatch-native-session-diverged',
    });
    const blocked = await f.service.wait(f.manifest, '/workspace', {
      selector,
      target: 'prepared',
      timeoutMs: 1,
      refresh: false,
    });
    assert.equal(blocked.status, 'failed');
    assert.equal(blocked.code, 'dispatch-native-session-diverged');
    f.service.dependencies.readDispatch = async () => {
      throw Error('unreadable private data');
    };
    assert.equal(
      (await f.service.inspect(f.manifest, '/workspace')).code,
      'github-notification-native-state-unavailable',
    );
  });

  it('should queue the owned workflow and distinguish its receipt from completed scanning', async () => {
    const f = fixture();
    const result = await f.service.refresh(f.manifest, '/workspace', {
      signal: new AbortController().signal,
    });
    assert.equal(result.status, 'queued');
    assert.equal(result.runId, 'native-run');
    assert.equal(f.requests, 1);
    assert.equal(result.lastSuccessfulPollAt, undefined);
    const waited = await f.service.wait(f.manifest, '/workspace', {
      selector,
      target: 'prepared',
      timeoutMs: 2,
      refresh: true,
    });
    assert.equal(waited.status, 'timed-out');
    assert.equal(f.requests, 2, 'wait must request only one cycle');
  });

  it('should advance refresh cycles only after the owning native run completes', async () => {
    const f = fixture();
    let sleeps = 0;
    let reads = 0;
    f.service.dependencies.now = () => baseline;
    f.service.dependencies.inspectRun = async () => (++reads === 1 ? 'pending' : 'completed');
    f.service.dependencies.sleep = async () => {
      if (++sleeps === 3)
        f.records.push({
          ...record(),
          issueKey: issueKey(f.state!.records[0]!),
          phase: 'created',
          worktree: '/worktree',
          threadId: 'issue-chat',
          sessionCreation: {
            attempted: true,
            verified: true,
            sessionId: 'session',
            sourceSessionId: 'coordinator',
            sourceRunId: 'run',
            sourceToolCallId: 'tool',
          },
        });
    };
    const result = await f.service.wait(f.manifest, '/workspace', {
      selector,
      target: 'prepared',
      timeoutMs: 1000,
      refresh: true,
    });
    assert.equal(result.status, 'completed');
    assert.equal(f.requests, 2);
    assert.equal(reads, 2);
  });

  it('should never fall back to legacy state when the native backend is absent', async () => {
    const f = fixture();
    let legacy = false;
    let exit = 0;
    const errors: string[] = [];
    const loaded = {
      status: 'loaded' as const,
      manifest: f.manifest,
      scope: { workspaceDir: '/workspace' },
      path: '/workspace/agent.yaml',
      digest: 'digest',
      diagnostics: [],
      validationChecks: [],
    };
    await status({
      json: true,
      workspaceDir: '/workspace',
      manifestService: {
        loadForAgentId: async () => loaded,
        loadForCommandDirectory: async () => loaded,
      },
      statusService: {
        inspect: async (): Promise<never> => {
          legacy = true;
          throw Error('legacy state');
        },
      },
      output: {
        writeStdout() {
          throw Error('no successful json result');
        },
        writeStderr: (text) => errors.push(text),
      },
      setExitCode: (code) => {
        exit = code;
      },
    });
    assert.equal(legacy, false);
    assert.equal(exit, 1);
    assert.match(errors.join(''), /github-notification-status-failed/u);
  });

  it('should reject disabled inactive stale unsupported and scoped refreshes without starting work', async () => {
    for (const change of ['disabled', 'inactive', 'stale', 'runtime', 'mode', 'scope']) {
      const f = fixture();
      const policy = f.manifest.github!.notifications!;
      assert.ok(policy.schemaVersion === 2);
      if (change === 'disabled') policy.issueAssignment!.enabled = false;
      if (change === 'inactive') f.state = undefined;
      if (change === 'stale') f.state!.policyDigest = 'old';
      if (change === 'runtime') policy.runtimes = ['codex'];
      if (change === 'mode') policy.issueAssignment!.mode = 'work';
      const result = await f.service.refresh(f.manifest, '/workspace', {
        signal: new AbortController().signal,
        ...(change === 'scope' ? { selector } : {}),
      });
      assert.equal(result.status, 'failed', change);
      assert.equal(f.requests, 0, change);
    }
  });

  it('should reject unsupported selectors and rejection waits immediately', async () => {
    const f = fixture();
    assert.equal(
      (await f.service.inspect(f.manifest, '/workspace', { ...selector, itemType: 'pull-request' }))
        .code,
      'github-notification-selector-unsupported',
    );
    const result = await f.service.wait(f.manifest, '/workspace', {
      selector,
      target: 'assignment-rejected',
      timeoutMs: 100,
      refresh: true,
    });
    assert.equal(result.code, 'github-notification-wait-target-unsupported');
    assert.equal(f.requests, 0);
  });

  it('should cancel before a run and retain uncertainty when a queue request is interrupted', async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    assert.equal(
      (await f.service.refresh(f.manifest, '/workspace', { signal: abort.signal })).code,
      'github-notification-refresh-cancelled',
    );
    const active = new AbortController();
    f.service.dependencies.requestRun = async () => {
      active.abort();
      throw Error('unknown admission');
    };
    assert.equal(
      (await f.service.refresh(f.manifest, '/workspace', { signal: active.signal })).code,
      'github-notification-refresh-outcome-uncertain',
    );
    assert.equal(f.requests, 0);
  });

  it('should route all public cli functions to native state while preserving json and successful queue exit', async () => {
    const f = fixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let exit = 0;
    const loaded = {
      status: 'loaded' as const,
      manifest: f.manifest,
      scope: { workspaceDir: '/workspace' },
      path: '/workspace/agent.yaml',
      digest: 'digest',
      diagnostics: [],
      validationChecks: [],
    };
    const options = {
      json: true,
      styles: createCliStyles({ NO_COLOR: '1' }),
      workspaceDir: '/workspace',
      nativeService: f.service,
      manifestService: {
        loadForAgentId: async () => loaded,
        loadForCommandDirectory: async () => loaded,
      },
      monitorService: {
        runOnce: async (): Promise<never> => {
          throw Error('legacy scan');
        },
      },
      statusService: {
        inspect: async (): Promise<never> => {
          throw Error('legacy state');
        },
        wait: async (): Promise<never> => {
          throw Error('legacy wait');
        },
      },
      output: {
        writeStdout: (text: string) => stdout.push(text),
        writeStderr: (text: string) => stderr.push(text),
      },
      setExitCode: (code: number) => {
        exit = code;
      },
    };
    await status(options);
    assert.equal(JSON.parse(stdout.pop()!).status, 'ready');
    await refresh(options);
    assert.equal(JSON.parse(stdout.pop()!).status, 'queued');
    assert.equal(exit, 0);
    await wait({ ...options, refresh: false, target: 'baseline-ready' });
    assert.equal(JSON.parse(stdout.pop()!).status, 'completed');
    assert.deepEqual(stderr, []);
    await refresh({ ...options, json: false });
    const human = stdout.pop()!;
    assert.match(human, /status\s+queued/u);
    assert.match(human, /run\s+native-run/u);
    assert.equal(human.includes(String.fromCharCode(27)), false);
    await refresh({ ...options, repository: 'owner/repo', itemKind: 'issue', itemNumber: '3' });
    assert.equal(
      JSON.parse(stdout.pop()!).code,
      'github-notification-refresh-selector-unsupported',
    );
    assert.equal(exit, 1);
    assert.match(stderr.join(''), /omit item selectors/u);
  });
});
