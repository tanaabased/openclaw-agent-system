import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WorkspaceGitignoreService from '../paths/workspace-gitignore-service.ts';

describe('paths/workspace-gitignore-service', () => {
  it('should append only missing entries and preserve the existing mode', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-system-gitignore-'));
    const path = join(workspaceDir, '.gitignore');
    await writeFile(path, 'dist/\n.agent-system/repositories/\n', { mode: 0o600 });
    const service = new WorkspaceGitignoreService();

    assert.equal(
      await service.reconcile(workspaceDir, {
        comment: '# Agent System managed Git workspaces.',
        entries: ['.agent-system/repositories/', '.agent-system/worktrees/'],
      }),
      true,
    );
    assert.equal(
      await service.reconcile(workspaceDir, {
        comment: '# Agent System managed Git workspaces.',
        entries: ['.agent-system/repositories/', '.agent-system/worktrees/'],
      }),
      false,
    );
    assert.equal(
      await readFile(path, 'utf8'),
      'dist/\n.agent-system/repositories/\n\n# Agent System managed Git workspaces.\n.agent-system/worktrees/\n',
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});
