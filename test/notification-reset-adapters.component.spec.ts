import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenClawNotificationReset from '../agent/openclaw-notification-reset.ts';
import runCodexNotificationReset from '../agent/codex-notification-reset.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import { selectCodexIntake } from '../agent/codex-intake.ts';
import type { SavedAutomation } from '../agent/codex-automation-state.ts';
import IntakeRecordStore from '../channels/github/intake/record-store.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import { automationHash } from '../agent/automation-hash.ts';
import { intakeFixture, account } from './github-intake-fixture.ts';

describe('agent/notification reset runtime adapters', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'notification-reset-adapters-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const seed = async (store: IntakeRecordStore, workspaceDir = root) =>
    store.exclusive(async (_state, save) =>
      save({
        version: 1,
        scope: store.location.scope,
        workspaceDir,
        agentId: 'receiver',
        account: { login: 'receiver', nodeId: 'user' },
        policyDigest: 'policy',
        baselineAt: 1,
        records: [],
      }),
    );

  function coordinator(active = () => false) {
    let archived = false;
    let missing = false;
    let replacements = 0;
    const row = () => ({
      key: 'coordinator',
      agentId: 'receiver',
      sessionId: 'source',
      workspaceDir: root,
      archived,
    });
    return {
      missing: () => {
        missing = true;
      },
      replacements: () => replacements,
      archived: () => archived,
      async request(method: string) {
        if (method === 'sessions.resolve')
          return missing ? { ok: false } : { ok: true, key: 'coordinator', agentId: 'receiver' };
        if (method === 'sessions.list') return { sessions: [row()] };
        if (method === 'sessions.describe') return { session: row() };
        if (method === 'sessions.patch') {
          archived = true;
          return {};
        }
        if (method === 'cron.list') return { jobs: [], hasMore: false };
        if (method === 'chat.history')
          return { sessionInfo: { hasActiveRun: active() }, pendingInputs: { total: 0 } };
        throw new Error(method);
      },
      async replace(
        _manifest: unknown,
        _workspace: string,
        expected: {
          id: string;
          nativeId: string;
          enabled: boolean;
          hash: string;
          sessionKey?: string;
        },
      ) {
        assert.ok(archived || missing);
        replacements++;
        return { ...expected, sessionKey: 'replacement' };
      },
    };
  }

  it('should pause openclaw once, wait for the coordinator, reset and restore', async () => {
    const scope = 'a'.repeat(64);
    const intake = new IntakeRecordStore({ root, path: join(root, 'intake.json'), scope });
    await seed(intake);
    let enabled = true;
    let active = true;
    const native = coordinator(() => active);
    const toggles: boolean[] = [];
    const manifest = { schemaVersion: 1 as const, agent: { id: 'receiver' } };
    const service = new OpenClawNotificationReset({
      root,
      intake: { select: async () => ({ store: intake, selected: undefined, workspace: root }) },
      automations: {
        notificationResetReplace: native.replace,
        notificationResetSnapshot: async () => ({
          id: 'intake',
          nativeId: 'job',
          enabled,
          hash: 'configuration',
          sessionKey: 'coordinator',
        }),
        notificationResetToggle: async (_manifest, _workspace, expected, restore) => {
          enabled = restore ? expected.enabled : false;
          toggles.push(enabled);
        },
      },
      credential: {
        use: async (_authority, run) => run(native.request),
      },
      worktrees: {
        inspectGitHub: async () => {
          throw new Error('ordinary reset must preserve worktrees');
        },
        cleanupGitHub: async () => {
          throw new Error('ordinary reset must preserve worktrees');
        },
      },
      connect: async () => {
        throw new Error('ordinary reset must preserve provider state');
      },
    });
    const run = async () =>
      service.run(manifest, root, await service.preview(manifest, root, false));
    assert.equal((await run()).status, 'waiting');
    assert.equal((await intake.read())!.baselineAt, 1);
    assert.deepEqual(toggles, [false]);
    active = false;
    assert.equal((await run()).status, 'complete');
    assert.deepEqual(toggles, [false, true]);
    assert.ok((await intake.read())!.baselineAt > 1);
    assert.equal(native.archived(), true);
    assert.equal(native.replacements(), 1);
    assert.ok((await new OpenClawDispatchStore(root, scope).read()).resetGeneration);
  });

  it('should wait for manual pause after a failed openclaw pause without repeating the write', async () => {
    const scope = 'b'.repeat(64);
    const intake = new IntakeRecordStore({ root, path: join(root, 'intake.json'), scope });
    await seed(intake);
    let enabled = true;
    let attempts = 0;
    const native = coordinator();
    native.missing();
    const manifest = { schemaVersion: 1 as const, agent: { id: 'receiver' } };
    const service = new OpenClawNotificationReset({
      root,
      intake: { select: async () => ({ store: intake, selected: undefined, workspace: root }) },
      automations: {
        notificationResetReplace: native.replace,
        notificationResetSnapshot: async () => ({
          id: 'intake',
          nativeId: 'job',
          enabled,
          hash: 'configuration',
          sessionKey: 'coordinator',
        }),
        notificationResetToggle: async (_manifest, _workspace, expected, restore) => {
          if (!restore) {
            attempts++;
            throw new Error('pause rejected');
          }
          enabled = expected.enabled;
        },
      },
      credential: {
        use: async (_authority, run) => run(native.request),
      },
      worktrees: {
        inspectGitHub: async () => undefined,
        cleanupGitHub: async () => {
          throw new Error('not purging');
        },
      },
      connect: async () => {
        throw new Error('no provider effect');
      },
    });
    const run = async () =>
      service.run(manifest, root, await service.preview(manifest, root, false));
    assert.equal((await run()).status, 'waiting');
    assert.equal((await run()).status, 'waiting');
    assert.equal(attempts, 1);
    enabled = false;
    assert.equal((await run()).status, 'complete');
    assert.equal(enabled, true);
  });

  it('should finish codex reset only after native pause and restoration readback', async () => {
    const workspace = join(root, 'workspace');
    const codexHome = join(root, 'codex');
    const pluginData = join(root, 'plugin');
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({ 'schema-version': 1, agent: { id: 'receiver' } }),
    );
    await bindCodexWorkspace(pluginData, workspace);
    const current = await selectCodexIntake(pluginData, { codexHome });
    await seed(current.store, current.workspace);
    const saved: SavedAutomation = {
      id: 'job',
      definition: {
        kind: 'heartbeat',
        destination: 'thread',
        targetThreadId: 'coordinator',
        name: 'intake',
        prompt: 'fixture',
        rrule: 'FREQ=MINUTELY;INTERVAL=5',
        status: 'ACTIVE',
        notificationPolicy: null,
      },
    };
    let finished = false;
    let archived = false;
    const deps = {
      codexHome,
      caller: 'operator',
      automation: async () => structuredClone(saved),
      replaceCoordinator: async (_pluginData: string, before: SavedAutomation) => {
        assert.equal(saved.definition.status, 'PAUSED');
        assert.equal(archived, true);
        if (saved.definition.kind !== 'heartbeat') throw new Error('heartbeat required');
        saved.definition.targetThreadId = 'replacement';
        return {
          status: 'done' as const,
          automation: JSON.stringify({
            ...before,
            definition: { ...before.definition, targetThreadId: 'replacement' },
          }),
        };
      },
      threads: async () => ({
        close: async () => {},
        request: async (method: string) =>
          method === 'thread/read'
            ? {
                thread: {
                  id: 'coordinator',
                  cwd: current.workspace,
                  path: '/sessions/coordinator',
                  archived,
                  status: { type: 'notLoaded' },
                },
              }
            : {
                data: [
                  { id: 'turn', status: 'interrupted', ...(finished ? { completedAt: 100 } : {}) },
                ],
              },
      }),
    };
    const run = () =>
      runCodexNotificationReset(
        pluginData,
        {
          agent: ['receiver'],
          yes: true,
          nativeInventory: {
            schemaVersion: 4,
            pinnedThreads: [],
            unavailableHosts: [],
            unavailableSources: [],
          },
        },
        deps,
      );
    assert.equal((await run()).status, 'native-action');
    assert.equal((await run()).status, 'incomplete');
    saved.definition.status = 'PAUSED';
    assert.equal((await run()).status, 'waiting');
    assert.equal((await current.store.read())!.baselineAt, 1);
    finished = true;
    const archive = await run();
    assert.equal(archive.status, 'native-action');
    assert.equal('request' in archive && archive.request?.tool, 'set_thread_archived');
    assert.equal((await run()).status, 'incomplete');
    archived = true;
    const restoring = await run();
    assert.equal(restoring.status, 'native-action');
    assert.equal('request' in restoring && restoring.request?.arguments.status, 'ACTIVE');
    saved.definition.status = 'ACTIVE';
    assert.equal((await run()).status, 'complete');
    assert.ok((await current.store.read())!.baselineAt > 1);
    await assert.rejects(
      runCodexNotificationReset(
        pluginData,
        { all: true, yes: true },
        { ...deps, caller: 'replacement' },
      ),
      /notification-reset-operator-required/u,
    );
  });

  it('should preserve pinned and shared openclaw resources and reconcile partial purge', async () => {
    const scope = 'c'.repeat(64);
    const intake = new IntakeRecordStore({ root, path: join(root, 'intake.json'), scope });
    const fixture = intakeFixture();
    const receiver = { login: account.login, nodeId: account.nodeId };
    const intakeId = automationHash([
      scope,
      fixture.repository.nodeId,
      fixture.item.nodeId,
      fixture.events[0]!.nodeId,
    ]);
    await intake.exclusive(async (_state, save) =>
      save({
        version: 1,
        scope,
        workspaceDir: root,
        agentId: 'receiver',
        account: receiver,
        policyDigest: 'policy',
        baselineAt: 1,
        records: [
          {
            version: 1,
            id: intakeId,
            scope,
            receiving: receiver,
            workspaceDir: root,
            agentId: 'receiver',
            host: 'github.com',
            repository: {
              nodeId: fixture.repository.nodeId,
              databaseId: fixture.repository.databaseId,
              owner: {
                login: fixture.repository.owner.login,
                nodeId: fixture.repository.owner.nodeId,
              },
              name: fixture.repository.name,
            },
            issue: {
              nodeId: fixture.item.nodeId,
              databaseId: fixture.item.databaseId,
              number: fixture.item.number,
            },
            assignment: { ...fixture.events[0]!, event: 'assigned' },
            evidence: {
              policyDigest: 'policy',
              mode: 'plan',
              open: true,
              assigned: true,
              repositoryReadable: true,
              ownerPinned: true,
              actorPinned: true,
            },
            observedAt: 2,
            admittedAt: 2,
            status: 'admitted',
            requiresRevalidation: true,
          },
        ],
      }),
    );
    const worktree = join(root, 'checkout');
    await mkdir(worktree);
    const key = 'agent:receiver:issue:one';
    const journal = new OpenClawDispatchStore(root, scope);
    await journal.exclusive(async (state, save) => {
      state.records.push({
        id: 'd'.repeat(64),
        intakeId,
        issueKey: 'e'.repeat(64),
        sourceThreadId: 'coordinator',
        phase: 'created',
        createdAt: 2,
        manifestDigest: 'manifest',
        context: '{}',
        routing: '{}',
        routingNote: 'fixture',
        effective: { status: 'verified', model: 'fixture', effort: 'low' },
        threadId: key,
        worktree,
        request: {
          key,
          idempotencyKey: 'creation',
          agentId: 'receiver',
          label: 'issue',
          category: 'issues',
          cwd: worktree,
          model: 'fixture',
          thinkingLevel: 'low',
        },
        sessionCreation: {
          attempted: true,
          sourceSessionId: 'source',
          sourceRunId: 'run',
          sourceToolCallId: 'call',
          sessionId: 'issue-session',
          verified: true,
        },
      });
      await save();
    });
    const native = coordinator();
    native.missing();
    let pinned = true;
    let shared = true;
    let archived = false;
    let enabled = true;
    let archives = 0;
    let removals = 0;
    const manifest = { schemaVersion: 1 as const, agent: { id: 'receiver' } };
    const service = new OpenClawNotificationReset({
      root,
      intake: { select: async () => ({ store: intake, selected: undefined, workspace: root }) },
      automations: {
        notificationResetReplace: native.replace,
        notificationResetSnapshot: async () => ({
          id: 'intake',
          nativeId: 'job',
          enabled,
          hash: 'configuration',
          sessionKey: 'coordinator',
        }),
        notificationResetToggle: async (_manifest, _workspace, expected, restore) => {
          enabled = restore ? expected.enabled : false;
        },
      },
      credential: {
        use: async (_authority, run) =>
          run(async (method, params) => {
            if (method === 'sessions.resolve') return { ok: false };
            if (method === 'chat.history')
              return {
                sessionId: 'issue-session',
                sessionInfo: { hasActiveRun: false },
                pendingInputs: { total: 0 },
                messages: [],
              };
            if (method === 'cron.list') return { jobs: [], hasMore: false };
            if (method === 'sessions.describe')
              return {
                session: {
                  key,
                  agentId: 'receiver',
                  sessionId: 'issue-session',
                  workspaceDir: worktree,
                  pinned,
                  archived,
                  lifecycleRevision: 'revision',
                },
              };
            if (method === 'sessions.list')
              return { sessions: [{ key }, ...(shared ? [{ key: 'unrelated' }] : [])] };
            assert.equal(method, 'sessions.patch');
            assert.equal(params.expectedLifecycleRevision, 'revision');
            archives++;
            archived = true;
            return {};
          }),
      },
      worktrees: {
        inspectGitHub: async () => ({
          repositoryId: 'github-10',
          workId: 'issue-20',
          path: worktree,
          branch: 'owned',
          status: 'existing',
        }),
        cleanupGitHub: async (input) => {
          assert.equal(input.purge, true);
          assert.deepEqual(input.worktree, { path: worktree, branch: 'owned' });
          removals++;
          await rm(worktree, { recursive: true });
          return {
            ...input.worktree,
            repositoryId: 'github-10',
            workId: 'issue-20',
            status: 'removed',
          };
        },
      },
      connect: async () => ({
        client: fixture.client,
        account: {
          identity: account,
          execute: async () => {
            throw new Error('no pull request');
          },
        },
      }),
    });
    const run = async () =>
      service.run(manifest, root, await service.preview(manifest, root, true));
    await assert.rejects(run(), /notification-reset-resource-protected/u);
    assert.equal(archives, 0);
    assert.equal(removals, 0);
    pinned = false;
    await assert.rejects(run(), /notification-reset-worktree-shared/u);
    assert.equal(archives, 1);
    assert.equal(removals, 0);
    shared = false;
    assert.equal((await run()).status, 'complete');
    assert.equal(archives, 1);
    assert.equal(removals, 1);
    assert.equal(enabled, true);
  });
});
