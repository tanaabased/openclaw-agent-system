import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import CodexPathConfigService from '../paths/codex-config-service.ts';

const projection = {
  baseline: ['/usr/bin'],
  entries: [
    { path: '/workspace/bin', source: 'workspace.bin' as const },
    { path: '/package/bin', source: 'agent-system.bin' as const },
  ],
  path: '/workspace/bin:/package/bin:/usr/bin',
};

describe('paths/codex-config-service', () => {
  it('should create and visibly ignore a managed workspace configuration', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-codex-'));
    const service = new CodexPathConfigService();
    await writeFile(join(workspaceDir, '.gitignore'), 'dist/\n', { mode: 0o600 });

    const result = await service.reconcile(workspaceDir, projection);

    assert.deepEqual(result, {
      baseline: ['/usr/bin'],
      baselineAdded: ['/usr/bin'],
      baselineRemoved: [],
      gitignored: true,
      gitignoreUpdated: true,
      loginShellDisabled: true,
      managedPrefixesMatch: true,
      missingBaselineEntries: [],
      operation: 'append',
      ownership: 'managed',
      pathMatches: true,
      pathStatus: 'valid',
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
    assert.equal(result.loginShellDisabled, false);
    assert.equal(result.ownership, 'user');
    assert.equal(await readFile(join(workspaceDir, '.codex', 'config.toml'), 'utf8'), source);
    await assert.rejects(readFile(join(workspaceDir, '.gitignore'), 'utf8'));
  });

  it('should update a drifted managed configuration idempotently', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-codex-'));
    const service = new CodexPathConfigService();
    await service.reconcile(workspaceDir, {
      ...projection,
      baseline: ['/old/bin'],
      path: '/workspace/bin:/package/bin:/old/bin',
    });

    assert.equal((await service.reconcile(workspaceDir, projection)).status, 'updated');
    assert.equal((await service.reconcile(workspaceDir, projection)).status, 'unchanged');
  });

  it('should preserve saved baseline order and append unseen caller entries', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-codex-'));
    const service = new CodexPathConfigService();
    const first = {
      ...projection,
      baseline: ['/a', '/b', '/c'],
      path: '/workspace/bin:/package/bin:/a:/b:/c',
    };
    await service.reconcile(workspaceDir, first);
    const second = {
      ...projection,
      baseline: ['/c', '/a', '/d'],
      path: '/workspace/bin:/package/bin:/c:/a:/d',
    };

    const result = await service.reconcile(workspaceDir, second);
    const source = await readFile(join(workspaceDir, '.codex', 'config.toml'), 'utf8');

    assert.equal(result.status, 'updated');
    assert.deepEqual(result.baseline, ['/a', '/b', '/c', '/d']);
    assert.deepEqual(result.baselineAdded, ['/d']);
    assert.equal(source.includes(':/a:/b:/c:/d"'), true);
    assert.equal((await service.reconcile(workspaceDir, first)).status, 'unchanged');
    assert.equal((await service.reconcile(workspaceDir, second)).status, 'unchanged');
  });

  it('should remove prior managed prefixes without replacing the saved baseline', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-codex-'));
    const service = new CodexPathConfigService();
    await mkdir(join(workspaceDir, '.codex'));
    await writeFile(
      join(workspaceDir, '.codex', 'config.toml'),
      `# agent-system: managed-path-v1
allow_login_shell = false

[features]
shell_snapshot = true

[shell_environment_policy.set]
PATH = "/workspace/bin:/old/package/bin:/a:/b"
`,
    );

    const result = await service.reconcile(
      workspaceDir,
      {
        ...projection,
        baseline: ['/b', '/c'],
        path: '/workspace/bin:/package/bin:/b:/c',
      },
      { previousManagedPaths: ['/workspace/bin', '/old/package/bin'] },
    );

    assert.deepEqual(result.baseline, ['/a', '/b', '/c']);
    assert.deepEqual(result.baselineAdded, ['/c']);
    assert.equal(
      (await readFile(join(workspaceDir, '.codex', 'config.toml'), 'utf8')).includes(
        '/old/package/bin',
      ),
      false,
    );
  });

  it('should explicitly rebuild the baseline from the caller environment', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-codex-'));
    const service = new CodexPathConfigService();
    await service.reconcile(workspaceDir, {
      ...projection,
      baseline: ['/a', '/b'],
      path: '/workspace/bin:/package/bin:/a:/b',
    });

    const result = await service.reconcile(
      workspaceDir,
      {
        ...projection,
        baseline: ['/b', '/c'],
        path: '/workspace/bin:/package/bin:/b:/c',
      },
      { rebuildBaseline: true },
    );

    assert.equal(result.operation, 'rebuild');
    assert.deepEqual(result.baseline, ['/b', '/c']);
    assert.deepEqual(result.baselineAdded, ['/c']);
    assert.deepEqual(result.baselineRemoved, ['/a']);
  });

  it('should upgrade managed configuration that predates login-shell hardening', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-codex-'));
    await mkdir(join(workspaceDir, '.codex'));
    await writeFile(
      join(workspaceDir, '.codex', 'config.toml'),
      `# agent-system: managed-path-v1
# generated by openclaw agent-system install; manual edits will be replaced

[features]
shell_snapshot = true

[shell_environment_policy.set]
PATH = ${JSON.stringify(projection.path)}
`,
    );
    const service = new CodexPathConfigService();

    const result = await service.reconcile(workspaceDir, projection);

    assert.equal(result.status, 'updated');
    assert.equal(result.loginShellDisabled, true);
    assert.match(
      await readFile(join(workspaceDir, '.codex', 'config.toml'), 'utf8'),
      /^allow_login_shell = false$/mu,
    );
  });
});
