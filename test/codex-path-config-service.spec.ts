import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import CodexPathConfigService from '../lib/codex-path-config-service.ts';

const projection = {
  entries: [
    { path: '/workspace/bin', source: 'workspace.bin' as const },
    { path: '/package/bin', source: 'agent-system.bin' as const },
  ],
  path: '/workspace/bin:/package/bin:/usr/bin',
};

describe('lib/codex-path-config-service', () => {
  it('should create and visibly ignore a managed workspace configuration', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-codex-'));
    const service = new CodexPathConfigService();
    await writeFile(join(workspaceDir, '.gitignore'), 'dist/\n', { mode: 0o600 });

    const result = await service.reconcile(workspaceDir, projection);

    assert.deepEqual(result, {
      gitignored: true,
      gitignoreUpdated: true,
      ownership: 'managed',
      pathMatches: true,
      status: 'created',
    });
    assert.equal(
      (await readFile(join(workspaceDir, '.gitignore'), 'utf8')).includes(
        'dist/\n\n# Agent System local Codex configuration.\n.codex/config.toml',
      ),
      true,
    );
    assert.equal((await stat(join(workspaceDir, '.gitignore'))).mode & 0o777, 0o600);
    assert.equal(
      (await readFile(join(workspaceDir, '.codex', 'config.toml'), 'utf8')).includes(
        '# agent-system: managed-path-v1',
      ),
      true,
    );
  });

  it('should leave an existing user-managed configuration untouched', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-codex-'));
    await mkdir(join(workspaceDir, '.codex'));
    const source = '[features]\nshell_snapshot = false\n';
    await writeFile(join(workspaceDir, '.codex', 'config.toml'), source);
    const service = new CodexPathConfigService();

    const result = await service.reconcile(workspaceDir, projection);

    assert.equal(result.status, 'manual');
    assert.equal(result.ownership, 'user');
    assert.equal(await readFile(join(workspaceDir, '.codex', 'config.toml'), 'utf8'), source);
    await assert.rejects(readFile(join(workspaceDir, '.gitignore'), 'utf8'));
  });

  it('should update a drifted managed configuration idempotently', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-codex-'));
    const service = new CodexPathConfigService();
    await service.reconcile(workspaceDir, {
      ...projection,
      path: '/old/bin:/usr/bin',
    });

    assert.equal((await service.reconcile(workspaceDir, projection)).status, 'updated');
    assert.equal((await service.reconcile(workspaceDir, projection)).status, 'unchanged');
  });
});
