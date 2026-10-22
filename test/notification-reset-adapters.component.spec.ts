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
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
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
    const journal = new OpenClawDispatchStore(root, scope);
    await journal.exclusive(async (state, save) => {
      state.records.push({
        id: 'd'.repeat(64),
        intakeId: 'e'.repeat(64),
        issueKey: 'f'.repeat(64),
        sourceThreadId: 'coordinator',
        phase: 'creating',
        createdAt: 2,
        manifestDigest: 'manifest',
        context: '{}',
        routing: '{}',
        routingNote: 'fixture',
        worktree: root,
        request: {
          key: 'agent:receiver:issue:missing',
          idempotencyKey: 'creation',
          agentId: 'receiver',
          label: 'issue',
          category: 'issues',
          cwd: root,
          model: 'fixture',
          thinkingLevel: 'low',
        },
        sessionCreation: {
          attempted: true,
          sourceSessionId: 'source',
          sourceRunId: 'run',
          sourceToolCallId: 'call',
        },
      });
      await save();
    });
    let enabled = true;
    let active = true;
    let missingSession: unknown = { ok: true, key: 'agent:receiver:issue:missing' };
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
        use: async (_authority, run) =>
          run(async (method, params) => {
            if (method === 'sessions.resolve' && params.key === 'agent:receiver:issue:missing')
              return missingSession;
            return native.request(method);
          }),
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
    await assert.rejects(run(), /notification-reset-session-creation-unresolved/u);
    missingSession = { ok: false, candidates: ['ambiguous'] };
    await assert.rejects(run(), /notification-reset-session-creation-unresolved/u);
    missingSession = { ok: false, candidates: [] };
    assert.equal((await run()).status, 'complete');
    assert.deepEqual(toggles, [false, true]);
    assert.ok((await intake.read())!.baselineAt > 1);
    assert.equal(native.archived(), true);
    assert.equal(native.replacements(), 1);
    assert.ok((await new OpenClawDispatchStore(root, scope).read()).resetGeneration);
  });

  it('should finish a retained openclaw reset with unresolved current creation after fresh is selected', async () => {
    const scope = 'c'.repeat(64);
    const intake = new IntakeRecordStore({ root, path: join(root, 'intake.json'), scope });
    await seed(intake);
    const journal = new OpenClawDispatchStore(root, scope);
    await journal.exclusive(async (state, save) => {
      state.records.push({
        id: 'd'.repeat(64),
        intakeId: 'e'.repeat(64),
        issueKey: 'f'.repeat(64),
        sourceThreadId: 'coordinator',
        phase: 'creating',
        createdAt: 2,
        manifestDigest: 'manifest',
        context: '{}',
        routing: '{}',
        routingNote: 'fixture',
        worktree: join(root, 'old-checkout'),
        sessionCreation: {
          attempted: true,
          sourceSessionId: 'source',
          sourceRunId: 'run',
          sourceToolCallId: 'call',
        },
        request: {
          key: 'agent:receiver:issue:unresolved',
          idempotencyKey: 'creation',
          agentId: 'receiver',
          label: 'issue',
          category: 'issues',
          cwd: join(root, 'old-checkout'),
          model: 'fixture',
          thinkingLevel: 'low',
        },
      });
      await save();
    });
    let enabled = true;
    const native = coordinator();
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
            if (method === 'sessions.list' && params.workspaceDir === join(root, 'old-checkout'))
              return { sessions: [] };
            return native.request(method);
          }),
      },
      worktrees: {
        inspectGitHub: async () => {
          throw new Error('ordinary reset preserves checkout');
        },
        cleanupGitHub: async () => {
          throw new Error('ordinary reset preserves checkout');
        },
      },
      connect: async () => {
        throw new Error('no provider effects');
      },
    });
    await assert.rejects(
      service.run(manifest, root, await service.preview(manifest, root, false)),
      /notification-reset-session-creation-unresolved/u,
    );
    assert.equal(enabled, false);
    const fresh = await service.preview(manifest, root, false, true);
    assert.equal(fresh.continuing, true);
    assert.equal(fresh.restarting, true);
    assert.equal((await service.run(manifest, root, fresh)).status, 'complete');
    assert.equal(enabled, true);
    assert.deepEqual((await journal.read()).records, []);
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

  it('should finish codex reset only after native pause, sidebar placement and restoration readback', async () => {
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
    const journal = new CodexDispatchStore(pluginData, current.store.location.scope);
    await journal.exclusive(async (state, save) => {
      for (const [index, retired] of [false, true].entries())
        state.records.push({
          id: String(index + 1).repeat(64),
          intakeId: 'e'.repeat(64),
          issueKey: 'f'.repeat(64),
          sourceThreadId: 'coordinator',
          phase: 'creating',
          createdAt: 2000,
          manifestDigest: 'manifest',
          reservationVersion: 1,
          context: '{}',
          routing: '{}',
          routingNote: 'fixture',
          project: {
            id: 'project',
            path: workspace,
            commonDir: join(workspace, '.git'),
            ref: 'main',
            commit: 'a'.repeat(40),
          },
          ...(retired ? { retired: { at: 3000, by: 'operator' } } : {}),
          request: {
            title: 'issue',
            prompt: 'fixture issue',
            model: 'fixture',
            thinking: 'low',
            target: {
              type: 'project',
              projectId: 'project',
              environment: {
                type: 'worktree',
                startingState: { type: 'branch', branchName: 'main' },
              },
            },
          },
        });
      await save();
    });
    let finished = false;
    let archived = false;
    let creation: 'unavailable' | 'found' | 'absent' = 'unavailable';
    const searched = new Set<boolean>();
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
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === 'thread/list') {
            if (creation === 'unavailable') throw new Error('native inventory unavailable');
            searched.add(Boolean(params.archived));
            return {
              data:
                creation === 'found' && params.archived ? [{ id: 'unrecorded', createdAt: 2 }] : [],
            };
          }
          if (method === 'thread/read')
            return {
              thread: {
                id: params.threadId,
                cwd: current.workspace,
                path: '/sessions/' + params.threadId,
                archived,
                status: { type: 'notLoaded' },
              },
            };
          if (method === 'thread/items/list')
            return {
              data: [
                {
                  turnId: 'turn',
                  item: {
                    type: 'functionCallOutput',
                    name: 'create_thread',
                    namespace: 'codex_app',
                    output:
                      '<codex_delegation>\n  <source_thread_id>coordinator</source_thread_id>\n  <input>fixture issue</input>\n</codex_delegation>',
                  },
                },
              ],
            };
          assert.equal(method, 'thread/turns/list');
          return {
            data: [
              { id: 'turn', status: 'interrupted', ...(finished ? { completedAt: 100 } : {}) },
            ],
          };
        },
      }),
    };
    const sections: { sectionId: string; name: string; itemKeys: string[] }[] = [];
    const run = () =>
      runCodexNotificationReset(
        pluginData,
        {
          agent: ['receiver'],
          yes: true,
          purge: true,
          nativeInventory: {
            schemaVersion: 4,
            sections,
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
    await assert.rejects(run(), /native inventory unavailable/u);
    creation = 'found';
    await assert.rejects(run(), /notification-reset-native-creation-unresolved/u);
    assert.equal((await current.store.read())!.baselineAt, 1);
    creation = 'absent';
    const archive = await run();
    assert.deepEqual(searched, new Set([false, true]));
    assert.equal(archive.status, 'native-action');
    assert.equal('request' in archive && archive.request?.tool, 'set_thread_archived');
    assert.equal((await run()).status, 'incomplete');
    archived = true;
    const grouping = await run();
    assert.equal(grouping.status, 'native-action');
    assert.deepEqual('request' in grouping && grouping.request, {
      tool: 'create_sidebar_section',
      arguments: { name: 'AGENT SYSTEM' },
    });
    assert.equal(saved.definition.status, 'PAUSED');
    assert.equal((await run()).status, 'incomplete');
    sections.push({
      sectionId: 'group',
      name: 'AGENT SYSTEM',
      itemKeys: ['codex:thread:local:old'],
    });
    const placing = await run();
    assert.equal(placing.status, 'native-action');
    assert.deepEqual('request' in placing && placing.request, {
      tool: 'move_thread_to_sidebar_section',
      arguments: { threadId: 'replacement', hostId: 'local', source: 'codex', sectionId: 'group' },
    });
    assert.equal(saved.definition.status, 'PAUSED');
    assert.equal((await run()).status, 'incomplete');
    sections[0]!.itemKeys.push('codex:thread:local:replacement');
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

  async function verifyOpenClawPurge(missing: boolean) {
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
        ...(missing ? { worktreeAttemptId: 'd'.repeat(64) } : {}),
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
      const original = state.records[0]!;
      assert.ok(original.request && 'key' in original.request);
      state.records.push({
        ...original,
        id: 'f'.repeat(64),
        worktreeAttemptId: undefined,
        issueKey: 'a'.repeat(64),
        phase: 'creating',
        threadId: undefined,
        effective: undefined,
        request: {
          ...original.request,
          key: 'agent:receiver:issue:absent',
        },
        sessionCreation: {
          attempted: true,
          sourceSessionId: 'source',
          sourceRunId: 'run',
          sourceToolCallId: 'missing-call',
        },
      });
      await save();
    });
    const native = coordinator();
    native.missing();
    let pinned = !missing;
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
            if (method === 'sessions.describe') {
              if (missing) return { session: null };
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
            }
            if (method === 'sessions.list')
              return {
                sessions: [
                  ...(missing ? [] : [{ key }]),
                  ...(shared ? [{ key: 'unrelated' }] : []),
                ],
              };
            assert.equal(method, 'sessions.patch');
            assert.equal(params.expectedLifecycleRevision, 'revision');
            archives++;
            archived = true;
            return {};
          }),
      },
      worktrees: {
        inspectGitHub: async (input) => {
          if (input.attemptId !== undefined) assert.equal(input.attemptId, 'd'.repeat(64));
          return {
            repositoryId: 'github-10',
            workId: 'issue-20',
            path: worktree,
            branch: 'owned',
            status: 'existing' as const,
          };
        },
        cleanupGitHub: async (input) => {
          assert.equal(input.attemptId, missing ? 'd'.repeat(64) : undefined);
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
    if (!missing) {
      await assert.rejects(run(), /notification-reset-resource-protected/u);
      assert.equal(archives, 0);
      assert.equal(removals, 0);
    }
    pinned = false;
    await assert.rejects(run(), /notification-reset-worktree-shared/u);
    assert.equal(archives, missing ? 0 : 1);
    assert.equal(removals, 0);
    shared = false;
    const completed = await run();
    assert.equal(completed.status, 'complete');
    if (missing) assert.equal(completed.warnings, undefined);
    assert.equal(archives, missing ? 0 : 1);
    assert.equal(removals, 1);
    assert.equal(enabled, true);
  }

  for (const missing of [false, true])
    it(`should preserve protected openclaw resources and purge with a ${missing ? 'missing' : 'present'} chat`, () =>
      verifyOpenClawPurge(missing));
});
