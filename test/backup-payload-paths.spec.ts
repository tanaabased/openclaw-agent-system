import assert from 'node:assert/strict';

import backupPayloadPaths from '../agent/backup-payload-paths.ts';

describe('agent/backup-payload-paths', () => {
  it('should retain selected files and structural parents without inventing siblings', () => {
    assert.deepEqual(backupPayloadPaths(['memory/daily/note.md', 'MEMORY.md']), [
      'MEMORY.md',
      'memory',
      'memory/daily',
      'memory/daily/note.md',
    ]);
  });

  it('should accept the documented inventory limit including a deduplicated parent', () => {
    const files = Array.from({ length: 99_999 }, (_, index) => `memory/${index}`);
    files.push('memory');
    assert.equal(backupPayloadPaths(files).length, 100_000);
  });

  it('should reject the first entry beyond the documented inventory limit', () => {
    const files = Array.from({ length: 100_001 }, (_, index) => String(index));
    assert.throws(() => backupPayloadPaths(files), { code: 'backup-inventory-too-large' });
  });

  it('should count structural parents against the limit', () => {
    const files = Array.from({ length: 100_000 }, (_, index) => `memory/${index}`);
    assert.throws(() => backupPayloadPaths(files), { code: 'backup-inventory-too-large' });
  });
});
