import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import WorkspaceBackupService from '../agent/backup-service.ts';
import type { AgentManifest } from '../manifest/types.ts';

const executeFile = promisify(execFile);
const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'tanaabot' },
  backup: { openclawState: 'off' },
};

describe('workspace backup stress', () => {
  let root: string;
  let workspace: string;
  let cleanupTimeout: number;
  const service = new WorkspaceBackupService();
  beforeEach(async () => {
    cleanupTimeout = 10_000;
    root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-backup-')));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'agent.yaml'), 'schema-version: 1\nagent: { id: tanaabot }\n');
    await writeFile(join(workspace, 'MEMORY.md'), 'private memory\n');
    await mkdir(join(workspace, 'memory'));
    await writeFile(join(workspace, 'memory', 'daily.md'), 'daily memory\n');
  });
  afterEach(async function () {
    this.timeout(cleanupTimeout);
    await rm(root, { recursive: true, force: true });
  });

  it('should prune large irrelevant trees and limit the final payload including parents', async function () {
    this.timeout(120_000);
    cleanupTimeout = 120_000;
    await executeFile('/usr/bin/git', ['init', workspace]);
    await writeFile(join(workspace, '.gitignore'), 'large/\n');
    await mkdir(join(workspace, 'large'));
    // keep each inode's link count bounded across supported filesystems.
    for (let batch = 0; batch < 100; batch++) {
      const source = join(workspace, 'large', `${batch}-0`);
      await writeFile(source, 'synthetic payload');
      await Promise.all(
        Array.from({ length: 999 }, (_, index) =>
          link(source, join(workspace, 'large', `${batch}-${index + 1}`)),
        ),
      );
    }
    assert.equal((await readdir(join(workspace, 'large'))).length, 100_000);
    const ignored = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { gitIgnore: true, include: ['{MEMORY,DREAMS,BOOTSTRAP}.md'] },
    });
    assert.ok(ignored.files.includes('MEMORY.md'));
    assert.ok(!ignored.files.some((path) => path.startsWith('large')));
    const excluded = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { include: ['large/**'], exclude: ['large/**'] },
    });
    assert.ok(excluded.files.length < 100);
    assert.ok(!excluded.files.some((path) => path.startsWith('large/')));
    await assert.rejects(
      service.plan({
        manifest,
        workspaceDir: workspace,
        overrides: {
          gitIgnore: true,
          include: ['large/*'],
          exclude: ['.git', '.gitignore', 'agent.yaml', 'MEMORY.md', 'memory'],
        },
      }),
      { code: 'backup-inventory-too-large' },
    );
  });
});
