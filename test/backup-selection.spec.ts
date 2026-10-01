import assert from 'node:assert/strict';

import { safeBackupLink } from '../agent/backup-archive.ts';
import { resolveBackupConfiguration, safeBackupRelativePath } from '../agent/backup-selection.ts';

describe('agent/backup-selection', () => {
  it('should resolve defaults and replace or clear manifest lists', () => {
    assert.deepEqual(resolveBackupConfiguration(), {
      output: '.agent-system/backups',
      gitIgnore: false,
      openclawState: 'auto',
      include: [],
      exclude: [],
    });
    assert.deepEqual(
      resolveBackupConfiguration(
        {
          output: 'private',
          gitIgnore: true,
          openclawState: 'required',
          include: ['MEMORY.md'],
          exclude: ['MEMORY.md'],
        },
        { gitIgnore: false, openclawState: 'off', include: [], exclude: ['memory/**'] },
      ),
      {
        output: 'private',
        gitIgnore: false,
        openclawState: 'off',
        include: [],
        exclude: ['memory/**'],
      },
    );
  });

  it('should reject unsafe inventory paths and escaping links', () => {
    for (const path of [
      '',
      '.',
      '../escape',
      'memory/../escape',
      '/absolute',
      'a//b',
      'a\\b',
      'a:b',
      'a\n',
    ])
      assert.equal(safeBackupRelativePath(path), false, path);
    for (const path of ['MEMORY.md', 'memory/day.md', '日本語/日記.md'])
      assert.equal(safeBackupRelativePath(path), true, path);
    assert.equal(safeBackupLink('memory/link', '../MEMORY.md'), true);
    for (const target of ['../../escape', '/absolute', 'a\\b', 'a\n'])
      assert.equal(safeBackupLink('memory/link', target), false, target);
  });
});
