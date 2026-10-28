import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Value } from 'typebox/value';

import { runCodexDispatch, type CodexDispatchDependencies } from '../agent/codex-dispatch.ts';
import CodexDispatchStore from '../agent/codex-dispatch-state.ts';
import { selectCodexIntake } from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import nativeRetirement, { type NativeRetirementTarget } from '../agent/native-retirement.ts';
import OpenClawDispatch from '../agent/openclaw-dispatch.ts';
import OpenClawDispatchStore from '../agent/openclaw-dispatch-state.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';

describe('agent/native retirement receipts', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/native-retirement-'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  function fixture() {
    const target: NativeRetirementTarget = {
      id: 'native',
      incarnation: 'session',
      archived: false,
    };
    let archives = 0;
    const deps = {
      root,
      binding: {
        runtime: 'openclaw' as const,
        agentId: 'fixture',
        namespace: root,
        workspace: root,
        session: 'operator',
        incarnation: 'operator-session',
      },
      target: target.id,
      turnId: 'turn',
      inputId: 'input',
      now: 100,
      effects: 'native disposal',
      assertCurrent: async () => {},
      managed: async () => false,
      observe: async () => ({ ...target }),
      archive: async () => {
        archives++;
        target.archived = true;
      },
    };
    return { deps, target, archives: () => archives };
  }

  it('should reject managed targets and stale incarnations before mutation', async () => {
    const { deps, target, archives } = fixture();
    await assert.rejects(
      nativeRetirement({ ...deps, managed: async () => true }),
      /native-retirement-managed-owner-required/,
    );
    const preview = await nativeRetirement(deps);
    target.incarnation = 'replacement';
    await assert.rejects(
      nativeRetirement({ ...deps, digest: preview.digest }),
      /native-retirement-preview-stale/,
    );
    assert.equal(archives(), 0);
  });

  it('should reconcile a committed effect after a lost response without replay', async () => {
    const { deps, target, archives } = fixture();
    const preview = await nativeRetirement(deps);
    const result = await nativeRetirement({
      ...deps,
      digest: preview.digest,
      archive: async () => {
        await deps.archive();
        throw new Error('transport-lost');
      },
    });
    assert.equal(result.status, 'archived');
    assert.equal((await nativeRetirement(deps)).status, 'archived');
    assert.equal(target.archived, true);
    assert.equal(archives(), 1);
  });

  it('should retain an uncertain uncommitted effect across operator turns without replay', async () => {
    const { deps, archives } = fixture();
    const preview = await nativeRetirement(deps);
    const result = await nativeRetirement({
      ...deps,
      digest: preview.digest,
      archive: async () => {
        throw new Error('transport-lost');
      },
    });
    assert.equal(result.status, 'pending');
    assert.equal((await nativeRetirement({ ...deps, turnId: 'next-turn' })).status, 'pending');
    assert.equal(archives(), 0);
  });

  it('should leave a successful response pending until native readback is available', async () => {
    const { deps, archives } = fixture();
    const preview = await nativeRetirement(deps);
    let reads = 0;
    const pending = await nativeRetirement({
      ...deps,
      digest: preview.digest,
      observe: async () => {
        if (++reads === 3) throw new Error('readback-unavailable');
        return deps.observe();
      },
    });
    assert.equal(pending.status, 'pending');
    assert.equal((await nativeRetirement(deps)).status, 'archived');
    assert.equal(archives(), 1);
  });

  it('should not prepare another effect after native denial', async () => {
    const { deps, archives } = fixture();
    const preview = await nativeRetirement(deps);
    const denied = await nativeRetirement({
      ...deps,
      digest: preview.digest,
      archive: async () => {
        throw new Error('native-permission-denied');
      },
    });
    assert.equal(denied.status, 'failed');
    assert.equal((await nativeRetirement(deps)).code, 'native-permission-denied');
    assert.equal(archives(), 0);
  });

  it('should require fresh operator input to clean up a restored conversation again', async () => {
    const { deps, target, archives } = fixture();
    const preview = await nativeRetirement(deps);
    await nativeRetirement({ ...deps, digest: preview.digest });
    target.archived = false;
    assert.equal((await nativeRetirement(deps)).code, 'native-retirement-new-input-required');
    const next = { ...deps, turnId: 'next-turn', inputId: 'new-cleanup-input' };
    const again = await nativeRetirement(next);
    assert.equal(again.status, 'retire-available');
    assert.equal((await nativeRetirement({ ...next, digest: again.digest })).status, 'archived');
    assert.equal(archives(), 2);
  });
});

