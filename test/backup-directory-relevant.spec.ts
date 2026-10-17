import assert from 'node:assert/strict';
import { dirname, matchesGlob } from 'node:path';

import backupDirectoryRelevant from '../agent/backup-directory-relevant.ts';

describe('agent/backup-directory-relevant', () => {
  it('should keep root brace alternatives from reaching unrelated directories', () => {
    const patterns = ['{MEMORY,DREAMS,BOOTSTRAP}.md', 'memory/**', '.private/**'];
    for (const directory of ['node_modules', '.agent-system/worktrees', 'other', 'memory/nested']) {
      assert.equal(backupDirectoryRelevant(directory, patterns), directory === 'memory/nested');
    }
    assert.equal(backupDirectoryRelevant('.private', patterns), true);
    assert.equal(backupDirectoryRelevant('MEMORY.md/nested', patterns), true);
  });

  it('should retain matching wildcard branches and recursive descendants', () => {
    for (const pattern of [
      '**/MEMORY.md',
      'node_*/pkg/MEMORY.md',
      '[np]ode_modules/pkg/MEMORY.md',
      '@(node_modules|memory)/pkg/MEMORY.md',
      'node_modules/{pkg,other}/MEMORY.md',
      'node_modules/**/**/MEMORY.md',
    ]) {
      assert.equal(backupDirectoryRelevant('node_modules', [pattern]), true, pattern);
      assert.equal(backupDirectoryRelevant('node_modules/pkg', [pattern]), true, pattern);
    }
    assert.equal(backupDirectoryRelevant('node_modules/other', ['node_*/pkg/MEMORY.md']), false);
    assert.equal(backupDirectoryRelevant('memory/deep', ['memory']), true);
    assert.equal(backupDirectoryRelevant('node_modules', []), false);
  });

  it('should conservatively retain syntax spanning separators or uncertain segments', () => {
    for (const pattern of [
      '{memory/daily,node_modules/pkg}/MEMORY.md',
      '!(memory/daily)/**',
      '***',
      '[unfinished',
    ])
      assert.equal(backupDirectoryRelevant('node_modules', [pattern]), true, pattern);
  });

  it('should never prune ancestors of supported matching payloads', () => {
    const paths = [
      'MEMORY.md',
      'memory/daily.md',
      'memory/nested/MEMORY.md',
      '.private/day.md',
      'node_modules/pkg/MEMORY.md',
      'notes/pkg/MEMORY.md',
    ];
    const patterns = [
      '{MEMORY,DREAMS,BOOTSTRAP}.md',
      'memory/**',
      '.private/**',
      '**/MEMORY.md',
      '*/pkg/MEMORY.md',
      '@(node_modules|notes)/**',
      '{memory/nested,node_modules/pkg}/MEMORY.md',
    ];
    for (const pattern of patterns) {
      for (const path of paths.filter((path) => matchesGlob(path, pattern))) {
        let parent = dirname(path);
        while (parent !== '.') {
          assert.equal(backupDirectoryRelevant(parent, [pattern]), true, `${pattern}: ${parent}`);
          parent = dirname(parent);
        }
      }
    }
  });
});
