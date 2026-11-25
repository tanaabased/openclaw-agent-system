import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import { selectOpenClawTaskContext } from '../agent/tasks/context/openclaw-task-context.ts';
import type { CodexWorkspaceBindingInspection } from '../agent/identity/codex-workspace-binding.ts';
import NotificationResetStore from '../agent/notification-reset-state.ts';
import sqliteAgentFixture from './sqlite-agent-fixture.ts';
import codexStorageLocation from '../agent/storage/codex-storage.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('task context selection', () => {
  let root: string, workspace: string, home: string, data: string;
  let manifest: AgentManifest, inspection: CodexWorkspaceBindingInspection;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'task-context-')));
    workspace = join(root, 'workspace');
    home = join(root, 'home');
    data = join(root, 'data');
    await Promise.all([workspace, home, data].map((path) => mkdir(path, { mode: 0o700 })));
    manifest = {
      schemaVersion: 1,
      agent: { id: 'receiver' },
      github: {
        username: 'receiver',
        notifications: {
          ...structuredClone(intakeFixture().policy),
          runtimes: ['codex', 'openclaw'],
        },
      },
    };
    inspection = {
      status: 'bound',
      path: join(data, 'workspace-binding.json'),
      binding: { schemaVersion: 1, workspaceDir: workspace },
      preview: {
        status: 'ready',
        workspaceDir: workspace,
        manifest: {
          status: 'loaded',
          scope: { workspaceDir: workspace },
          path: join(workspace, 'agent.yaml'),
          manifest,
          digest: 'manifest',
          diagnostics: [],
          validationChecks: [],
        },
      },
    };
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  const codex = (options = {}) =>
    selectCodexTaskContext(
      data,
      { codexHome: home, inspectBinding: async () => inspection },
      options,
    );
  const openclaw = (options = {}) =>
    selectOpenClawTaskContext(
      {
        sqliteInstallation: codexStorageLocation(data),
        root: data,
        namespace: home,
        manifestService: {
          loadForAgentId: async () => {
            throw new Error('selection must use the supplied native manifest');
          },
        },
      },
      manifest,
      workspace,
      options,
    );

  for (const [runtime, select] of [
    ['codex', codex],
    ['openclaw', openclaw],
  ] as const) {
    it(`should select ${runtime} task context without an intake enrollment or scheduler`, async () => {
      await sqliteAgentFixture(data, 'receiver');
      const files = await readdir(data);
      const current = await select();
      assert.equal(current.workspace, workspace);
      assert.equal(await current.store.read(), undefined);
      const policy = 'policy' in current ? current.policy : current.selected;
      assert.equal(policy?.username, 'receiver');
      assert.equal(
        policy?.policy.issueAssignment?.mode,
        manifest.github?.notifications?.issueAssignment?.mode,
      );
      assert.deepEqual(await readdir(data), files);
    });

    it(`should allow ${runtime} explicit task selection without assignment policy`, async () => {
      delete manifest.github;
      const current = await select({ resolvePolicy: false });
      assert.equal(current.workspace, workspace);
      assert.equal('policy' in current ? current.policy : current.selected, undefined);
      assert.deepEqual(await readdir(data), []);
    });

    it(`should hydrate ${runtime} identity pins from the existing scope without rewriting them`, async () => {
      const current = await select();
      const pin = manifest.github!.notifications!.issueAssignment!.allowed[0]!;
      const { agent } = await sqliteAgentFixture(data, 'receiver');
      const scope = current.store.location.scope;
      const value = { login: pin.login, nodeId: 'U_cached', type: 'User' as const };
      await agent.retainIdentityPin({ scope, id: pin.nodeId, value }, () => {});
      const before = await current.store.identities.read();
      await select();
      assert.equal(pin.nodeId, 'U_cached');
      assert.deepEqual(await current.store.identities.read(), before);
    });
  }

  it('should preserve separate runtime and host storage scopes', async () => {
    const first = await codex();
    const native = await openclaw();
    const second = await selectCodexTaskContext(data, {
      codexHome: join(root, 'another-home'),
      inspectBinding: async () => inspection,
    });
    assert.notEqual(first.store.location.scope, native.store.location.scope);
    assert.notEqual(first.store.location.scope, second.store.location.scope);
  });

  it('should reject a missing binding or unavailable manifest before selecting codex task state', async () => {
    inspection = { status: 'unbound', path: join(data, 'workspace-binding.json') };
    await assert.rejects(codex(), { code: 'intake-binding-unavailable' });
    inspection = {
      status: 'bound',
      path: join(data, 'workspace-binding.json'),
      binding: { schemaVersion: 1, workspaceDir: workspace },
      preview: {
        status: 'ready',
        workspaceDir: workspace,
        manifest: { status: 'unmanaged', scope: { workspaceDir: workspace }, diagnostics: [] },
      },
    };
    await assert.rejects(codex(), { code: 'intake-manifest-unavailable' });
    assert.deepEqual(await readdir(data), []);
  });

  it('should preserve the codex reset barrier and explicit inspection recovery', async () => {
    const current = await codex();
    const { agent } = await sqliteAgentFixture(data, 'receiver');
    const reset = new NotificationResetStore(current.store.location.scope, agent);
    await reset.exclusive(async (_previous, save) => {
      await save({
        version: 1,
        id: 'reset',
        runtime: 'codex',
        agentId: manifest.agent.id,
        workspace,
        scope: current.store.location.scope,
        purge: false,
        createdAt: 1,
        phase: 'pause',
        automation: '{}',
        inventory: '{}',
        resources: [],
      });
    });
    const before = await reset.read();
    await assert.rejects(codex(), { code: 'notification-reset-in-progress' });
    assert.equal(
      (await codex({ inspectionOnly: true })).store.location.scope,
      current.store.location.scope,
    );
    assert.deepEqual(await reset.read(), before);
  });
});
