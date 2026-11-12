import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selectCodexTaskContext } from '../agent/tasks/context/codex-task-context.ts';
import { selectOpenClawTaskContext } from '../agent/tasks/context/openclaw-task-context.ts';
import type { CodexWorkspaceBindingInspection } from '../agent/codex-workspace-binding.ts';
import NotificationResetStore from '../agent/notification-reset-state.ts';
import GitHubIdentityCache from '../channels/github/identity-cache.ts';
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
      const current = await select();
      assert.equal(current.workspace, workspace);
      assert.equal(await current.store.read(), undefined);
      const policy = 'policy' in current ? current.policy : current.selected;
      assert.equal(policy?.username, 'receiver');
      assert.equal(
        policy?.policy.issueAssignment?.mode,
        manifest.github?.notifications?.issueAssignment?.mode,
      );
      assert.deepEqual(await readdir(data), []);
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
      const cache = new GitHubIdentityCache(current.store.location);
      const contents = JSON.stringify({
        version: 1,
        entries: { [pin.nodeId]: { login: pin.login, nodeId: 'U_cached', type: 'User' } },
      });
      await cache.file.write(contents);
      await select();
      assert.equal(pin.nodeId, 'U_cached');
      assert.equal(await readFile(cache.path, 'utf8'), contents);
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
    const reset = new NotificationResetStore(data, current.store.location.scope);
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
    const before = await reset.file.read();
    await assert.rejects(codex(), { code: 'notification-reset-in-progress' });
    assert.equal(
      (await codex({ inspectionOnly: true })).store.location.scope,
      current.store.location.scope,
    );
    assert.equal(await reset.file.read(), before);
  });
});
