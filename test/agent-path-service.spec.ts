import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import AgentPathService from '../paths/service.ts';
import CodexPathConfigService from '../paths/codex-config-service.ts';
import type { StoredPathProjection } from '../paths/projection-store.ts';

describe('paths/service', () => {
  it('should reconcile both exec surfaces while preserving user path entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-service-'));
    const workspaceDir = join(root, 'workspace');
    const packageDir = join(root, 'package');
    await Promise.all([mkdir(workspaceDir), mkdir(join(packageDir, 'bin'), { recursive: true })]);
    const config: OpenClawConfig = {
      agents: {
        list: [
          {
            id: 'data',
            workspace: workspaceDir,
            tools: { exec: { pathPrepend: ['/user/bin'] } },
          },
        ],
      },
    };
    let stored: StoredPathProjection | undefined;
    const service = new AgentPathService({
      basePath: '/usr/bin',
      codexConfigService: new CodexPathConfigService(),
      async mutateConfigFile({ mutate }) {
        return { result: mutate(config) as boolean | undefined };
      },
      packageDir,
      projectionStore: {
        async read() {
          return stored;
        },
        async write(state) {
          stored = state;
        },
      },
      readConfig: () => config,
    });

    const result = await service.reconcile({
      manifest: { schemaVersion: 1, agent: { id: 'data' } },
      workspaceDir,
    });

    assert.deepEqual(result.actions, [
      'create-workspace-bin',
      'set-exec-path',
      'create-codex-config',
      'update-gitignore',
    ]);
    assert.deepEqual(config.agents?.list?.[0]?.tools?.exec?.pathPrepend, [
      ...result.projection.entries.map(({ path }) => path),
      '/user/bin',
    ]);
    assert.equal(
      (await readFile(join(workspaceDir, '.codex', 'config.toml'), 'utf8')).includes('/usr/bin'),
      true,
    );
    assert.deepEqual(
      (
        await service.inspect({
          manifest: { schemaVersion: 1, agent: { id: 'data' } },
          workspaceDir,
        })
      ).openClawMatches,
      true,
    );

    const repeated = await service.reconcile({
      manifest: { schemaVersion: 1, agent: { id: 'data' } },
      workspaceDir,
    });
    assert.deepEqual(repeated.actions, []);
  });

  it('should remove only the previously owned prefix when paths change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-path-service-'));
    const workspaceDir = join(root, 'workspace');
    const packageDir = join(root, 'package');
    await Promise.all([
      mkdir(join(workspaceDir, 'bin'), { recursive: true }),
      mkdir(join(packageDir, 'bin'), { recursive: true }),
    ]);
    const config: OpenClawConfig = {
      agents: {
        list: [
          {
            id: 'data',
            workspace: workspaceDir,
            tools: { exec: { pathPrepend: ['/old/package/bin', '/user/bin'] } },
          },
        ],
      },
    };
    const service = new AgentPathService({
      basePath: '/usr/bin',
      codexConfigService: new CodexPathConfigService(),
      async mutateConfigFile({ mutate }) {
        return { result: mutate(config) as boolean | undefined };
      },
      packageDir,
      projectionStore: {
        async read() {
          return {
            schemaVersion: 1,
            agentId: 'data',
            workspaceDir,
            openClawPaths: ['/old/package/bin'],
          };
        },
        async write() {},
      },
      readConfig: () => config,
    });

    const result = await service.reconcile({
      manifest: { schemaVersion: 1, agent: { id: 'data' } },
      workspaceDir,
    });

    assert.deepEqual(config.agents?.list?.[0]?.tools?.exec?.pathPrepend, [
      ...result.projection.entries.map(({ path }) => path),
      '/user/bin',
    ]);
  });
});
