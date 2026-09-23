import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import resolveAgentPaths from '../paths/resolve.ts';

describe('paths/resolve', () => {
  it('should order workspace, manifest, and agent system bins before the base path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-paths-'));
    const workspaceDir = join(root, 'workspace');
    const packageDir = join(root, 'package');
    await Promise.all([
      mkdir(join(workspaceDir, 'bin'), { recursive: true }),
      mkdir(join(workspaceDir, 'tools', 'bin'), { recursive: true }),
      mkdir(join(packageDir, 'bin'), { recursive: true }),
    ]);

    const result = await resolveAgentPaths(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: { pathPrepend: ['tools/bin'] },
      },
      {
        basePath: ['/usr/bin', join(workspaceDir, 'bin')].join(delimiter),
        packageDir,
        workspaceDir,
      },
    );

    assert.equal(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.deepEqual(
      result.projection.entries.map(({ source }) => source),
      ['workspace.bin', 'environment.path-prepend[0]', 'agent-system.bin'],
    );
    assert.deepEqual(result.projection.path.split(delimiter), [
      ...result.projection.entries.map(({ path }) => path),
      '/usr/bin',
    ]);
    assert.deepEqual(result.projection.baseline, ['/usr/bin']);
  });

  it('should remove exact duplicates without collapsing caller aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-paths-'));
    const workspaceDir = join(root, 'workspace');
    const packageDir = join(root, 'package');
    const versionedNode = join(root, 'Cellar', 'node', 'bin');
    const nodeAliasRoot = join(root, 'opt', 'node');
    const nodeAlias = join(nodeAliasRoot, 'bin');
    await Promise.all([
      mkdir(join(workspaceDir, 'bin'), { recursive: true }),
      mkdir(join(packageDir, 'bin'), { recursive: true }),
      mkdir(versionedNode, { recursive: true }),
      mkdir(join(root, 'opt'), { recursive: true }),
    ]);
    await symlink(join(root, 'Cellar', 'node'), nodeAliasRoot);

    const result = await resolveAgentPaths(
      { schemaVersion: 1, agent: { id: 'data' } },
      {
        basePath: [nodeAlias, versionedNode, nodeAlias].join(delimiter),
        packageDir,
        workspaceDir,
      },
    );

    assert.equal(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.deepEqual(result.projection.baseline, [nodeAlias, versionedNode]);
  });

  it('should reject missing and workspace escaping directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-paths-'));
    const workspaceDir = join(root, 'workspace');
    const packageDir = join(root, 'package');
    const outsideDir = join(root, 'outside');
    await Promise.all([
      mkdir(join(workspaceDir, 'bin'), { recursive: true }),
      mkdir(join(packageDir, 'bin'), { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
    ]);
    await symlink(outsideDir, join(workspaceDir, 'escape'));

    const result = await resolveAgentPaths(
      {
        schemaVersion: 1,
        agent: { id: 'data' },
        environment: { pathPrepend: ['missing', 'escape'] },
      },
      { basePath: '/usr/bin', packageDir, workspaceDir },
    );

    assert.equal(result.status, 'invalid');
    if (result.status !== 'invalid') return;
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['path-directory-unavailable', 'path-not-real-directory'],
    );
  });

  it('should reject an unusable base path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-paths-'));
    const workspaceDir = join(root, 'workspace');
    const packageDir = join(root, 'package');
    await Promise.all([
      mkdir(join(workspaceDir, 'bin'), { recursive: true }),
      mkdir(join(packageDir, 'bin'), { recursive: true }),
    ]);

    const result = await resolveAgentPaths(
      { schemaVersion: 1, agent: { id: 'data' } },
      { basePath: '', packageDir, workspaceDir },
    );

    assert.equal(result.status, 'invalid');
    if (result.status !== 'invalid') return;
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['path-base-invalid'],
    );
  });
});