describe('agent/native retirement runtime entries', () => {
  let root: string;
  const manifest: AgentManifest = { schemaVersion: 1, agent: { id: 'fixture' } };
  beforeEach(async () => {
    root = await realpath(await mkdtemp('/tmp/native-retirement-entry-'));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('should enforce disjoint exact native and managed selectors at both request boundaries', async () => {
    for (const input of [
      { action: 'retire', native: 'agent:fixture:chat' },
      { action: 'retire', id: 'a'.repeat(64) },
    ])
      assert.equal(Value.Check(dispatchParameters, input), true);
    for (const input of [
      { action: 'retire', id: 'a'.repeat(64), native: 'chat' },
      { action: 'retire', native: '' },
      { action: 'retire', native: 'ambiguous title' },
    ]) {
      assert.equal(Value.Check(dispatchParameters, input), false);
      await assert.rejects(runCodexDispatch(root, 'retire', input), /dispatch-request-invalid/);
    }
  });

  it('should archive an unmanaged openclaw target without intake, provider access or git checks', async () => {
    const caller = {
      sessionKey: 'agent:fixture:operator',
      sessionId: 'operator-session',
      runId: 'run',
      toolCallId: 'call',
    };
    const target = {
      key: 'agent:fixture:native',
      agentId: 'fixture',
      sessionId: 'native-session',
      workspaceDir: root,
      lifecycleRevision: 'revision',
      archived: false,
      pinned: true,
    };
    const patches: Record<string, unknown>[] = [];
    let credentials = 0;
    const message = {
      role: 'user',
      content: 'clean up exact native chat',
      __openclaw: {
        id: 'input',
        runId: caller.runId,
        idempotencyKey: `${caller.runId}:user`,
        senderIsOwner: true,
      },
    };
    const request: DispatchRequest = async (method, params) => {
      if (method === 'chat.history' && params.sessionKey === caller.sessionKey)
        return { sessionId: caller.sessionId, messages: [message] };
      if (method === 'sessions.describe') return { session: target };
      if (method === 'sessions.patch') {
        patches.push(params);
        target.archived = true;
        return {};
      }
      throw new Error('unexpected native call ' + method);
    };
    const unsupported = async (): Promise<never> => {
      throw new Error('unexpected provider or managed lifecycle call');
    };
    const intake = new OpenClawIntake({
      root: join(root, 'intake'),
      namespace: root,
      connect: unsupported,
      manifestService: {
        loadForAgentId: async () => ({
          status: 'loaded',
          manifest,
          scope: { agentId: 'fixture', workspaceDir: root },
          path: join(root, 'agent.yaml'),
          digest: 'manifest',
          diagnostics: [],
          validationChecks: [],
        }),
      },
    });
    const service = new OpenClawDispatch({
      root: join(root, 'dispatch'),
      intake,
      config: () => ({}),
      connect: unsupported,
      coordinator: unsupported,
      worktrees: { prepareGitHub: unsupported, inspectGitHub: unsupported },
      credential: {
        use: async (_authority, use) => {
          credentials++;
          return use(request);
        },
      },
    });
    await writeFile(join(root, 'local-only.txt'), 'unpreserved local work');
    await assert.rejects(
      service.run(manifest, root, caller, { action: 'retire', native: target.key }),
      /dispatch-operator-required/,
    );
    await assert.rejects(
      service.run(manifest, root, caller, { action: 'retire', native: 'agent:other:chat' }, true),
      /native-retirement-agent-mismatch/,
    );
    assert.equal(credentials, 0);
    const preview = await service.run(
      manifest,
      root,
      caller,
      { action: 'retire', native: target.key },
      true,
    );
    assert.equal(preview.status, 'retire-available');
    assert.equal(patches.length, 0);
    const digest = 'digest' in preview ? String(preview.digest) : '';
    const result = await service.run(
      manifest,
      root,
      caller,
      { action: 'retire', native: target.key, digest },
      true,
    );
    assert.equal(result.status, 'archived');
    assert.ok('checkout' in result && 'cwd' in result);
    assert.deepEqual(result.checkout, { disposition: 'native-owned' });
    assert.equal(result.cwd, root);
    assert.deepEqual(patches, [
      {
        key: target.key,
        expectedSessionId: target.sessionId,
        expectedLifecycleRevision: 'revision',
        archived: true,
      },
    ]);
    assert.equal(await readFile(join(root, 'local-only.txt'), 'utf8'), 'unpreserved local work');
    const selected = await intake.select(manifest, root, { resolvePolicy: false });
    assert.equal(await selected.store.read(), undefined);
    const journal = new OpenClawDispatchStore(
      join(root, 'dispatch'),
      selected.store.location.scope,
    );
    assert.deepEqual((await journal.read()).records, []);
    await journal.exclusive(async (state, save) => {
      state.records.push({
        id: 'a'.repeat(64),
        issueKey: 'b'.repeat(64),
        sourceThreadId: caller.sessionKey,
        phase: 'routing',
        intakeId: 'c'.repeat(64),
        createdAt: 1,
        manifestDigest: 'manifest',
        threadId: target.key,
      });
      await save();
    });
    await assert.rejects(
      service.run(manifest, root, caller, { action: 'retire', native: target.key }, true),
      /native-retirement-managed-owner-required/,
    );
    assert.equal(patches.length, 1);
  });

  it('should prepare only the native codex desktop effect and observe its result without intake', async () => {
    const workspace = join(root, 'workspace');
    const pluginData = join(root, 'plugin');
    const codexHome = join(root, 'codex');
    await mkdir(workspace);
    await mkdir(codexHome);
    await writeFile(
      join(workspace, 'agent.yaml'),
      JSON.stringify({ 'schema-version': 1, agent: manifest.agent }),
    );
    assert.equal((await bindCodexWorkspace(pluginData, workspace)).status, 'bound');
    let archived = false;
    let outcome: 'unsubmitted' | 'denied' | 'unverified' = 'unverified';
    const methods: string[] = [];
    const unsupported = async (): Promise<never> => {
      throw new Error('unexpected provider, git or activation access');
    };
    const deps: CodexDispatchDependencies = {
      codexHome,
      threadId: 'operator',
      activation: unsupported,
      connect: unsupported,
      git: unsupported,
      replyConnection: async () => ({
        close: async () => {},
        request: async (method, params) => {
          methods.push(method);
          if (method === 'thread/read')
            return {
              thread: {
                id: params.threadId,
                cwd: workspace,
                archived: params.threadId === 'native' && archived,
              },
            };
          if (method === 'thread/turns/list') return { data: [{ id: 'turn' }] };
          if (method === 'thread/items/list')
            return {
              data: [
                {
                  turnId: 'turn',
                  item: { id: 'input', type: 'userMessage', content: 'clean up native' },
                },
              ],
            };
          throw new Error('unexpected native method');
        },
      }),
      retirementNative: { worktreeUsers: unsupported, archiveOutcome: async () => outcome },
    };
    const run = async (input: unknown) =>
      (await runCodexDispatch(pluginData, 'retire', input, deps)) as Record<string, unknown>;
    const preview = await run({ native: 'native' });
    assert.equal(preview?.status, 'retire-available');
    const prepared = await run({ native: 'native', digest: preview?.digest });
    assert.equal(prepared?.status, 'retirement-prepared');
    assert.deepEqual(prepared?.request, { threadId: 'native', archived: true, hostId: 'local' });
    assert.equal((await run({ native: 'native' }))?.status, 'pending');
    outcome = 'denied';
    assert.equal((await run({ native: 'native' }))?.status, 'failed');
    archived = true;
    assert.equal((await run({ native: 'native' }))?.status, 'archived');
    assert.ok(
      methods.every((method) =>
        ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(method),
      ),
    );
    const current = await selectCodexIntake(pluginData, deps, { resolvePolicy: false });
    assert.equal(await current.store.read(), undefined);
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    assert.deepEqual((await journal.read()).records, []);
    await journal.exclusive(async (state, save) => {
      state.records.push({
        id: 'a'.repeat(64),
        issueKey: 'b'.repeat(64),
        sourceThreadId: 'operator',
        phase: 'routing',
        intakeId: 'c'.repeat(64),
        createdAt: 1,
        manifestDigest: 'manifest',
        threadId: 'native',
      });
      await save();
    });
    await assert.rejects(run({ native: 'native' }), /native-retirement-managed-owner-required/);
  });
});
